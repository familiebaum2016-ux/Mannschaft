"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.database();

const REGION = "europe-west1";
const ROOM_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REQUEST_LIMIT = 500;
const SEARCH_LIMIT = 3000;

setGlobalOptions({ region: REGION, maxInstances: 5, memory: "256MiB", timeoutSeconds: 60 });

function requireAuth(request) {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Bitte die Seite neu laden.");
  return request.auth.uid;
}

function validRoomId(value) {
  return typeof value === "string" && /^[A-HJ-NP-Z2-9]{6}$/.test(value);
}

function cleanText(value, max = 120) {
  return String(value || "").trim().slice(0, max);
}

async function getActiveRoom(roomId) {
  if (!validRoomId(roomId)) throw new HttpsError("invalid-argument", "Ungültiger Partyraum.");
  const snapshot = await db.ref(`rooms/${roomId}/meta`).get();
  if (!snapshot.exists()) throw new HttpsError("not-found", "Partyraum nicht gefunden.");
  const meta = snapshot.val();
  const expired = !meta.expiresAt || meta.expiresAt < Date.now() || meta.createdAt < Date.now() - ROOM_LIFETIME_MS;
  if (!meta.active || expired) {
    if (meta.active && expired) await snapshot.ref.update({ active: false, expiredAt: Date.now() });
    throw new HttpsError("failed-precondition", "Dieser Partyraum ist abgelaufen.");
  }
  return meta;
}

async function getServerRoom(roomId) {
  const snapshot = await db.ref(`serverRooms/${roomId}`).get();
  if (!snapshot.exists()) throw new HttpsError("failed-precondition", "Partyraum ist noch nicht mit Spotify verbunden.");
  return snapshot.val();
}

async function getAccessToken(roomId) {
  const room = await getServerRoom(roomId);
  if (room.accessToken && room.expiresAt > Date.now() + 60_000) return room.accessToken;
  if (!room.refreshToken || !room.spotifyClientId) throw new HttpsError("unauthenticated", "Spotify muss vom Gastgeber neu verbunden werden.");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: room.refreshToken,
    client_id: room.spotifyClientId
  });
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new HttpsError("unauthenticated", "Spotify-Verbindung ist abgelaufen. Gastgeber muss einen neuen Raum erstellen.");
  const token = await response.json();
  const update = {
    accessToken: token.access_token,
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000
  };
  if (token.refresh_token) update.refreshToken = token.refresh_token;
  await db.ref(`serverRooms/${roomId}`).update(update);
  return token.access_token;
}

async function spotifyApi(roomId, path, options = {}, retry = true) {
  const accessToken = await getAccessToken(roomId);
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` };
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(`https://api.spotify.com/v1${path}`, { ...options, headers });
  if (response.status === 401 && retry) {
    await db.ref(`serverRooms/${roomId}/expiresAt`).set(0);
    return spotifyApi(roomId, path, options, false);
  }
  if (!response.ok) {
    let message = `Spotify-Fehler ${response.status}`;
    try { message = (await response.json())?.error?.message || message; } catch {}
    throw new HttpsError(response.status === 429 ? "resource-exhausted" : "internal", message);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function takeCounter(roomId, name, limit) {
  const counterRef = db.ref(`serverRooms/${roomId}/${name}`);
  const result = await counterRef.transaction(current => {
    const value = Number(current || 0);
    return value >= limit ? undefined : value + 1;
  });
  if (!result.committed) throw new HttpsError("resource-exhausted", name === "requestCount" ? `Das Raumlimit von ${limit} Musikwünschen ist erreicht.` : "Das Suchlimit dieses Partyraums ist erreicht.");
  const count = Number(result.snapshot.val());
  await db.ref(`rooms/${roomId}/stats/${name}`).set(count);
  return count;
}

function compactTrack(track) {
  return {
    id: cleanText(track.id, 40),
    uri: cleanText(track.uri, 80),
    name: cleanText(track.name, 160),
    artist: cleanText((track.artists || []).map(artist => artist.name).join(", "), 180),
    album: cleanText(track.album?.name, 160),
    image: cleanText(track.album?.images?.at(-1)?.url || track.album?.images?.[0]?.url, 500),
    durationMs: Number(track.duration_ms || 0)
  };
}

exports.registerRoom = onCall({ region: REGION, maxInstances: 2 }, async request => {
  const uid = requireAuth(request);
  const roomId = request.data?.roomId;
  const playlistId = cleanText(request.data?.playlistId, 80);
  const spotifyClientId = cleanText(request.data?.spotifyClientId, 100);
  const token = request.data?.spotifyToken || {};
  if (!validRoomId(roomId) || !/^[A-Za-z0-9]{10,80}$/.test(playlistId)) throw new HttpsError("invalid-argument", "Raum oder Playlist ist ungültig.");
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(spotifyClientId)) throw new HttpsError("invalid-argument", "Spotify Client ID ist ungültig.");
  if (typeof token.accessToken !== "string" || typeof token.refreshToken !== "string" || token.accessToken.length > 4096 || token.refreshToken.length > 4096) {
    throw new HttpsError("unauthenticated", "Spotify muss erneut verbunden werden.");
  }
  const metaSnapshot = await db.ref(`rooms/${roomId}/meta`).get();
  if (!metaSnapshot.exists() || metaSnapshot.val().hostUid !== uid || metaSnapshot.val().playlistId !== playlistId) {
    throw new HttpsError("permission-denied", "Nur der Gastgeber darf diesen Raum aktivieren.");
  }
  await db.ref(`serverRooms/${roomId}`).set({
    hostUid: uid,
    playlistId,
    spotifyClientId,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: Number(token.expiresAt || Date.now() + 3_000_000),
    roomExpiresAt: Number(metaSnapshot.val().expiresAt),
    requestCount: 0,
    searchCount: 0,
    createdAt: Date.now()
  });
  await db.ref(`rooms/${roomId}/stats`).set({ requestCount: 0, searchCount: 0 });
  return { ok: true, expiresAt: metaSnapshot.val().expiresAt, requestLimit: REQUEST_LIMIT };
});

exports.searchTracks = onCall({ region: REGION, maxInstances: 5, timeoutSeconds: 30 }, async request => {
  requireAuth(request);
  const roomId = request.data?.roomId;
  const query = cleanText(request.data?.query, 80);
  if (query.length < 2) throw new HttpsError("invalid-argument", "Bitte mindestens zwei Zeichen eingeben.");
  await getActiveRoom(roomId);
  await takeCounter(roomId, "searchCount", SEARCH_LIMIT);
  const result = await spotifyApi(roomId, `/search?type=track&limit=10&q=${encodeURIComponent(query)}`);
  return { results: (result.tracks?.items || []).filter(Boolean).map(compactTrack) };
});

async function findPlaylistPosition(roomId, playlistId, trackId) {
  if (!trackId) return null;
  let offset = 0;
  while (offset < 1000) {
    const page = await spotifyApi(roomId, `/playlists/${encodeURIComponent(playlistId)}/items?limit=50&offset=${offset}`);
    const items = page.items || [];
    const index = items.findIndex(entry => (entry.item || entry.track)?.id === trackId);
    if (index >= 0) return offset + index + 1;
    if (!page.next || !items.length) break;
    offset += items.length;
  }
  return null;
}

function validateRequestedTrack(value) {
  const track = {
    id: cleanText(value?.id, 40),
    uri: cleanText(value?.uri, 80),
    name: cleanText(value?.name, 160),
    artist: cleanText(value?.artist, 180),
    album: cleanText(value?.album, 160),
    image: cleanText(value?.image, 500)
  };
  if (!/^spotify:track:[A-Za-z0-9]+$/.test(track.uri) || !track.name || !track.artist) throw new HttpsError("invalid-argument", "Dieser Song ist ungültig.");
  return track;
}

exports.requestTrack = onCall({ region: REGION, maxInstances: 1, concurrency: 1, timeoutSeconds: 60 }, async request => {
  requireAuth(request);
  const roomId = request.data?.roomId;
  const track = validateRequestedTrack(request.data?.track);
  const meta = await getActiveRoom(roomId);
  const serverRoom = await getServerRoom(roomId);
  const requestCount = await takeCounter(roomId, "requestCount", REQUEST_LIMIT);
  const playback = await spotifyApi(roomId, "/me/player/currently-playing");
  const currentId = playback?.item?.id || null;
  const activePlaylistId = playback?.context?.type === "playlist" ? playback.context.uri?.split(":").at(-1) : null;
  let position = null;
  let insertion = serverRoom.insertion || null;
  if (activePlaylistId === meta.playlistId && currentId) {
    if (insertion?.currentTrackId === currentId && insertion?.playlistId === meta.playlistId) {
      position = Number(insertion.basePosition) + Number(insertion.insertedCount || 0);
    } else {
      position = await findPlaylistPosition(roomId, meta.playlistId, currentId);
      insertion = position === null ? null : { currentTrackId: currentId, playlistId: meta.playlistId, basePosition: position, insertedCount: 0 };
    }
  }
  const body = { uris: [track.uri] };
  if (position !== null) body.position = position;
  await spotifyApi(roomId, `/playlists/${encodeURIComponent(meta.playlistId)}/items`, { method: "POST", body: JSON.stringify(body) });
  if (insertion && position !== null) {
    insertion.insertedCount = Number(insertion.insertedCount || 0) + 1;
    await db.ref(`serverRooms/${roomId}/insertion`).set(insertion);
  } else {
    await db.ref(`serverRooms/${roomId}/insertion`).remove();
  }
  let queued = false;
  try {
    await spotifyApi(roomId, `/me/player/queue?uri=${encodeURIComponent(track.uri)}`, { method: "POST" });
    queued = true;
  } catch {}
  await db.ref(`rooms/${roomId}/stats/lastTrack`).set({ name: track.name, artist: track.artist, queued, at: Date.now() });
  return { ok: true, status: queued ? "queued" : "playlist_only", requestCount, requestLimit: REQUEST_LIMIT };
});

exports.closeRoomBackend = onCall({ region: REGION, maxInstances: 2 }, async request => {
  const uid = requireAuth(request);
  const roomId = request.data?.roomId;
  if (!validRoomId(roomId)) throw new HttpsError("invalid-argument", "Ungültiger Partyraum.");
  const metaRef = db.ref(`rooms/${roomId}/meta`);
  const snapshot = await metaRef.get();
  if (!snapshot.exists() || snapshot.val().hostUid !== uid) throw new HttpsError("permission-denied", "Nur der Gastgeber darf den Raum schließen.");
  await Promise.all([
    db.ref(`serverRooms/${roomId}`).remove(),
    metaRef.update({ active: false, closedAt: Date.now() })
  ]);
  return { ok: true };
});

exports.cleanupExpiredRooms = onSchedule({ region: REGION, schedule: "every 60 minutes", timeZone: "Etc/UTC", maxInstances: 1 }, async () => {
  const snapshot = await db.ref("serverRooms").get();
  if (!snapshot.exists()) return;
  const now = Date.now();
  const updates = {};
  snapshot.forEach(child => {
    if (Number(child.val()?.roomExpiresAt || 0) <= now) {
      updates[`serverRooms/${child.key}`] = null;
      updates[`rooms/${child.key}/meta/active`] = false;
      updates[`rooms/${child.key}/meta/expiredAt`] = now;
    }
  });
  if (Object.keys(updates).length) await db.ref().update(updates);
});
