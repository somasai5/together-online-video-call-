/**
 * popup.js — Popup UI logic
 *
 * Handles Create Room / Join Room screens.
 * Communicates with background.js via chrome.runtime.sendMessage.
 */

'use strict';

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const screenLobby = document.getElementById('screen-lobby');
const screenRoom  = document.getElementById('screen-room');

const btnCreate   = document.getElementById('btn-create');
const btnJoin     = document.getElementById('btn-join');
const btnCopy     = document.getElementById('btn-copy');
const btnLeave    = document.getElementById('btn-leave');

const inputCode   = document.getElementById('input-room-code');
const joinError   = document.getElementById('join-error');

const statusDot   = document.getElementById('status-dot');
const statusText  = document.getElementById('status-text');

const roomCodeValue = document.getElementById('room-code-value');
const myRole        = document.getElementById('my-role');
const peerItem      = document.getElementById('peer-item');
const peerDot       = document.getElementById('peer-dot');
const peerLabel     = document.getElementById('peer-label');

const movieStatusCard = document.getElementById('movie-status-card');
const popupMovieTitle = document.getElementById('popup-movie-title');
const btnOpenMovie     = document.getElementById('btn-open-movie');

// ─── State ────────────────────────────────────────────────────────────────────
let currentRoomCode = null;
let participantId   = null;
let isHost          = false;
let peerConnected   = false;
let currentMovieUrl    = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function showScreen(name) {
  screenLobby.classList.toggle('active', name === 'lobby');
  screenRoom.classList.toggle('active', name === 'room');
}

function setStatus(state, text) {
  statusDot.className = `dot ${state}`;
  statusText.textContent = text;
}

function setJoinError(msg) {
  joinError.textContent = msg;
  joinError.classList.toggle('hidden', !msg);
}

function sendToBackground(payload) {
  chrome.runtime.sendMessage({ ...payload, source: 'popup' }).catch(() => {});
}

function updateMovieCard(url, title) {
  if (url) {
    currentMovieUrl = url;
    if (popupMovieTitle) popupMovieTitle.textContent = title || 'Hotstar Video';
    movieStatusCard?.classList.remove('hidden');
  } else {
    currentMovieUrl = null;
    movieStatusCard?.classList.add('hidden');
  }
}

// ─── Restore persisted state on popup open ────────────────────────────────────
function applyStoredState(data) {
  if (!data || !data.roomCode) {
    showScreen('lobby');
    return;
  }
  currentRoomCode = data.roomCode;
  participantId   = data.participantId;
  isHost          = data.isHost ?? false;
  peerConnected   = data.peerConnected ?? false;

  roomCodeValue.textContent = data.roomCode;
  myRole.textContent        = isHost ? 'Host' : 'Guest';

  updatePeerStatus(peerConnected);
  if (data.movieUrl) {
    updateMovieCard(data.movieUrl, data.movieTitle);
  } else {
    updateMovieCard(null);
  }
  showScreen('room');
  setStatus('connected', 'In room');
}

chrome.storage.session.get(['roomCode', 'participantId', 'isHost', 'peerConnected', 'movieUrl', 'movieTitle'], (data) => {
  if (data && data.roomCode) {
    applyStoredState(data);
  } else {
    showScreen('lobby');
  }
});

// Immediately ask background for live WebSocket status
sendToBackground({ type: 'get-status' });

// ─── Event listeners ──────────────────────────────────────────────────────────

let pendingActionTimer = null;

function clearActionTimer() {
  if (pendingActionTimer) {
    clearTimeout(pendingActionTimer);
    pendingActionTimer = null;
  }
}

btnCreate.addEventListener('click', () => {
  setStatus('connecting', 'Creating room…');
  btnCreate.disabled = true;
  sendToBackground({ type: 'ws-send', payload: { type: 'create' } });

  clearActionTimer();
  pendingActionTimer = setTimeout(() => {
    btnCreate.disabled = false;
    setJoinError('Server is waking up. Please try again in 10s.');
  }, 12000);
});

btnJoin.addEventListener('click', () => {
  const code = inputCode.value.trim().toUpperCase();
  if (code.length !== 6) {
    setJoinError('Enter a 6-character room code.');
    return;
  }
  setJoinError('');
  setStatus('connecting', 'Joining room…');
  btnJoin.disabled = true;

  sendToBackground({
    type: 'ws-send',
    payload: { type: 'join', roomCode: code },
  });

  clearActionTimer();
  pendingActionTimer = setTimeout(() => {
    btnJoin.disabled = false;
    setJoinError('Connecting took longer than expected. Please try again.');
  }, 12000);
});

inputCode.addEventListener('input', () => {
  if (joinError.textContent) setJoinError('');
});

inputCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnJoin.click();
});

btnCopy.addEventListener('click', () => {
  if (!currentRoomCode) return;
  navigator.clipboard.writeText(currentRoomCode).then(() => {
    btnCopy.textContent = '✓ Copied!';
    btnCopy.classList.add('copy-flash');
    setTimeout(() => {
      btnCopy.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`;
      btnCopy.classList.remove('copy-flash');
    }, 2000);
  });
});

btnOpenMovie?.addEventListener('click', () => {
  const targetUrl = currentMovieUrl || 'https://www.hotstar.com';
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const currentTab = tabs[0];
    if (currentTab && currentTab.url && (currentTab.url.includes('hotstar.com') || currentTab.url.includes('jiohotstar.com'))) {
      chrome.tabs.update(currentTab.id, { url: targetUrl });
    } else {
      chrome.tabs.query({}, (allTabs) => {
        const hsTab = allTabs.find((t) => t.url && (t.url.includes('hotstar.com') || t.url.includes('jiohotstar.com')));
        if (hsTab && hsTab.id) {
          chrome.tabs.update(hsTab.id, { url: targetUrl, active: true });
        } else {
          chrome.tabs.create({ url: targetUrl });
        }
      });
    }
  });
});

btnLeave.addEventListener('click', () => {
  clearActionTimer();
  sendToBackground({ type: 'ws-leave' });
  chrome.storage.session.clear();
  chrome.storage.local.remove(['roomCode', 'participantId', 'isHost', 'peerConnected', 'movieUrl', 'movieTitle']);
  currentRoomCode = null;
  participantId   = null;
  isHost          = false;
  peerConnected   = false;
  currentMovieUrl = null;
  updateMovieCard(null);
  btnCreate.disabled = false;
  btnJoin.disabled   = false;
  inputCode.value    = '';
  showScreen('lobby');
  setStatus('connected', 'Connected');
});

// ─── Incoming messages from background ────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.source !== 'background') return;

  switch (message.type) {
    case 'ws-status':
      if (message.status === 'connected') {
        setStatus('connected', currentRoomCode ? 'In room' : 'Connected');
      } else if (message.status === 'connecting') {
        setStatus('connecting', 'Connecting to server…');
      } else {
        setStatus('disconnected', 'Disconnected');
      }
      break;

    case 'room-created':
      clearActionTimer();
      currentRoomCode = message.roomCode;
      participantId   = message.participantId;
      isHost          = true;
      peerConnected   = false;

      const hostState = { roomCode: message.roomCode, participantId, isHost: true, peerConnected: false };
      chrome.storage.session.set(hostState);

      roomCodeValue.textContent = message.roomCode;
      myRole.textContent        = 'Host';
      updatePeerStatus(false);
      showScreen('room');
      setStatus('connected', 'In room');
      btnCreate.disabled = false;
      break;

    case 'joined':
    case 'reconnected':
      clearActionTimer();
      currentRoomCode = message.roomCode;
      participantId   = message.participantId;
      isHost          = message.isHost;

      const guestState = { roomCode: message.roomCode, participantId, isHost, peerConnected: false };
      chrome.storage.session.set(guestState);

      roomCodeValue.textContent = message.roomCode;
      myRole.textContent        = message.isHost ? 'Host' : 'Guest';
      updatePeerStatus(false);
      showScreen('room');
      setStatus('connected', 'In room');
      btnJoin.disabled = false;
      break;

    case 'movie-change':
    case 'state-snapshot':
      if (message.url) {
        updateMovieCard(message.url, message.title);
      }
      break;

    case 'peer-joined':
    case 'peer-reconnected':
      peerConnected = true;
      chrome.storage.session.set({ peerConnected: true });
      updatePeerStatus(true);
      break;

    case 'peer-disconnected':
      peerConnected = false;
      chrome.storage.session.set({ peerConnected: false });
      updatePeerStatus(false);
      break;

    case 'you-are-host':
      isHost = true;
      chrome.storage.session.set({ isHost: true });
      myRole.textContent = 'Host';
      break;

    case 'left-room':
      currentRoomCode = null;
      participantId   = null;
      isHost          = false;
      peerConnected   = false;
      currentMovieUrl = null;
      updateMovieCard(null);
      chrome.storage.session.clear();
      showScreen('lobby');
      setStatus('connected', 'Connected');
      break;

    case 'error':
      clearActionTimer();
      setStatus('disconnected', 'Error');
      setJoinError(message.message || 'Unknown error');
      btnCreate.disabled = false;
      btnJoin.disabled   = false;
      showScreen('lobby');
      break;
  }
});

// ─── Peer status update ───────────────────────────────────────────────────────
function updatePeerStatus(connected) {
  peerItem.style.opacity   = connected ? '1' : '0.4';
  peerDot.className        = `dot ${connected ? 'connected' : 'disconnected'}`;
  peerLabel.textContent    = connected ? 'Friend' : 'Waiting for friend…';
}

