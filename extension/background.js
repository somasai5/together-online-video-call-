/**
 * background.js — MV3 Service Worker
 *
 * Responsibilities:
 *  - Creates and manages the offscreen document (which holds the real WebSocket)
 *  - Relays messages between content scripts ↔ offscreen document
 *  - Stores room/participant state in chrome.storage.session
 *
 * MV3 note: service workers are killed after ~30s of inactivity.
 * The WebSocket lives in the offscreen document, which is NOT subject to that
 * idle-kill. This worker just acts as a message router.
 */

'use strict';

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

// ─── Offscreen document management ───────────────────────────────────────────

async function ensureOffscreenDocument() {
  // Check if already exists
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;

  // Also check via getContexts (more reliable in some Chrome versions)
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [OFFSCREEN_URL],
    });
    if (contexts.length > 0) return;
  } catch {
    // getContexts may not be available in all versions; fall through
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['BLOBS'],
    justification: 'Maintain persistent WebSocket connection to signaling server',
  });
}

// ─── Message routing ──────────────────────────────────────────────────────────

/**
 * Messages FROM content scripts → forward to offscreen document (WebSocket side)
 * Messages FROM offscreen document → forward to all Hotstar content script tabs
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { source, type } = message;

  // From content script → forward to offscreen
  if (source === 'content_script') {
    ensureOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({ ...message, source: 'background' }).catch(() => {});
    });
    // Keep channel open for async response if needed
    return false;
  }

  // From offscreen → forward to active Hotstar tab content scripts
  if (source === 'offscreen') {
    // If this is a room-state update, persist it
    if (type === 'room-created' || type === 'joined' || type === 'reconnected' || type === 'room-state') {
      const roomState = {
        roomCode: message.roomCode,
        participantId: message.participantId,
        isHost: message.isHost,
      };
      chrome.storage.session.set(roomState).catch(() => {});
      chrome.storage.local.set(roomState).catch(() => {});
    }

    if (type === 'left-room') {
      chrome.storage.session.clear().catch(() => {});
      chrome.storage.local.remove(['roomCode', 'participantId', 'isHost', 'peerConnected']).catch(() => {});
    }

    // Broadcast to all Hotstar content script tabs
    chrome.tabs.query({ url: ['*://*.hotstar.com/*', '*://*.disneyplus.hotstar.com/*', '*://*.jiohotstar.com/*'] }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { ...message, source: 'background' }).catch(() => {});
      }
    });

    // Also forward to popup if open
    chrome.runtime.sendMessage({ ...message, source: 'background' }).catch(() => {});
    return false;
  }

  // From popup → forward to offscreen
  if (source === 'popup') {
    ensureOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({ ...message, source: 'background' }).catch(() => {});
    });
    return false;
  }

  return false;
});

// ─── Alarms keepalive (belt-and-suspenders) ───────────────────────────────────
// Even though the offscreen document holds the WebSocket, keep an alarm
// so the service worker wakes up periodically and can re-create the offscreen
// document if Chrome ever tears it down unexpectedly.

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 }); // every ~24s

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepalive') {
    await ensureOffscreenDocument();
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────

// Eagerly create the offscreen document when the service worker starts
ensureOffscreenDocument().catch(console.error);
