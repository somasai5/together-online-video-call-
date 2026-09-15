/**
 * Hotstar Watch Party — Signaling Server
 *
 * Handles:
 *  - Room creation (6-char code), max 2 participants
 *  - Host tracking + server-side host validation for sync events
 *  - Host handoff on disconnect
 *  - 60s reconnect grace window (preserves role)
 *  - 5-minute room TTL after all participants leave
 *  - Rate limiting: 10 join attempts per IP per minute
 *  - Event relay: sync, chat, emoji, offer, answer, ice-candidate
 *  - Per-message try/catch so one bad payload can't crash the server
 */

'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');
const http = require('http');

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;

/** Grace window (ms) before a disconnected participant's slot is freed */
const RECONNECT_GRACE_MS = 60_000;

/** Room TTL (ms) after the last participant disconnects */
const ROOM_TTL_MS = 5 * 60 * 1000;

/** Rate-limit: max join attempts per IP within the window */
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Allowed relay event types (everything else is dropped) */
const RELAY_EVENTS = new Set([
  'chat',
  'emoji',
  'offer',
  'answer',
  'ice-candidate',
  'call-ended',
  'state-request',
  'state-snapshot',
  'movie-change',
  'ad-start',
  'ad-end',
  'clock-ping',
  'clock-pong',
]);

// ─── In-memory state ─────────────────────────────────────────────────────────

/**
 * rooms: Map<roomCode, Room>
 *
 * Room = {
 *   code: string,
 *   hostId: string | null,
 *   participants: Map<participantId, Participant>,
 *   createdAt: number,
 *   cleanupTimer: NodeJS.Timeout | null,
 * }
 *
 * Participant = {
 *   id: string,
 *   ws: WebSocket | null,        // null while in grace window
 *   graceTimer: NodeJS.Timeout | null,
 *   joinedAt: number,
 * }
 */
const rooms = new Map();

/**
 * rateLimitMap: Map<ip, { count: number, windowStart: number }>
 */
const rateLimitMap = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // unambiguous chars
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

function log(level, ...args) {
  const ts = new Date().toISOString();
  console[level](`[${ts}]`, ...args);
}

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/** Returns the other participant in the room (if any) */
function getPeer(room, myId) {
  for (const [id, p] of room.participants) {
    if (id !== myId) return p;
  }
  return null;
}

/** Cancel and remove the room cleanup timer */
function cancelRoomCleanup(room) {
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }
}

/** Schedule room deletion after TTL */
function scheduleRoomCleanup(room) {
  cancelRoomCleanup(room);
  room.cleanupTimer = setTimeout(() => {
    log('info', `[ROOM] TTL expired, deleting room ${room.code}`);
    rooms.delete(room.code);
  }, ROOM_TTL_MS);
}

/** Check whether at least one participant has a live WebSocket */
function hasLiveParticipant(room) {
  for (const p of room.participants.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

function isRateLimited(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return false;
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return true;
  return false;
}

// Periodically clean up stale rate-limit entries to prevent memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW_MS);

// ─── Message handler ──────────────────────────────────────────────────────────

function handleMessage(ws, rawData, participantId) {
  let msg;
  try {
    msg = JSON.parse(rawData.toString());
  } catch {
    log('warn', `[MSG] Malformed JSON from ${participantId}, dropping`);
    return;
  }

  const { type } = msg;
  if (!type || typeof type !== 'string') {
    log('warn', `[MSG] Missing or invalid type from ${participantId}, dropping`);
    return;
  }

  // Find which room this participant is in
  let room = null;
  for (const r of rooms.values()) {
    if (r.participants.has(participantId)) {
      room = r;
      break;
    }
  }

  if (!room) {
    log('warn', `[MSG] Message from unknown participant ${participantId}`);
    return;
  }

  // ── sync: server-side host validation ────────────────────────────────────
  if (type === 'sync') {
    if (room.hostId !== participantId) {
      log('warn', `[SYNC] Dropping sync from non-host ${participantId} in room ${room.code}`);
      return;
    }
    const peer = getPeer(room, participantId);
    if (peer && peer.ws) {
      send(peer.ws, { type: 'sync', ...msg });
    }
    return;
  }

  // ── drift-heartbeat: server-side host validation ──────────────────────────
  if (type === 'drift-heartbeat') {
    if (room.hostId !== participantId) return;
    const peer = getPeer(room, participantId);
    if (peer && peer.ws) {
      send(peer.ws, { type: 'drift-heartbeat', ...msg });
    }
    return;
  }

  // ── relayed events ────────────────────────────────────────────────────────
  if (RELAY_EVENTS.has(type)) {
    const peer = getPeer(room, participantId);
    if (peer && peer.ws) {
      send(peer.ws, { type, ...msg, from: participantId });
    }
    return;
  }

  // ── ping: keepalive from client, no relay needed ─────────────────────────
  if (type === 'ping') return;

  log('warn', `[MSG] Unknown event type "${type}" from ${participantId}, dropping`);
}

function handleLeave(ws, participantId) {
  if (!participantId) return;

  let room = null;
  for (const r of rooms.values()) {
    if (r.participants.has(participantId)) {
      room = r;
      break;
    }
  }
  if (!room) return;

  log('info', `[LEAVE] Participant ${participantId} explicitly left room ${room.code}`);

  const participant = room.participants.get(participantId);
  if (participant && participant.graceTimer) {
    clearTimeout(participant.graceTimer);
  }
  room.participants.delete(participantId);

  const peer = getPeer(room, participantId);
  if (peer && peer.ws) {
    if (room.hostId === participantId) {
      // Host left the room — close the room for the guest so they are kicked out to lobby too
      send(peer.ws, { type: 'left-room', reason: 'Host has left the room.' });
      if (peer.graceTimer) clearTimeout(peer.graceTimer);
      room.participants.delete(peer.id);
      log('info', `[HOST-LEFT] Host left room ${room.code}, closing room for guest ${peer.id}`);
    } else {
      send(peer.ws, { type: 'peer-disconnected', participantId });
    }
  }

  if (room.participants.size === 0) {
    scheduleRoomCleanup(room);
  }

  send(ws, { type: 'left-room' });
}

// ─── Connection handler ───────────────────────────────────────────────────────

function handleConnection(ws, req) {
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown';

  log('info', `[CONNECT] New connection from ${ip}`);

  let participantId = null; // assigned after join

  ws.on('message', (rawData) => {
    try {
      let msg;
      try {
        msg = JSON.parse(rawData.toString());
      } catch {
        send(ws, { type: 'error', message: 'Invalid JSON' });
        return;
      }

      // Ping keepalive
      if (msg.type === 'ping') return;

      // Explicit leave: clears room slot and resets participantId so socket can create/join again
      if (msg.type === 'leave') {
        if (participantId) {
          handleLeave(ws, participantId);
          participantId = null;
        }
        return;
      }

      // ── Pre-join: only accept join / create ─────────────────────────────
      if (!participantId) {

        if (msg.type === 'create') {
          const code = generateRoomCode();
          const id = uuidv4();
          participantId = id;

          const participant = { id, ws, graceTimer: null, joinedAt: Date.now() };
          const room = {
            code,
            hostId: id,
            participants: new Map([[id, participant]]),
            createdAt: Date.now(),
            cleanupTimer: null,
          };
          rooms.set(code, room);

          send(ws, { type: 'room-created', roomCode: code, participantId: id, isHost: true });
          log('info', `[ROOM] Created room ${code}, host=${id}`);
          return;
        }

        if (msg.type === 'join') {
          if (isRateLimited(ip)) {
            send(ws, { type: 'error', message: 'Rate limit exceeded. Try again in a minute.' });
            log('warn', `[RATE-LIMIT] IP ${ip} exceeded join rate limit`);
            ws.close();
            return;
          }

          const code = (msg.roomCode || '').trim().toUpperCase();
          const room = rooms.get(code);

          if (!room) {
            send(ws, { type: 'error', message: 'Room not found.' });
            return;
          }

          // ── Reconnect: check if this client had a slot in grace window ──
          const claimedId = msg.participantId;
          if (claimedId && room.participants.has(claimedId)) {
            const existing = room.participants.get(claimedId);
            if (existing.ws === null) {
              // Still in grace window — restore connection
              if (existing.graceTimer) {
                clearTimeout(existing.graceTimer);
                existing.graceTimer = null;
              }
              existing.ws = ws;
              participantId = claimedId;
              cancelRoomCleanup(room);

              send(ws, {
                type: 'reconnected',
                participantId: claimedId,
                isHost: room.hostId === claimedId,
                roomCode: code,
              });

              // Tell client to request fresh state from host
              send(ws, { type: 'request-state' });

              // If there's a live peer, tell them too
              const peer = getPeer(room, claimedId);
              if (peer && peer.ws) {
                send(peer.ws, { type: 'peer-reconnected', participantId: claimedId });
                // Ask host for state snapshot to send to reconnected guest
                if (room.hostId !== claimedId) {
                  send(peer.ws, { type: 'send-state-snapshot' });
                }
              }

              log('info', `[RECONNECT] Participant ${claimedId} reconnected to room ${code}`);
              return;
            }
          }

          // ── New join ─────────────────────────────────────────────────────
          if (room.participants.size >= 2) {
            send(ws, { type: 'error', message: 'Room is full.' });
            log('info', `[ROOM-FULL] Rejected join attempt for room ${code} from ${ip}`);
            return;
          }

          const id = uuidv4();
          participantId = id;

          const participant = { id, ws, graceTimer: null, joinedAt: Date.now() };
          room.participants.set(id, participant);
          cancelRoomCleanup(room);

          const isHost = room.hostId === id;
          send(ws, {
            type: 'joined',
            participantId: id,
            isHost,
            roomCode: code,
          });

          // Notify existing peer
          const peer = getPeer(room, id);
          if (peer && peer.ws) {
            send(peer.ws, { type: 'peer-joined', participantId: id });
            // Also tell the new joiner that their peer is already here
            send(ws, { type: 'peer-joined', participantId: peer.id });
            // Ask host to send state snapshot for new guest
            const hostParticipant = room.participants.get(room.hostId);
            if (hostParticipant && hostParticipant.ws) {
              send(hostParticipant.ws, { type: 'send-state-snapshot' });
            }
          }

          log('info', `[JOIN] Participant ${id} joined room ${code} (${room.participants.size}/2 participants)`);
          return;
        }

        send(ws, { type: 'error', message: 'Send join or create first.' });
        return;
      }

      // ── Post-join message handling ──────────────────────────────────────
      handleMessage(ws, rawData, participantId);
    } catch (err) {
      log('error', `[ERROR] Unhandled error in message handler for ${participantId || ip}:`, err);
    }
  });

  ws.on('close', () => {
    log('info', `[DISCONNECT] ${participantId || ip} disconnected`);

    if (!participantId) return;

    // Find the room
    let room = null;
    for (const r of rooms.values()) {
      if (r.participants.has(participantId)) {
        room = r;
        break;
      }
    }
    if (!room) return;

    const participant = room.participants.get(participantId);
    if (!participant) return;

    // Null out the socket (grace window starts)
    participant.ws = null;

    // Notify peer of disconnect
    const peer = getPeer(room, participantId);
    if (peer && peer.ws) {
      send(peer.ws, { type: 'peer-disconnected', participantId });
    }

    // Start grace timer — if they don't reconnect, remove their slot
    participant.graceTimer = setTimeout(() => {
      const wasHost = room.hostId === participantId;
      room.participants.delete(participantId);
      log('info', `[GRACE-EXPIRED] Participant ${participantId} removed from room ${room.code}`);

      if (wasHost) {
        // Host did not reconnect within grace window — close the room for the guest as well
        const remainingPeer = getPeer(room, participantId);
        if (remainingPeer && remainingPeer.ws) {
          send(remainingPeer.ws, { type: 'left-room', reason: 'Host disconnected.' });
          if (remainingPeer.graceTimer) clearTimeout(remainingPeer.graceTimer);
          room.participants.delete(remainingPeer.id);
          log('info', `[ROOM-CLOSED] Host disconnected permanently, closing room ${room.code} for guest`);
        }
      }

      if (room.participants.size === 0) {
        scheduleRoomCleanup(room);
      }
    }, RECONNECT_GRACE_MS);

    // If no live participants remain, schedule room TTL
    if (!hasLiveParticipant(room)) {
      scheduleRoomCleanup(room);
    }
  });

  ws.on('error', (err) => {
    log('error', `[WS-ERROR] ${participantId || ip}:`, err.message);
  });
}

// ─── HTTP health check ────────────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', handleConnection);

httpServer.listen(PORT, () => {
  log('info', `[SERVER] Signaling server listening on port ${PORT}`);
  log('info', `[SERVER] Health check: http://localhost:${PORT}/health`);
});

// ─── Exports (for testing) ────────────────────────────────────────────────────
module.exports = { rooms, rateLimitMap, generateRoomCode, isRateLimited };
