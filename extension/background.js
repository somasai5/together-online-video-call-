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

let creatingOffscreen = null;
let offscreenCreated = false;

async function ensureOffscreenDocument() {
  if (offscreenCreated) return;

  if (await chrome.offscreen?.hasDocument?.()) {
    offscreenCreated = true;
    return;
  }

  try {
    const contexts = await chrome.runtime.getContexts?.({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [OFFSCREEN_URL],
    });
    if (contexts && contexts.length > 0) {
      offscreenCreated = true;
      return;
    }
  } catch {}

  if (creatingOffscreen) {
    try {
      await creatingOffscreen;
    } catch {}
    return;
  }

  creatingOffscreen = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS'],
        justification: 'Maintain persistent WebSocket connection to signaling server',
      });
      offscreenCreated = true;
    } catch (err) {
      if (err?.message && err.message.includes('Only a single offscreen')) {
        offscreenCreated = true;
      } else {
        console.warn('[Background] Offscreen init notice:', err?.message);
      }
    } finally {
      creatingOffscreen = null;
    }
  })();

  await creatingOffscreen;
}

// ─── Message routing ──────────────────────────────────────────────────────────

/**
 * Messages FROM content scripts → forward to offscreen document (WebSocket side)
 * Messages FROM offscreen document → forward to all Hotstar content script tabs
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { source, type } = message;

  // From content script
  if (source === 'content_script') {
    if (type === 'get-room-state') {
      const tabId = sender.tab?.id;
      if (tabId) {
        chrome.storage.session.get(['roomCode', 'participantId', 'isHost', 'movieUrl', 'movieTitle'], (data) => {
          if (data && data.roomCode) {
            chrome.tabs.sendMessage(tabId, { ...data, type: 'room-state', source: 'background' }).catch(() => {});
          }
        });
      }
      return false;
    }

    // Forward to offscreen
    chrome.runtime.sendMessage({ ...message, source: 'background' }).catch(() => {});
    return false;
  }

  // From offscreen → forward to active Hotstar tab content scripts
  if (source === 'offscreen') {
    // If this is a room-state update, persist in session storage
    if (type === 'room-created' || type === 'joined' || type === 'reconnected' || type === 'room-state') {
      const roomState = {
        roomCode: message.roomCode,
        participantId: message.participantId,
        isHost: message.isHost,
      };
      chrome.storage.session.set(roomState).catch(() => {});
    }

    if (type === 'movie-change' || type === 'state-snapshot') {
      if (message.url) {
        chrome.storage.session.set({
          movieUrl: message.url,
          movieTitle: message.title || '',
        }).catch(() => {});
      }
    }

    if (type === 'left-room') {
      chrome.storage.session.clear().catch(() => {});
      chrome.storage.local.remove(['roomCode', 'participantId', 'isHost', 'peerConnected', 'movieUrl', 'movieTitle']).catch(() => {});
    }

    // Broadcast to all Hotstar tabs
    chrome.tabs.query({}, async (tabs) => {
      if (!tabs) return;
      for (const tab of tabs) {
        if (tab.id === undefined || tab.id < 0) continue;
        if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:'))) continue;

        const isHotstar = tab.url && (tab.url.includes('hotstar.com') || tab.url.includes('jiohotstar.com'));
        if (!isHotstar) continue;

        try {
          await chrome.tabs.sendMessage(tab.id, { ...message, source: 'background' });
        } catch {
          // If tab was opened before extension reloaded or script not attached, auto-inject
          if (type === 'room-created' || type === 'joined' || type === 'reconnected' || type === 'room-state') {
            try {
              await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['overlay.css'] });
              await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_script.js'] });
              setTimeout(() => {
                chrome.tabs.sendMessage(tab.id, { ...message, source: 'background' }).catch(() => {});
              }, 120);
            } catch {}
          }
        }
      }
    });

    // Also forward to popup if open
    chrome.runtime.sendMessage({ ...message, source: 'background' }).catch(() => {});
    return false;
  }

  // From popup → forward to offscreen
  if (source === 'popup') {
    chrome.runtime.sendMessage({ ...message, source: 'background' }).catch(() => {});
    return false;
  }

  return false;
});

// ─── Reset stale room state on clean install / update ────────────────────────

function resetRoomStorage() {
  try {
    chrome.storage.session?.clear?.().catch?.(() => {});
  } catch {}
  try {
    chrome.storage.local?.remove?.(['roomCode', 'participantId', 'isHost', 'peerConnected', 'movieUrl', 'movieTitle']).catch?.(() => {});
  } catch {}

  // Broadcast to all open tabs so existing content scripts clean up immediately
  chrome.tabs?.query?.({}, (tabs) => {
    if (!tabs) return;
    for (const tab of tabs) {
      if (tab.id === undefined || tab.id < 0) continue;
      chrome.tabs.sendMessage(tab.id, { type: 'left-room', source: 'background' }).catch(() => {});
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  resetRoomStorage();
});

// ─── Listen for Tab Navigation on Hotstar ────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    const url = changeInfo.url || tab.url;
    if (url && (url.includes('hotstar.com') || url.includes('jiohotstar.com'))) {
      chrome.storage.session.get(['roomCode', 'participantId', 'isHost', 'movieUrl', 'movieTitle'], (data) => {
        if (data && data.roomCode) {
          chrome.tabs.sendMessage(tabId, { ...data, type: 'room-state', source: 'background' }).catch(() => {});
        }
      });
    }
  }
});

// ─── Alarms keepalive (belt-and-suspenders) ───────────────────────────────────
// Even though the offscreen document holds the WebSocket, keep an alarm
// so the service worker wakes up periodically and can re-create the offscreen
// document if Chrome ever tears it down unexpectedly.

chrome.alarms.create('keepalive', { periodInMinutes: 0.4 }); // every ~24s

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepalive') {
    if (await chrome.offscreen?.hasDocument?.()) {
      offscreenCreated = true;
    } else {
      offscreenCreated = false;
      await ensureOffscreenDocument();
    }
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────

// Eagerly create the offscreen document when the service worker starts
ensureOffscreenDocument().catch(() => {});
