/**
 * content_script.js — Together Watch Party
 *
 * Injected into Hotstar pages. Covers:
 *  Stage 2: Extension skeleton + overlay mount
 *  Stage 3: Playback sync (MutationObserver, drift correction, ad detection)
 *  Stage 4: Text chat
 *  Stage 5: Emoji reactions
 *  Stage 6: WebRTC webcam
 *  Stage 7: Fullscreen handling
 */

'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────

/** STUN + TURN config — replace TURN credentials with your own (e.g. metered.ca) */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // ↓ Add your TURN credentials here
  // {
  //   urls: 'turn:YOUR_TURN_SERVER:3478',
  //   username: 'YOUR_USERNAME',
  //   credential: 'YOUR_CREDENTIAL',
  // },
];

const DRIFT_HEARTBEAT_INTERVAL_MS = 7_000;
const DRIFT_HARD_SEEK_THRESHOLD   = 3;    // seconds — beyond this: hard seek
const DRIFT_NUDGE_THRESHOLD       = 0.8;  // seconds — within this: ignore

const EMOJIS = ['❤️', '😂', '😮', '👏', '🔥', '😢'];

// ─── State ────────────────────────────────────────────────────────────────────

let roomCode      = null;
let participantId = null;
let isHost        = false;
let isInRoom      = false;

let videoEl       = null;
let isSyncing     = false;       // guard against feedback loops
let syncEnabled   = true;        // enabled by default
let isInAdBreak   = false;       // don't sync during ads

let driftInterval = null;

let pc            = null;        // RTCPeerConnection
let localStream   = null;
let remoteStream  = null;

let overlayRoot   = null;        // #together-overlay-root
let panelVisible  = true;

// Video observer
let videoObserver = null;

// ─── Utility ──────────────────────────────────────────────────────────────────

function sendToBackground(payload) {
  chrome.runtime.sendMessage({ ...payload, source: 'content_script' }).catch(() => {});
}

function sendWS(payload) {
  sendToBackground({ type: 'ws-send', payload });
}

function log(...args) {
  console.log('[Together]', ...args);
}

// ─── Overlay injection ────────────────────────────────────────────────────────

function injectOverlay() {
  if (document.getElementById('together-overlay-root')) return;

  // Load overlay CSS from web_accessible_resources (avoids CSP issues)
  const link = document.createElement('link');
  link.rel  = 'stylesheet';
  link.href = chrome.runtime.getURL('overlay.css');
  document.head.appendChild(link);

  overlayRoot = document.createElement('div');
  overlayRoot.id = 'together-overlay-root';
  overlayRoot.innerHTML = buildOverlayHTML();

  // Inject into the page body initially; fullscreen handler will reparent if needed
  document.body.appendChild(overlayRoot);

  attachOverlayListeners();
  log('Overlay injected');
}

function buildOverlayHTML() {
  const emojiButtons = EMOJIS.map(
    (e) => `<button class="tog-emoji-btn" data-emoji="${e}" title="${e}">${e}</button>`
  ).join('');

  return `
    <!-- Sync enable banner (guest only, shown before first interaction) -->
    <div id="tog-sync-banner" class="hidden">
      ▶ Join &amp; Enable Sync
    </div>

    <!-- Desync prompt (shown when autoplay is blocked) -->
    <div id="tog-desync-prompt" class="hidden">
      ▶ Playback out of sync — click to resume
    </div>

    <!-- Main panel -->
    <div id="tog-panel">

      <!-- Webcam section -->
      <div id="tog-webcam-section">
        <div class="tog-video-tile" id="tog-local-tile">
          <video id="tog-local-video" autoplay muted playsinline></video>
          <div class="tog-cam-placeholder" id="tog-local-placeholder">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>
            </svg>
            <span>Camera off</span>
          </div>
          <span class="tog-video-label">You</span>
        </div>
        <div class="tog-video-tile" id="tog-remote-tile">
          <video id="tog-remote-video" autoplay playsinline></video>
          <div class="tog-cam-placeholder" id="tog-remote-placeholder">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
            </svg>
            <span>Friend</span>
          </div>
          <span class="tog-video-label">Friend</span>
        </div>
      </div>

      <!-- Webcam controls -->
      <div id="tog-webcam-controls">
        <button class="tog-ctrl-btn" id="tog-mute-btn" title="Mute mic">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
        </button>
        <button class="tog-ctrl-btn" id="tog-cam-btn" title="Toggle camera">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 7l-7 5 7 5V7z"/>
            <rect x="1" y="5" width="15" height="14" rx="2"/>
          </svg>
        </button>
        <button class="tog-ctrl-btn" id="tog-call-btn" title="Start / end call">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.49 12 19.79 19.79 0 0 1 1.45 3.4 2 2 0 0 1 3.42 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.4a16 16 0 0 0 5.69 5.69l.84-.84a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
          </svg>
        </button>
      </div>

      <!-- Emoji bar -->
      <div id="tog-emoji-bar">${emojiButtons}</div>

      <!-- Chat messages -->
      <div id="tog-chat-messages" role="log" aria-live="polite"></div>

      <!-- Chat input -->
      <div id="tog-chat-input-row">
        <textarea
          id="tog-chat-input"
          placeholder="Type a message…"
          rows="1"
          maxlength="500"
        ></textarea>
        <button id="tog-send-btn" title="Send message">
          <svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>

    <!-- Toggle button -->
    <button id="tog-toggle-btn" title="Toggle Together panel">
      <svg viewBox="0 0 24 24">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
    </button>
  `;
}

function attachOverlayListeners() {
  // Toggle panel
  document.getElementById('tog-toggle-btn').addEventListener('click', () => {
    panelVisible = !panelVisible;
    document.getElementById('tog-panel').classList.toggle('collapsed', !panelVisible);
  });

  // Sync banner (guest interaction to satisfy autoplay policy)
  document.getElementById('tog-sync-banner').addEventListener('click', () => {
    syncEnabled = true;
    document.getElementById('tog-sync-banner').classList.add('hidden');
    log('Sync enabled by user interaction');
  });

  // Desync prompt
  document.getElementById('tog-desync-prompt').addEventListener('click', () => {
    document.getElementById('tog-desync-prompt').classList.add('hidden');
    if (videoEl) {
      videoEl.play().catch(() => {});
    }
  });

  // Emoji buttons
  document.getElementById('tog-emoji-bar').addEventListener('click', (e) => {
    const btn = e.target.closest('.tog-emoji-btn');
    if (!btn) return;
    const emoji = btn.dataset.emoji;
    sendWS({ type: 'emoji', emoji });
    spawnEmojiFloat(emoji);
  });

  // Chat send
  document.getElementById('tog-send-btn').addEventListener('click', sendChatMessage);
  document.getElementById('tog-chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // WebRTC controls
  document.getElementById('tog-call-btn').addEventListener('click', handleCallToggle);
  document.getElementById('tog-mute-btn').addEventListener('click', handleMuteToggle);
  document.getElementById('tog-cam-btn').addEventListener('click', handleCamToggle);

  // Fullscreen change — reparent overlay
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
}

function findMainVideo() {
  const videos = Array.from(document.querySelectorAll('video')).filter((v) => {
    return v.id !== 'tog-local-video' && v.id !== 'tog-remote-video' && !v.closest('#together-overlay-root');
  });

  if (videos.length === 0) return null;
  if (videos.length === 1) return videos[0];

  // Pick the largest visible video on the page
  let best = videos[0];
  let maxArea = -1;
  for (const v of videos) {
    const rect = v.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > maxArea) {
      maxArea = area;
      best = v;
    }
  }
  return best;
}

function startVideoObserver() {
  if (videoObserver) videoObserver.disconnect();

  function tryAttach() {
    const v = findMainVideo();
    if (v && v !== videoEl) {
      videoEl = v;
      attachVideoListeners(v);
      log('Main Hotstar video element attached:', v);
    }
  }

  tryAttach(); // immediate attempt

  videoObserver = new MutationObserver(() => tryAttach());
  videoObserver.observe(document.body, { childList: true, subtree: true });

  if (!window._togVideoCheckInterval) {
    window._togVideoCheckInterval = setInterval(tryAttach, 2000);
  }
}

function attachVideoListeners(v) {
  if (v._togListenersAttached) return;
  v._togListenersAttached = true;

  v.addEventListener('play',   onVideoPlay);
  v.addEventListener('pause',  onVideoPause);
  v.addEventListener('seeked', onVideoSeeked);
  log('Hooked play/pause/seeked event listeners to main video');
}

// ─── Playback sync — host side ────────────────────────────────────────────────

function onVideoPlay() {
  if (!isHost || !isInRoom || isSyncing || isInAdBreak) return;
  sendWS({ type: 'sync', action: 'play', currentTime: videoEl.currentTime });
}

function onVideoPause() {
  if (!isHost || !isInRoom || isSyncing || isInAdBreak) return;
  sendWS({ type: 'sync', action: 'pause', currentTime: videoEl.currentTime });
}

function onVideoSeeked() {
  if (!isHost || !isInRoom || isSyncing || isInAdBreak) return;
  sendWS({ type: 'sync', action: 'seek', currentTime: videoEl.currentTime });
}

// ─── Playback sync — guest side ───────────────────────────────────────────────

function applySync(action, currentTime) {
  if (!videoEl || isInAdBreak) return;

  isSyncing = true;
  try {
    videoEl.currentTime = currentTime;
    if (action === 'play') {
      const p = videoEl.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          // Autoplay blocked — show prompt
          document.getElementById('tog-desync-prompt').classList.remove('hidden');
        });
      }
    } else if (action === 'pause' || action === 'seek') {
      if (!videoEl.paused) videoEl.pause();
    }
  } finally {
    // Release guard after a tick so our own triggered events don't re-broadcast
    setTimeout(() => { isSyncing = false; }, 100);
  }
}

// ─── Drift correction (host heartbeat → guest nudge) ─────────────────────────

function startDriftHeartbeat() {
  if (!isHost) return;
  clearInterval(driftInterval);
  driftInterval = setInterval(() => {
    if (!videoEl || isInAdBreak) return;
    sendWS({ type: 'drift-heartbeat', currentTime: videoEl.currentTime });
  }, DRIFT_HEARTBEAT_INTERVAL_MS);
}

function applyDriftCorrection(hostTime) {
  if (!videoEl || isHost || isInAdBreak) return;

  const diff = Math.abs(videoEl.currentTime - hostTime);

  if (diff < DRIFT_NUDGE_THRESHOLD) return; // within tolerance

  if (diff > DRIFT_HARD_SEEK_THRESHOLD) {
    // Large drift — hard seek
    isSyncing = true;
    videoEl.currentTime = hostTime;
    setTimeout(() => { isSyncing = false; }, 100);
    log(`Drift correction (hard seek): Δ${diff.toFixed(2)}s`);
  } else {
    // Small drift — subtle rate nudge
    videoEl.playbackRate = hostTime > videoEl.currentTime ? 1.05 : 0.95;
    setTimeout(() => { videoEl.playbackRate = 1.0; }, 2500);
    log(`Drift correction (rate nudge): Δ${diff.toFixed(2)}s`);
  }
}

// ─── Ad break detection ───────────────────────────────────────────────────────

/**
 * Hotstar marks ad playback with a specific class on the player container.
 * We observe both DOM class mutations and video `src` changes.
 * Adjust the selectors here based on real DOM inspection.
 */
function startAdDetection() {
  function checkAdState() {
    // Only detect ads if an explicit ad overlay element exists on Hotstar
    const adOverlay = !!document.querySelector('.ad-container, [data-testid*="ad-container"], .ad-badge, .ad-timer, [class*="AdOverlay"]');
    const nowInAd = adOverlay;

    if (nowInAd !== isInAdBreak) {
      isInAdBreak = nowInAd;
      log(isInAdBreak ? '🎬 Ad break started — sync paused' : '✅ Ad break ended — sync resumed');

      if (!isInAdBreak && isHost && videoEl) {
        // Resuming after ad — broadcast current state to re-sync guest
        setTimeout(() => {
          sendWS({
            type: 'sync',
            action: videoEl.paused ? 'pause' : 'play',
            currentTime: videoEl.currentTime,
          });
        }, 1000);
      }
    }
  }

  // Watch for class changes on body subtree
  const adObserver = new MutationObserver(checkAdState);
  adObserver.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class', 'data-testid'] });
  checkAdState();
}

// ─── Text chat ────────────────────────────────────────────────────────────────

function sendChatMessage() {
  const input = document.getElementById('tog-chat-input');
  const text  = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = '';

  sendWS({ type: 'chat', text });
  appendChatMessage(text, 'mine');
}

function appendChatMessage(text, who, sender) {
  const container = document.getElementById('tog-chat-messages');
  if (!container) return;

  const div  = document.createElement('div');
  div.className = `tog-msg ${who}`;

  const meta   = document.createElement('div');
  meta.className = 'tog-msg-meta';
  meta.textContent = who === 'mine' ? 'You' : who === 'system' ? '' : (sender || 'Friend');

  const bubble = document.createElement('div');
  bubble.className = 'tog-msg-bubble';
  bubble.textContent = text; // ← textContent only, never innerHTML (XSS safe)

  if (who !== 'system') div.appendChild(meta);
  div.appendChild(bubble);
  container.appendChild(div);

  // Auto-scroll to bottom
  container.scrollTop = container.scrollHeight;
}

// ─── Emoji reactions ──────────────────────────────────────────────────────────

function spawnEmojiFloat(emoji) {
  const el  = document.createElement('div');
  el.className = 'tog-emoji-float';
  el.textContent = emoji;

  // Random horizontal position near the toggle button area
  const x = window.innerWidth - 60 - Math.random() * 80;
  const y = window.innerHeight - 80;
  el.style.left = `${x}px`;
  el.style.top  = `${y}px`;

  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

// ─── WebRTC ───────────────────────────────────────────────────────────────────

let pendingIceCandidates = [];

async function handleCallToggle() {
  if (pc) {
    endCall(true);
  } else {
    await startCall();
  }
}

async function getLocalMediaStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    log('getUserMedia (audio+video) failed, trying video only:', err);
    try {
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (e2) {
      log('getUserMedia video-only failed, trying audio only:', e2);
      return await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    }
  }
}

async function setupPeerConnection() {
  if (pc) {
    try { pc.close(); } catch {}
  }

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  pc.addEventListener('track', (e) => {
    log('Remote track received:', e.track.kind);
    remoteStream = e.streams[0] || new MediaStream([e.track]);
    showRemoteStream(remoteStream);
  });

  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate) {
      sendWS({ type: 'ice-candidate', candidate: e.candidate });
    }
  });

  pc.addEventListener('connectionstatechange', () => {
    log('WebRTC connection state:', pc.connectionState);
    if (pc.connectionState === 'connected') {
      appendChatMessage('Video call connected!', 'system');
      document.getElementById('tog-call-btn')?.classList.add('active');
    } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      appendChatMessage('Video call disconnected.', 'system');
      document.getElementById('tog-call-btn')?.classList.remove('active');
    }
  });

  return pc;
}

async function startCall() {
  log('Starting WebRTC call...');

  try {
    localStream = await getLocalMediaStream();
  } catch (err) {
    log('getUserMedia failed:', err);
    appendChatMessage('Could not access camera/mic: ' + (err.message || 'Permission denied'), 'system');
    return;
  }

  showLocalStream(localStream);
  await setupPeerConnection();

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWS({ type: 'offer', sdp: pc.localDescription });
    log('Offer sent');
    appendChatMessage('Calling friend...', 'system');
  } catch (err) {
    log('Failed to create offer:', err);
  }
}

function endCall(notifyPeer = true) {
  if (pc) {
    try { pc.close(); } catch {}
    pc = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  remoteStream = null;
  pendingIceCandidates = [];
  showLocalStream(null);
  showRemoteStream(null);
  document.getElementById('tog-call-btn')?.classList.remove('active');
  document.getElementById('tog-cam-btn')?.classList.remove('active');
  document.getElementById('tog-mute-btn')?.classList.remove('active');
  log('Call ended');

  if (notifyPeer) {
    sendWS({ type: 'call-ended' });
  }
}

function showLocalStream(stream) {
  const video       = document.getElementById('tog-local-video');
  const placeholder = document.getElementById('tog-local-placeholder');
  if (!video) return;

  if (stream) {
    video.srcObject = stream;
    video.muted = true;
    video.play().catch(() => {});
    if (placeholder) placeholder.style.display = 'none';
    video.style.display = 'block';
  } else {
    video.srcObject = null;
    if (placeholder) placeholder.style.display = '';
    video.style.display = 'none';
  }
}

function showRemoteStream(stream) {
  const video       = document.getElementById('tog-remote-video');
  const placeholder = document.getElementById('tog-remote-placeholder');
  if (!video) return;

  if (stream) {
    video.srcObject = stream;
    video.play().catch(() => {});
    if (placeholder) placeholder.style.display = 'none';
    video.style.display = 'block';
  } else {
    video.srcObject = null;
    if (placeholder) placeholder.style.display = '';
    video.style.display = 'none';
  }
}

// ─── Mute / cam toggles ───────────────────────────────────────────────────────

function handleMuteToggle() {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;

  track.enabled = !track.enabled;
  document.getElementById('tog-mute-btn').classList.toggle('active', !track.enabled);
}

function handleCamToggle() {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;

  track.enabled = !track.enabled;
  document.getElementById('tog-cam-btn').classList.toggle('active', !track.enabled);

  const placeholder = document.getElementById('tog-local-placeholder');
  const video       = document.getElementById('tog-local-video');
  if (placeholder && video) {
    placeholder.style.display = track.enabled ? 'none' : '';
    video.style.display       = track.enabled ? 'block' : 'none';
  }
}

// ─── Fullscreen handling ──────────────────────────────────────────────────────

function onFullscreenChange() {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;

  if (fsEl) {
    // Entering fullscreen — move overlay inside the fullscreen element
    if (overlayRoot && overlayRoot.parentElement !== fsEl) {
      fsEl.appendChild(overlayRoot);
      log('Overlay reparented into fullscreen element');
    }
  } else {
    // Exiting fullscreen — move back to body
    if (overlayRoot && overlayRoot.parentElement !== document.body) {
      document.body.appendChild(overlayRoot);
      log('Overlay reparented back to body');
    }
  }
}

// ─── Incoming messages from background ───────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.source !== 'background') return;

  switch (message.type) {
    // ── Room state ─────────────────────────────────────────────────────────
    case 'room-created':
    case 'joined':
    case 'reconnected':
      roomCode      = message.roomCode;
      participantId = message.participantId;
      isHost        = message.isHost;
      isInRoom      = true;

      injectOverlay();
      startVideoObserver();
      startAdDetection();

      if (isHost) {
        startDriftHeartbeat();
        appendChatMessage('Room created. Share the code!', 'system');
      } else {
        // Show sync-enable banner (guest must interact before remote play() calls)
        const banner = document.getElementById('tog-sync-banner');
        if (banner) banner.classList.remove('hidden');
        appendChatMessage('Joined room. Click "Join & Enable Sync" to start.', 'system');
      }

      if (message.type === 'reconnected') {
        appendChatMessage('Reconnected to room.', 'system');
      }
      break;

    case 'you-are-host':
      isHost = true;
      startDriftHeartbeat();
      appendChatMessage('You are now the host.', 'system');
      break;

    case 'peer-joined':
      appendChatMessage('Friend joined the room!', 'system');
      break;

    case 'peer-reconnected':
      appendChatMessage('Friend reconnected.', 'system');
      break;

    case 'peer-disconnected':
      appendChatMessage('Friend disconnected.', 'system');
      break;

    case 'left-room':
      isInRoom = false;
      roomCode = null;
      participantId = null;
      isHost = false;
      if (overlayRoot) {
        overlayRoot.remove();
        overlayRoot = null;
      }
      endCall(false);
      log('Left room');
      break;

    // ── Server asks us to send state snapshot (for reconnected guest) ──────
    case 'send-state-snapshot':
      if (isHost && videoEl) {
        sendWS({
          type: 'state-snapshot',
          currentTime: videoEl.currentTime,
          paused: videoEl.paused,
        });
      }
      break;

    // ── Server asks guest to request state ─────────────────────────────────
    case 'request-state':
      sendWS({ type: 'state-request' });
      break;

    // ── Incoming state snapshot (for guest on reconnect) ───────────────────
    case 'state-snapshot':
      if (!isHost) {
        applySync(message.paused ? 'pause' : 'play', message.currentTime);
      }
      break;

    // ── Playback sync ───────────────────────────────────────────────────────
    case 'sync':
      if (isHost) break; // server already validated, but double-guard
      if (!syncEnabled) break;
      applySync(message.action, message.currentTime);
      break;

    // ── Drift heartbeat ─────────────────────────────────────────────────────
    case 'drift-heartbeat':
      if (!isHost && syncEnabled) {
        applyDriftCorrection(message.currentTime);
      }
      break;

    // ── Chat ────────────────────────────────────────────────────────────────
    case 'chat':
      appendChatMessage(message.text, 'theirs');
      break;

    // ── Emoji ───────────────────────────────────────────────────────────────
    case 'emoji':
      spawnEmojiFloat(message.emoji);
      break;

    // ── WebRTC signaling ─────────────────────────────────────────────────────
    case 'offer':
      handleIncomingOffer(message);
      break;

    case 'answer':
      handleIncomingAnswer(message);
      break;

    case 'ice-candidate':
      handleIncomingIce(message);
      break;

    case 'call-ended':
      endCall(false);
      appendChatMessage('Video call ended by friend.', 'system');
      break;
  }
});

// ─── WebRTC signaling handlers ────────────────────────────────────────────────

async function handleIncomingOffer(message) {
  log('Received offer — answering call');
  if (!localStream) {
    try {
      localStream = await getLocalMediaStream();
      showLocalStream(localStream);
    } catch (err) {
      log('Could not get local stream on incoming call:', err);
    }
  }

  await setupPeerConnection();

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
    await flushIceCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendWS({ type: 'answer', sdp: pc.localDescription });
    log('Answer sent');
    appendChatMessage('Answering video call...', 'system');
  } catch (err) {
    log('Handle offer failed:', err);
  }
}

async function handleIncomingAnswer(message) {
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
    await flushIceCandidates();
    log('Answer received, remote description set');
  } catch (err) {
    log('Handle answer failed:', err);
  }
}

async function handleIncomingIce(message) {
  if (!message.candidate) return;
  if (!pc || !pc.remoteDescription) {
    pendingIceCandidates.push(message.candidate);
    return;
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
  } catch (e) {
    log('ICE candidate error:', e);
  }
}

async function flushIceCandidates() {
  if (!pc || !pc.remoteDescription) return;
  while (pendingIceCandidates.length > 0) {
    const candidate = pendingIceCandidates.shift();
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      log('Flush ICE error:', e);
    }
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

function initRoom(data) {
  if (!data || !data.roomCode || isInRoom) return;
  roomCode      = data.roomCode;
  participantId = data.participantId;
  isHost        = data.isHost ?? false;
  isInRoom      = true;

  injectOverlay();
  startVideoObserver();
  startAdDetection();

  if (isHost) {
    startDriftHeartbeat();
  }

  // Ask for fresh state from host
  sendWS({ type: 'state-request' });
  log('Restored room session:', roomCode, 'isHost:', isHost);
}

// Start watching for video elements immediately on page load
startVideoObserver();

// Restore state if already in a room (e.g. page reload or navigation)
chrome.storage.session.get(['roomCode', 'participantId', 'isHost'], (data) => {
  if (data && data.roomCode) {
    initRoom(data);
  } else {
    chrome.storage.local.get(['roomCode', 'participantId', 'isHost'], (locData) => {
      if (locData && locData.roomCode) {
        initRoom(locData);
      }
    });
  }
});
