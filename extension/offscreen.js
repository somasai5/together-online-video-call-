/**
 * offscreen.js — Offscreen Document
 *
 * This document lives for the extension's lifetime (not subject to SW idle-kill)
 * and owns the single WebSocket connection to the signaling server.
 *
 * Message routing:
 *   background → offscreen : send WS messages, connect/disconnect commands
 *   offscreen → background : forward incoming WS messages, connection status
 */

'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────
// Replace with your deployed wss:// URL before testing against real Hotstar.
// For local dev: run `mkcert localhost` and serve with TLS so you get wss://localhost.
const SIGNALING_SERVER_URL = 'wss://together-online-video-call.onrender.com';

// ─── State ────────────────────────────────────────────────────────────────────

let ws = null;
let reconnectTimer = null;
let isIntentionalClose = false;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30_000;

// Pending messages queued while WS is connecting
const sendQueue = [];

// Ping interval to keep Render's load balancer from killing idle connections
let pingInterval = null;
const PING_INTERVAL_MS = 25_000;

// ─── WebSocket management ─────────────────────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  isIntentionalClose = false;
  ws = new WebSocket(SIGNALING_SERVER_URL);

  ws.addEventListener('open', () => {
    console.log('[Offscreen] WebSocket connected');
    reconnectDelay = 1000;
    clearTimeout(reconnectTimer);

    // Flush queued messages
    while (sendQueue.length > 0) {
      const msg = sendQueue.shift();
      ws.send(JSON.stringify(msg));
    }

    // Keep-alive ping — prevents Render's LB from closing idle connections
    clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, PING_INTERVAL_MS);

    toBackground({ type: 'ws-status', status: 'connected' });
  });

  ws.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      toBackground({ ...data, _fromServer: true });
    } catch (e) {
      console.warn('[Offscreen] Failed to parse server message:', e);
    }
  });

  ws.addEventListener('close', (event) => {
    console.warn('[Offscreen] WebSocket closed', event.code, event.reason);
    clearInterval(pingInterval);
    toBackground({ type: 'ws-status', status: 'disconnected' });

    if (!isIntentionalClose) {
      scheduleReconnect();
    }
  });

  ws.addEventListener('error', (err) => {
    console.error('[Offscreen] WebSocket error:', err);
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    console.log(`[Offscreen] Reconnecting (delay: ${reconnectDelay}ms)...`);
    connect();
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }, reconnectDelay);
}

function sendToServer(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  } else {
    // Queue it — will flush on reconnect
    sendQueue.push(payload);
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      isIntentionalClose = false;
      connect();
    }
  }
}

function disconnect() {
  isIntentionalClose = true;
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.close();
    ws = null;
  }
}

// ─── Message bridge ───────────────────────────────────────────────────────────

function toBackground(message) {
  chrome.runtime.sendMessage({ ...message, source: 'offscreen' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message) => {
  const { source, type } = message;
  if (source !== 'background') return;

  switch (type) {
    case 'ws-connect':
      connect();
      break;
    case 'ws-disconnect':
      disconnect();
      break;
    case 'ws-leave':
      sendToServer({ type: 'leave' });
      break;
    case 'ws-send':
      sendToServer(message.payload);
      break;
    case 'get-status':
      toBackground({
        type: 'ws-status',
        status: (ws && ws.readyState === WebSocket.OPEN) ? 'connected' : 'disconnected'
      });
      break;
    default:
      // Unknown — ignore
      break;
  }
});

// ─── Auto-connect on document load ───────────────────────────────────────────
connect();
