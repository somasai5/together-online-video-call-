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

/** Public STUN servers for reliable P2P WebRTC NAT traversal */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

const DRIFT_HEARTBEAT_INTERVAL_MS = 200;    // 200ms ultra-high frequency heartbeat (5x per second)
const DRIFT_HARD_SEEK_THRESHOLD   = 0.12;   // 120ms — snap seek if drift exceeds ~1/8th second
const DRIFT_NUDGE_THRESHOLD       = 0.012;  // 12ms — sub-frame tolerance (< 1 video frame at 60fps)

const EMOJIS = ['❤️', '😂', '😮', '👏', '🔥', '😢'];

// ─── State ────────────────────────────────────────────────────────────────────

let roomCode         = null;
let participantId    = null;
let isHost           = false;
let isInRoom         = false;

let videoEl          = null;
let isSyncing        = false;       // guard against feedback loops
let syncEnabled      = true;        // enabled by default
let isInAdBreak      = false;       // don't sync during ads
let hostPlaybackRate = 1.0;         // sync movie speed (1x, 1.25x, etc.)

let driftInterval    = null;
let clockSyncInterval = null;
let clockOffsetMs    = 0;          // Host clock offset (NTP measured)
let clockSyncSamples = [];

let lastBroadcastUrl = null;
let pendingMovieUrl  = null;

let pc               = null;        // RTCPeerConnection
let localStream      = null;
let remoteStream     = null;
let pendingOffer     = null;        // offer waiting for user interaction/answer

let overlayRoot      = null;        // #together-overlay-root
let panelVisible     = true;

// Video and ad observers
let videoObserver    = null;
let adObserver       = null;

// ─── Utility ──────────────────────────────────────────────────────────────────

function cleanupOrphanedScript() {
  try {
    if (videoObserver) {
      videoObserver.disconnect();
      videoObserver = null;
    }
    if (window._togVideoCheckInterval) {
      clearInterval(window._togVideoCheckInterval);
      window._togVideoCheckInterval = null;
    }
    if (driftInterval) {
      clearInterval(driftInterval);
      driftInterval = null;
    }
    if (clockSyncInterval) {
      clearInterval(clockSyncInterval);
      clockSyncInterval = null;
    }
  } catch {}
}

function sendToBackground(payload) {
  try {
    if (!chrome.runtime?.id) {
      cleanupOrphanedScript();
      return;
    }
    chrome.runtime.sendMessage({ ...payload, source: 'content_script' })?.catch(() => {});
  } catch (err) {
    cleanupOrphanedScript();
  }
}

function sendWS(payload) {
  sendToBackground({ type: 'ws-send', payload });
}

function log(...args) {
  console.log('[Together]', ...args);
}

// ─── Overlay injection ────────────────────────────────────────────────────────

function injectOverlay() {
  const existing = document.getElementById('together-overlay-root');
  if (existing) {
    existing.remove();
  }

  // Ensure overlay CSS stylesheet is linked
  if (!document.getElementById('together-overlay-css')) {
    const link = document.createElement('link');
    link.id   = 'together-overlay-css';
    link.rel  = 'stylesheet';
    link.href = chrome.runtime.getURL('overlay.css');
    (document.head || document.documentElement).appendChild(link);
  }

  overlayRoot = document.createElement('div');
  overlayRoot.id = 'together-overlay-root';
  overlayRoot.innerHTML = buildOverlayHTML();

  (document.body || document.documentElement).appendChild(overlayRoot);

  attachOverlayListeners();
  makePipDraggable();
  log('Overlay injected successfully with Watch Party panel');
}

let drawerOpen = true;
let unreadCount = 0;

function buildOverlayHTML() {
  const emojiButtons = EMOJIS.map(
    (e) => `<button class="tog-emoji-btn" data-emoji="${e}" title="${e}">${e}</button>`
  ).join('');

  return `
    <!-- Top-Center Movie Switch Notification Banner -->
    <div id="tog-movie-banner" class="hidden">
      <span id="tog-movie-text">🎬 Host is watching a different movie</span>
      <div class="tog-movie-banner-btns">
        <button class="tog-btn-switch" id="tog-switch-movie-btn">Switch Movie</button>
        <button class="tog-btn-dismiss" id="tog-dismiss-movie-btn" title="Dismiss">✕</button>
      </div>
    </div>

    <!-- Top-Right Incoming Call Banner -->
    <div id="tog-call-banner" class="hidden">
      <span>📞 Friend is calling you...</span>
      <div class="tog-call-banner-btns">
        <button class="tog-action-btn tog-btn-answer" id="tog-answer-call-btn">Answer</button>
        <button class="tog-action-btn tog-btn-decline" id="tog-decline-call-btn">Decline</button>
      </div>
    </div>

    <!-- Autoplay Sync Enable Banner -->
    <div id="tog-sync-banner" class="hidden">
      ▶ Join &amp; Enable Sync
    </div>

    <!-- Desync Resume Prompt -->
    <div id="tog-desync-prompt" class="hidden">
      ▶ Playback out of sync — click to resume
    </div>

    <!-- ── Watch Party Drawer (Open by Default) ── -->
    <div id="tog-drawer" class="open">
      <div id="tog-drawer-header">
        <div class="tog-drawer-brand">
          <div class="tog-brand-icon">
            <svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </div>
          <div class="tog-brand-text">
            <h2>Together</h2>
            <p>Watch Party</p>
          </div>
        </div>
        <button id="tog-drawer-close" title="Minimize Drawer">✕</button>
      </div>

      <div id="tog-live-info-bar">
        <div class="tog-room-code-tag">
          <span>Room:</span>
          <strong id="tog-drawer-room-code">${escapeHTML(roomCode || '———')}</strong>
        </div>
      </div>

      <!-- ── Now Watching Movie Card ── -->
      <div id="tog-drawer-movie-card">
        <div class="tog-drawer-movie-header">
          <span class="tog-movie-badge">NOW WATCHING</span>
          <span id="tog-drawer-movie-status-icon">🎬</span>
        </div>
        <div id="tog-drawer-movie-title" class="tog-drawer-movie-title">
          ${isHost ? escapeHTML(getMovieTitle(window.location.href)) : 'Waiting for host…'}
        </div>
        <button id="tog-drawer-switch-btn" class="tog-drawer-switch-btn hidden">
          🎬 Switch to Host's Movie
        </button>
      </div>

      <!-- ── Live Video Call Section ── -->
      <div id="tog-drawer-video-card">
        <div id="tog-webcam-section">
          <div class="tog-video-tile" id="tog-local-tile">
            <video id="tog-local-video" autoplay muted playsinline></video>
            <div class="tog-cam-placeholder" id="tog-local-placeholder">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
              <span>Camera off</span>
            </div>
            <span class="tog-video-label">You</span>
          </div>
          <div class="tog-video-tile" id="tog-remote-tile">
            <video id="tog-remote-video" autoplay playsinline></video>
            <div class="tog-cam-placeholder" id="tog-remote-placeholder">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              <span>Friend</span>
            </div>
            <span class="tog-video-label">Friend</span>
          </div>
        </div>

        <div id="tog-pip-toolbar">
          <button class="tog-ctrl-btn" id="tog-mute-btn" title="Mute / Unmute Microphone">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
              <line x1="8" y1="23" x2="16" y2="23"/>
            </svg>
          </button>
          <button class="tog-ctrl-btn" id="tog-cam-btn" title="Toggle Camera On / Off">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>
            </svg>
          </button>
          <button class="tog-ctrl-btn tog-btn-call" id="tog-call-btn" title="Start Video Call">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.49 12 19.79 19.79 0 0 1 1.45 3.4 2 2 0 0 1 3.42 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.4a16 16 0 0 0 5.69 5.69l.84-.84a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- ── Live Chat Area ── -->
      <div id="tog-chat-messages" role="log" aria-live="polite"></div>

      <!-- ── Emoji Bar ── -->
      <div id="tog-emoji-bar">${emojiButtons}</div>

      <!-- ── Chat Input Row ── -->
      <div id="tog-chat-input-row">
        <textarea id="tog-chat-input" placeholder="Type a message…" rows="1" maxlength="500"></textarea>
        <button id="tog-send-btn" title="Send message">
          <svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>

    <!-- ── Floating Action Button (Toggle Drawer) ── -->
    <button id="tog-toggle-btn" title="Toggle Watch Party Drawer">
      <span id="tog-unread-badge" class="hidden">0</span>
      <svg viewBox="0 0 24 24">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    </button>
  `;
}

function makePipDraggable() {
  const pip = document.getElementById('tog-pip-window');
  const header = document.getElementById('tog-pip-header');
  if (!pip || !header) return;

  let isDragging = false;
  let startX = 0, startY = 0;
  let initialLeft = 0, initialTop = 0;

  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('.tog-pip-icon-btn')) return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = pip.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    pip.style.right = 'auto';
    pip.style.bottom = 'auto';
    pip.style.left = `${initialLeft}px`;
    pip.style.top = `${initialTop}px`;
    pip.style.transition = 'none';

    const onMouseMove = (ev) => {
      if (!isDragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      let newLeft = initialLeft + dx;
      let newTop = initialTop + dy;

      // Clamping within viewport
      const maxLeft = window.innerWidth - pip.offsetWidth - 10;
      const maxTop = window.innerHeight - pip.offsetHeight - 10;
      newLeft = Math.max(10, Math.min(newLeft, maxLeft));
      newTop = Math.max(10, Math.min(newTop, maxTop));

      pip.style.left = `${newLeft}px`;
      pip.style.top = `${newTop}px`;
    };

    const onMouseUp = () => {
      isDragging = false;
      pip.style.transition = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

function attachOverlayListeners() {
  const drawer = document.getElementById('tog-drawer');
  const toggleBtn = document.getElementById('tog-toggle-btn');
  const closeBtn = document.getElementById('tog-drawer-close');
  const badge = document.getElementById('tog-unread-badge');

  function openDrawer() {
    drawerOpen = true;
    drawer?.classList.add('open');
    unreadCount = 0;
    if (badge) {
      badge.textContent = '0';
      badge.classList.add('hidden');
    }
  }

  function closeDrawer() {
    drawerOpen = false;
    drawer?.classList.remove('open');
  }

  // Toggle drawer
  toggleBtn?.addEventListener('click', () => {
    if (drawerOpen) closeDrawer();
    else openDrawer();
  });

  closeBtn?.addEventListener('click', closeDrawer);

  // Close on Escape key
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerOpen) {
      closeDrawer();
    }
  });

  // Movie switch banner & drawer buttons
  function fastNavigate(targetUrl) {
    if (!targetUrl) return;

    // Direct player URL optimization: if movie/show URL, route directly to /watch to skip the overview screen
    let urlToLoad = targetUrl;
    try {
      const u = new URL(targetUrl, window.location.origin);
      if ((u.pathname.includes('/movies/') || u.pathname.includes('/shows/')) && !u.pathname.endsWith('/watch') && !u.pathname.includes('/watch/')) {
        u.pathname = u.pathname.replace(/\/+$/, '') + '/watch';
        urlToLoad = u.toString();
      }
    } catch {}

    // Instant UI feedback
    const drawerSwitchBtn = document.getElementById('tog-drawer-switch-btn');
    const bannerSwitchBtn = document.getElementById('tog-switch-movie-btn');
    if (drawerSwitchBtn) {
      drawerSwitchBtn.innerHTML = '⏳ Loading Movie…';
      drawerSwitchBtn.disabled = true;
    }
    if (bannerSwitchBtn) {
      bannerSwitchBtn.innerHTML = '⏳ Loading…';
      bannerSwitchBtn.disabled = true;
    }

    log('Fast navigating to movie:', urlToLoad);

    // 1. Try instant SPA client-side click if matching link exists on page
    const cleanPath = new URL(urlToLoad, window.location.origin).pathname;
    const existingLink = Array.from(document.querySelectorAll('a')).find((a) => {
      try {
        const href = a.getAttribute('href');
        return href && (href.includes(cleanPath) || cleanPath.includes(href));
      } catch {
        return false;
      }
    });

    if (existingLink) {
      existingLink.click();
      setTimeout(() => {
        // Fallback if SPA click didn't navigate within 120ms
        if (window.location.href !== urlToLoad) {
          window.location.assign(urlToLoad);
        }
      }, 120);
      return;
    }

    // 2. Direct fast assign
    window.location.assign(urlToLoad);
  }

  const onSwitchMovie = () => {
    if (pendingMovieUrl) {
      fastNavigate(pendingMovieUrl);
    }
  };
  document.getElementById('tog-switch-movie-btn')?.addEventListener('click', onSwitchMovie);
  document.getElementById('tog-drawer-switch-btn')?.addEventListener('click', onSwitchMovie);
  document.getElementById('tog-dismiss-movie-btn')?.addEventListener('click', () => {
    document.getElementById('tog-movie-banner')?.classList.add('hidden');
  });

  // Sync banner (guest interaction to satisfy autoplay policy)
  document.getElementById('tog-sync-banner')?.addEventListener('click', () => {
    syncEnabled = true;
    document.getElementById('tog-sync-banner')?.classList.add('hidden');
    if (!isHost) {
      sendWS({ type: 'state-request' });
    }
    log('Sync enabled by user interaction');
  });

  // Desync prompt
  document.getElementById('tog-desync-prompt')?.addEventListener('click', () => {
    document.getElementById('tog-desync-prompt')?.classList.add('hidden');
    if (videoEl) {
      videoEl.play().catch(() => {});
    }
  });

  // Incoming call banner buttons
  document.getElementById('tog-answer-call-btn')?.addEventListener('click', async () => {
    document.getElementById('tog-call-banner')?.classList.add('hidden');
    document.getElementById('tog-call-btn')?.classList.remove('tog-btn-ringing');
    if (pendingOffer) {
      await answerCall(pendingOffer);
    }
  });
  document.getElementById('tog-decline-call-btn')?.addEventListener('click', () => {
    document.getElementById('tog-call-banner')?.classList.add('hidden');
    document.getElementById('tog-call-btn')?.classList.remove('tog-btn-ringing');
    pendingOffer = null;
    sendWS({ type: 'call-ended' });
    appendChatMessage('Declined video call.', 'system');
  });

  // Emoji buttons
  document.getElementById('tog-emoji-bar')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.tog-emoji-btn');
    if (!btn) return;
    const emoji = btn.dataset.emoji;
    sendWS({ type: 'emoji', emoji });
    spawnEmojiFloat(emoji);
  });

  // Chat send
  const chatInput = document.getElementById('tog-chat-input');
  document.getElementById('tog-send-btn')?.addEventListener('click', sendChatMessage);
  chatInput?.addEventListener('keydown', (e) => {
    e.stopPropagation(); // prevent Hotstar video controls from stealing hotkeys (e.g. Space)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });
  chatInput?.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 80) + 'px';
  });
  chatInput?.addEventListener('keyup', (e) => e.stopPropagation());
  chatInput?.addEventListener('keypress', (e) => e.stopPropagation());

  // Stop hotkey propagation on the whole overlay to prevent accidental movie pause/seek
  overlayRoot?.addEventListener('keydown', (e) => e.stopPropagation());

  // WebRTC controls
  document.getElementById('tog-call-btn')?.addEventListener('click', handleCallToggle);
  document.getElementById('tog-drawer-call-btn')?.addEventListener('click', handleCallToggle);
  document.getElementById('tog-mute-btn')?.addEventListener('click', handleMuteToggle);
  document.getElementById('tog-cam-btn')?.addEventListener('click', handleCamToggle);

  // Minimize PiP window toggle
  document.getElementById('tog-pip-minimize-btn')?.addEventListener('click', () => {
    const sec = document.getElementById('tog-webcam-section');
    if (sec) {
      const isHidden = sec.style.display === 'none';
      sec.style.display = isHidden ? 'flex' : 'none';
    }
  });

  // Fullscreen change — reparent overlay
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
}

// ─── Movie / URL sync helpers ────────────────────────────────────────────────

let lastKnownHostUrl   = null;
let lastKnownHostTitle = null;
let lastTrackedUrl     = window.location.href;
let movieSyncInterval  = null;

function getMovieTitle(targetUrl = window.location.href) {
  try {
    const parsed = new URL(targetUrl, window.location.origin);
    const path = parsed.pathname.replace(/\/+$/, '');
    const segments = path.split('/').filter(Boolean);

    // Scan for category keywords in path: movies, shows, clips, tv, sports, series
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i].toLowerCase();
      if (['movies', 'shows', 'clips', 'tv', 'sports', 'series', 'watch'].includes(seg)) {
        for (let j = i + 1; j < segments.length; j++) {
          const nextSeg = segments[j];
          if (nextSeg && !/^\d+$/.test(nextSeg) && nextSeg !== 'watch') {
            return nextSeg
              .replace(/[-_]+/g, ' ')
              .split(' ')
              .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
              .join(' ');
          }
        }
      }
    }
  } catch {}

  // If on active page, check DOM headings
  if (targetUrl === window.location.href) {
    const titleSelectors = [
      '[data-testid="player-title"]',
      '[data-testid*="title"]',
      'h1',
      'h2',
      '.player-title',
      '.tray-title',
      '.movie-title',
      '.watch-title',
    ];
    for (const sel of titleSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) {
        const text = el.textContent.trim();
        if (text.length > 1 && text.length < 80 && !/Disney\+|Hotstar|Upgrade|Home|Search/i.test(text)) {
          return text;
        }
      }
    }

    const docTitle = document.title
      .replace(/\s*[-|•–]\s*(Disney\+?\s*)?Hotstar.*$/i, '')
      .replace(/^Watch\s+/i, '')
      .trim();

    if (docTitle && docTitle.length > 1 && !/Disney\+|Hotstar|Home/i.test(docTitle)) {
      return docTitle;
    }
  }

  if (targetUrl.includes('/in/home') || targetUrl.endsWith('/home') || targetUrl === 'https://www.hotstar.com/' || targetUrl === 'https://hotstar.com/') {
    return 'Hotstar Home';
  }

  return 'Hotstar Video';
}

function normalizeUrl(u) {
  if (!u) return '';
  try {
    const parsed = new URL(u, window.location.origin);
    let path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    path = path.replace(/\/watch$/, '');
    return path;
  } catch {
    return String(u).trim().toLowerCase();
  }
}

function escapeHTML(str) {
  return String(str).replace(/[&<>'"]/g, (tag) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[tag] || tag));
}

let lastRenderedMovieStateKey = '';

function updateDrawerMovieCard(url, title, isHostRole) {
  const titleEl = document.getElementById('tog-drawer-movie-title');
  const switchBtn = document.getElementById('tog-drawer-switch-btn');
  const banner = document.getElementById('tog-movie-banner');
  const bannerText = document.getElementById('tog-movie-text');

  if (!titleEl) return;

  const currentNorm = normalizeUrl(window.location.href);
  const targetNorm  = lastKnownHostUrl ? normalizeUrl(lastKnownHostUrl) : '';
  const hostTitle   = lastKnownHostTitle || (lastKnownHostUrl ? getMovieTitle(lastKnownHostUrl) : "Host's Movie");

  const stateKey = `${isHostRole}|${url}|${title}|${lastKnownHostUrl}|${currentNorm}|${targetNorm}|${hostTitle}`;
  if (stateKey === lastRenderedMovieStateKey) return;
  lastRenderedMovieStateKey = stateKey;

  if (isHostRole) {
    titleEl.innerHTML = `<strong>Watching:</strong> ${escapeHTML(title || 'Hotstar')}`;
    if (switchBtn) switchBtn.classList.add('hidden');
    if (banner) banner.classList.add('hidden');
    return;
  }

  // Guest role
  if (!lastKnownHostUrl) {
    titleEl.innerHTML = `<em>Waiting for host to pick a movie…</em>`;
    if (switchBtn) switchBtn.classList.add('hidden');
    if (banner) banner.classList.add('hidden');
    return;
  }

  if (currentNorm !== targetNorm) {
    pendingMovieUrl = lastKnownHostUrl;
    titleEl.innerHTML = `<span style="color:#f59e0b">Host is on:</span> <strong>${escapeHTML(hostTitle)}</strong>`;
    if (switchBtn) {
      switchBtn.textContent = `🎬 Switch to ${hostTitle}`;
      switchBtn.disabled = false;
      switchBtn.classList.remove('hidden');
    }
    if (bannerText) {
      bannerText.innerHTML = `🎬 Host is watching: <strong>${escapeHTML(hostTitle)}</strong>`;
    }
    if (banner) {
      const bBtn = document.getElementById('tog-switch-movie-btn');
      if (bBtn) bBtn.disabled = false;
      banner.classList.remove('hidden');
    }
  } else {
    pendingMovieUrl = null;
    titleEl.innerHTML = `<span style="color:#10b981">✓ Watching with Host:</span> <strong>${escapeHTML(hostTitle)}</strong>`;
    if (switchBtn) switchBtn.classList.add('hidden');
    if (banner) banner.classList.add('hidden');
  }
}

function broadcastMovieUrlIfNeeded(force = false) {
  if (!isHost || !isInRoom) return;
  const currentUrl = window.location.href;
  const title = getMovieTitle(currentUrl);
  if (force || currentUrl !== lastBroadcastUrl) {
    lastBroadcastUrl = currentUrl;
    sendWS({
      type: 'movie-change',
      url: currentUrl,
      title: title,
      sentAt: Date.now(),
    });
    log('Host broadcasted movie URL:', currentUrl, title);
  }
  updateDrawerMovieCard(currentUrl, title, true);
}

function handleIncomingMovieUrl(targetUrl, targetTitle) {
  if (isHost || !targetUrl) return;
  const isNewUrl = !lastKnownHostUrl || normalizeUrl(lastKnownHostUrl) !== normalizeUrl(targetUrl);
  lastKnownHostUrl = targetUrl;
  if (targetTitle) lastKnownHostTitle = targetTitle;

  if (isNewUrl && targetTitle) {
    appendChatMessage(`🎬 Host switched to: ${targetTitle}`, 'system');
  }

  checkMovieUrlMatch();
}

function checkMovieUrlMatch() {
  if (isHost || !isInRoom) return;
  if (!overlayRoot) {
    injectOverlay();
  }
  updateDrawerMovieCard(lastKnownHostUrl, lastKnownHostTitle, false);
}

function startMovieSyncMonitor() {
  if (movieSyncInterval) clearInterval(movieSyncInterval);
  movieSyncInterval = setInterval(() => {
    if (!isInRoom || !chrome.runtime?.id) return;

    const currentUrl = window.location.href;
    if (currentUrl !== lastTrackedUrl) {
      lastTrackedUrl = currentUrl;
      log('SPA Navigation detected:', currentUrl);
      if (isHost) {
        broadcastMovieUrlIfNeeded(true);
      } else {
        checkMovieUrlMatch();
      }
    }

    if (isHost) {
      broadcastMovieUrlIfNeeded(false);
    } else {
      checkMovieUrlMatch();
    }
  }, 500);
}

function hookSpaNavigation() {
  if (window._togSpaHooked) return;
  window._togSpaHooked = true;

  window.addEventListener('popstate', onUrlOrNavChange);
  window.addEventListener('hashchange', onUrlOrNavChange);
}

function onUrlOrNavChange() {
  if (!isInRoom) return;
  if (isHost) {
    broadcastMovieUrlIfNeeded(true);
  } else {
    checkMovieUrlMatch();
  }
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

let isAttachingVideo = false;

function startVideoObserver() {
  if (videoObserver) {
    videoObserver.disconnect();
    videoObserver = null;
  }
  hookSpaNavigation();

  function tryAttach() {
    if (isAttachingVideo || !chrome.runtime?.id) return;
    isAttachingVideo = true;

    try {
      const v = findMainVideo();
      if (v && v !== videoEl) {
        videoEl = v;
        attachVideoListeners(v);
        log('Main Hotstar video element attached:', v);
        if (!isHost) {
          sendWS({ type: 'state-request' });
        }
      }
    } finally {
      isAttachingVideo = false;
    }
  }

  tryAttach();

  let attachScheduled = false;
  videoObserver = new MutationObserver(() => {
    if (!attachScheduled) {
      attachScheduled = true;
      requestAnimationFrame(() => {
        attachScheduled = false;
        tryAttach();
      });
    }
  });

  if (document.body) {
    videoObserver.observe(document.body, { childList: true, subtree: true });
  }

  if (window._togVideoCheckInterval) {
    clearInterval(window._togVideoCheckInterval);
  }
  window._togVideoCheckInterval = setInterval(tryAttach, 1000);
}

function attachVideoListeners(v) {
  if (v._togListenersAttached) return;
  v._togListenersAttached = true;

  v.addEventListener('play',       onVideoPlay);
  v.addEventListener('pause',      onVideoPause);
  v.addEventListener('seeking',    onVideoSeeking);
  v.addEventListener('seeked',     onVideoSeeked);
  v.addEventListener('ratechange', onVideoRateChange);
  log('Hooked play/pause/seeking/seeked/ratechange listeners to main video');
}

// ─── Playback sync — host side ────────────────────────────────────────────────

function onVideoPlay() {
  if (!isHost || !isInRoom || isSyncing || isInAdBreak) return;
  sendWS({
    type: 'sync',
    action: 'play',
    currentTime: videoEl.currentTime,
    rate: videoEl.playbackRate,
    url: window.location.href,
    title: getMovieTitle(),
    sentAt: Date.now(),
  });
}

function onVideoPause() {
  if (!isHost || !isInRoom || isSyncing || isInAdBreak) return;
  sendWS({
    type: 'sync',
    action: 'pause',
    currentTime: videoEl.currentTime,
    rate: videoEl.playbackRate,
    url: window.location.href,
    title: getMovieTitle(),
    sentAt: Date.now(),
  });
}

function onVideoSeeking() {
  if (!isHost || !isInRoom || isSyncing || isInAdBreak) return;
  sendWS({
    type: 'sync',
    action: 'seek',
    currentTime: videoEl.currentTime,
    rate: videoEl.playbackRate,
    url: window.location.href,
    title: getMovieTitle(),
    sentAt: Date.now(),
  });
}

function onVideoSeeked() {
  if (!isHost || !isInRoom || isSyncing || isInAdBreak) return;
  sendWS({
    type: 'sync',
    action: 'seek',
    currentTime: videoEl.currentTime,
    rate: videoEl.playbackRate,
    url: window.location.href,
    title: getMovieTitle(),
    sentAt: Date.now(),
  });
}

function onVideoRateChange() {
  if (!isHost || !isInRoom || isSyncing || isInAdBreak) return;
  sendWS({
    type: 'sync',
    action: 'ratechange',
    rate: videoEl.playbackRate,
    currentTime: videoEl.currentTime,
    url: window.location.href,
    title: getMovieTitle(),
    sentAt: Date.now(),
  });
}

// ─── Clock Skew & Network Latency Calibration (NTP Algorithm) ─────────────────

function startClockSync() {
  if (isHost || !isInRoom) return;
  clearInterval(clockSyncInterval);
  clockSyncInterval = setInterval(() => {
    if (!isInRoom || isHost || !chrome.runtime?.id) return;
    sendWS({
      type: 'clock-ping',
      t0: Date.now(),
    });
  }, 2000);

  // Initial immediate burst of 3 pings for instant clock calibration
  sendWS({ type: 'clock-ping', t0: Date.now() });
  setTimeout(() => sendWS({ type: 'clock-ping', t0: Date.now() }), 300);
  setTimeout(() => sendWS({ type: 'clock-ping', t0: Date.now() }), 600);
}

function handleClockPing(message) {
  if (!isHost) return;
  sendWS({
    type: 'clock-pong',
    t0: message.t0,
    t1: Date.now(),
  });
}

function handleClockPong(message) {
  if (isHost) return;
  const t3 = Date.now();
  const t0 = message.t0;
  const t1 = message.t1;
  if (!t0 || !t1) return;

  const rtt = Math.max(t3 - t0, 0);
  const offset = t1 - (t0 + rtt / 2);

  clockSyncSamples.push(offset);
  if (clockSyncSamples.length > 7) clockSyncSamples.shift();

  // Median filtering to eliminate random network latency jitter
  const sorted = [...clockSyncSamples].sort((a, b) => a - b);
  clockOffsetMs = sorted[Math.floor(sorted.length / 2)];
}

function getCorrectedHostTime(hostTime, sentAt, hostPaused, hostRate) {
  const baseRate = (typeof hostRate === 'number' && hostRate > 0) ? hostRate : (hostPlaybackRate || 1.0);
  if (!sentAt) return hostTime;

  const now = Date.now();
  // Time elapsed in Host's clock domain since host dispatched the event
  const hostNowEstimate = now + clockOffsetMs;
  const elapsedSeconds = Math.max((hostNowEstimate - sentAt) / 1000, 0);

  // If paused, host position didn't advance; if playing, advance by exact elapsed seconds * playback speed
  return hostPaused ? hostTime : (hostTime + (elapsedSeconds * baseRate));
}

// ─── Playback sync — guest side (ultra-low latency) ──────────────────────────

function applySync(action, currentTime, sentAt, rate) {
  if (!videoEl || isInAdBreak) return;

  if (typeof rate === 'number' && rate > 0) {
    hostPlaybackRate = rate;
  }
  const baseRate = hostPlaybackRate || 1.0;
  const targetTime = getCorrectedHostTime(currentTime, sentAt, action === 'pause', baseRate);

  isSyncing = true;
  try {
    if (Math.abs(videoEl.currentTime - targetTime) > 0.015) {
      videoEl.currentTime = targetTime;
    }

    if (action === 'play') {
      if (videoEl.playbackRate !== baseRate) {
        videoEl.playbackRate = baseRate;
      }
      const playPromise = videoEl.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          log('Guest autoplay prevented:', err.message);
          document.getElementById('tog-desync-prompt')?.classList.remove('hidden');
        });
      }
    } else if (action === 'pause') {
      if (!videoEl.paused) videoEl.pause();
      videoEl.currentTime = targetTime;
    } else if (action === 'seek' || action === 'ratechange') {
      if (videoEl.playbackRate !== baseRate) {
        videoEl.playbackRate = baseRate;
      }
    }
  } finally {
    setTimeout(() => { isSyncing = false; }, 40);
  }
}

// ─── Frame-accurate drift correction (host heartbeat → guest PID nudge) ─────

function startDriftHeartbeat() {
  if (!isHost) return;
  clearInterval(driftInterval);
  driftInterval = setInterval(() => {
    if (!chrome.runtime?.id) {
      cleanupOrphanedScript();
      return;
    }
    broadcastMovieUrlIfNeeded();
    if (!videoEl || isInAdBreak) return;
    sendWS({
      type: 'drift-heartbeat',
      currentTime: videoEl.currentTime,
      paused: videoEl.paused,
      rate: videoEl.playbackRate,
      url: window.location.href,
      title: getMovieTitle(),
      sentAt: Date.now(),
    });
  }, DRIFT_HEARTBEAT_INTERVAL_MS);
}

function stopDriftHeartbeat() {
  if (driftInterval) {
    clearInterval(driftInterval);
    driftInterval = null;
  }
}

function applyDriftCorrection(hostTime, sentAt, hostPaused, hostRate) {
  if (!videoEl || isHost || isInAdBreak || isSyncing) return;

  if (typeof hostRate === 'number' && hostRate > 0) {
    hostPlaybackRate = hostRate;
  }
  const baseRate = hostPlaybackRate || 1.0;
  const correctedHostTime = getCorrectedHostTime(hostTime, sentAt, hostPaused, baseRate);

  // 1. Correct paused/playing state if mismatched
  if (typeof hostPaused === 'boolean') {
    if (hostPaused && !videoEl.paused) {
      isSyncing = true;
      videoEl.pause();
      videoEl.currentTime = correctedHostTime;
      setTimeout(() => { isSyncing = false; }, 40);
      return;
    } else if (!hostPaused && videoEl.paused && syncEnabled) {
      isSyncing = true;
      videoEl.currentTime = correctedHostTime;
      videoEl.playbackRate = baseRate;
      videoEl.play().catch(() => {});
      setTimeout(() => { isSyncing = false; }, 40);
      return;
    }
  }

  // If host is paused, snap exactly to host position
  if (hostPaused && videoEl.paused) {
    if (Math.abs(videoEl.currentTime - correctedHostTime) > 0.010) {
      videoEl.currentTime = correctedHostTime;
    }
    return;
  }

  const diff = Math.abs(videoEl.currentTime - correctedHostTime);

  // Sub-frame tolerance (< 12ms / ~0.7 frame at 60fps) — considered in perfect frame-lock
  if (diff < DRIFT_NUDGE_THRESHOLD) {
    if (videoEl.playbackRate !== baseRate) {
      videoEl.playbackRate = baseRate;
    }
    return;
  }

  // Hard seek (if drift > 120ms) — instant sub-second snap seek
  if (diff > DRIFT_HARD_SEEK_THRESHOLD) {
    isSyncing = true;
    videoEl.currentTime = correctedHostTime;
    if (videoEl.playbackRate !== baseRate) videoEl.playbackRate = baseRate;
    setTimeout(() => { isSyncing = false; }, 40);
    log(`Frame-accurate lock (hard seek): Δ${diff.toFixed(3)}s`);
  } else {
    // Proportional Micro-nudge (12ms - 120ms):
    // Smoothly speed up or slow down by 1-6% to close the gap seamlessly
    const isLagging = correctedHostTime > videoEl.currentTime;
    const rateDelta = Math.min(diff * 0.9, 0.06); // micro adjustment without pitch distortion
    const targetRate = isLagging ? (baseRate + rateDelta) : Math.max(baseRate - rateDelta, 0.85);

    videoEl.playbackRate = targetRate;

    clearTimeout(videoEl._togNudgeTimeout);
    videoEl._togNudgeTimeout = setTimeout(() => {
      if (videoEl && !isSyncing) videoEl.playbackRate = baseRate;
    }, 180);
  }
}

// ─── Ad break detection & auto-skip ──────────────────────────────────────────

let adCheckInterval = null;

function isAdOverlayPresent() {
  const adSelectors = [
    '[data-testid*="ad-container"]',
    '[data-testid*="adContainer"]',
    '[data-testid*="advertisement"]',
    '[data-testid*="ad_"]',
    '.ad-container',
    '.ad-badge',
    '.ad-timer',
    '.ad-countdown',
    '[class*="adContainer"]',
    '[class*="ad-container"]',
    '[class*="adOverlay"]',
    '[class*="AdOverlay"]',
    '[class*="ad-overlay"]',
    '[class*="adBadge"]',
    '[class*="ad-badge"]',
    '[class*="adTimer"]',
    '[class*="ad-timer"]',
    '[class*="adCountdown"]',
    '[class*="video-ad"]',
    '[class*="shaka-ad"]',
    '[aria-label*="Advertisement"]',
  ];

  for (const sel of adSelectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null && !el.closest('#together-overlay-root')) {
      return true;
    }
  }

  // Also check if player has text indicating an ad
  const adTextTags = document.querySelectorAll('span, p, div');
  for (const t of adTextTags) {
    if (t.closest('#together-overlay-root') || t.offsetParent === null) continue;
    const txt = t.textContent.trim();
    if (/^Ad\s*[:•·]\s*\d+/i.test(txt) || /^Ad\s+\d+\s+of\s+\d+/i.test(txt) || /^Advertisement/i.test(txt)) {
      return true;
    }
  }

  return false;
}

function trySkipOrDismissAd() {
  const skipSelectors = [
    '[data-testid*="skip-ad"]',
    '[data-testid*="skip"]',
    '[data-testid*="ad-skip"]',
    '[class*="skip-ad"]',
    '[class*="skipAd"]',
    '[class*="skip_ad"]',
    '[class*="ad-skip"]',
    '[class*="adSkip"]',
    '[class*="skip-button"]',
    '[class*="skipButton"]',
    '[class*="skipBtn"]',
    '[class*="video-ad-skip"]',
    '[aria-label*="Skip Ad"]',
    '[aria-label*="Skip ad"]',
    '[aria-label*="Skip"]',
    'button.skip',
    '.skip-btn',
    '.ad-skip-btn',
  ];

  for (const sel of skipSelectors) {
    const btn = document.querySelector(sel);
    if (btn && btn.offsetParent !== null && !btn.closest('#together-overlay-root')) {
      log('Auto-clicking Ad Skip button:', btn);
      btn.click();
      return true;
    }
  }

  // Check buttons/clickable elements with "Skip" text
  const allClickables = Array.from(document.querySelectorAll('button, div[role="button"], a, span[role="button"]'));
  for (const el of allClickables) {
    if (el.closest('#together-overlay-root') || el.offsetParent === null) continue;
    const txt = el.textContent.trim().toLowerCase();
    if (txt === 'skip ad' || txt === 'skip' || txt === 'skip advertisement' || txt.startsWith('skip ad') || txt === 'close ad') {
      log('Auto-clicking Ad text button:', el);
      el.click();
      return true;
    }
  }

  return false;
}

function startAdDetection() {
  function checkAdState() {
    if (!isInRoom || !chrome.runtime?.id) return;

    const nowInAd = isAdOverlayPresent();

    if (nowInAd) {
      // While in ad, attempt to skip / close the ad as soon as time runs out
      trySkipOrDismissAd();
    }

    if (nowInAd !== isInAdBreak) {
      isInAdBreak = nowInAd;
      log(isInAdBreak ? '🎬 Ad break started — sync paused' : '✅ Ad break ended — sync resumed');

      if (!isInAdBreak) {
        if (isHost && videoEl) {
          // Host resumes: broadcast state to guest
          setTimeout(() => {
            sendWS({
              type: 'sync',
              action: videoEl.paused ? 'pause' : 'play',
              currentTime: videoEl.currentTime,
              sentAt: Date.now(),
            });
          }, 800);
        } else if (!isHost) {
          // Guest finishes ad: request current host state to jump straight to the movie
          setTimeout(() => {
            sendWS({ type: 'state-request' });
            if (videoEl && videoEl.paused && syncEnabled) {
              videoEl.play().catch(() => {});
            }
          }, 300);
        }
      }
    }
  }

  if (adObserver) {
    adObserver.disconnect();
    adObserver = null;
  }

  let checkScheduled = false;
  adObserver = new MutationObserver(() => {
    if (!checkScheduled) {
      checkScheduled = true;
      requestAnimationFrame(() => {
        checkScheduled = false;
        checkAdState();
      });
    }
  });

  if (document.body) {
    adObserver.observe(document.body, { childList: true, subtree: true });
  }

  if (adCheckInterval) clearInterval(adCheckInterval);
  adCheckInterval = setInterval(checkAdState, 350);

  checkAdState();
}

function stopAdDetection() {
  if (adObserver) {
    adObserver.disconnect();
    adObserver = null;
  }
  if (adCheckInterval) {
    clearInterval(adCheckInterval);
    adCheckInterval = null;
  }
  isInAdBreak = false;
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

  // If chat message from peer arrived while drawer is closed, increment unread badge
  if (!drawerOpen && who !== 'mine' && who !== 'system') {
    unreadCount++;
    const badge = document.getElementById('tog-unread-badge');
    if (badge) {
      badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
      badge.classList.remove('hidden');
    }
  }
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
  if (pendingOffer) {
    document.getElementById('tog-call-banner')?.classList.add('hidden');
    document.getElementById('tog-call-btn')?.classList.remove('tog-btn-ringing');
    await answerCall(pendingOffer);
    return;
  }

  if (pc && pc.connectionState === 'connected') {
    endCall(true);
  } else if (pc) {
    endCall(true);
  } else {
    await startCall();
  }
}

async function getLocalMediaStream() {
  if (localStream && localStream.getTracks().some((t) => t.readyState === 'live')) {
    return localStream;
  }
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
    log('Remote track received:', e.track.kind, e.track.id);
    if (e.streams && e.streams[0]) {
      remoteStream = e.streams[0];
    } else {
      if (!remoteStream) remoteStream = new MediaStream();
      if (!remoteStream.getTracks().some((t) => t.id === e.track.id)) {
        remoteStream.addTrack(e.track);
      }
    }
    showRemoteStream(remoteStream);

    e.track.onunmute = () => {
      log('Remote track unmuted:', e.track.kind);
      showRemoteStream(remoteStream);
    };
  });

  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate) {
      const cand = e.candidate.toJSON ? e.candidate.toJSON() : {
        candidate: e.candidate.candidate,
        sdpMid: e.candidate.sdpMid,
        sdpMLineIndex: e.candidate.sdpMLineIndex,
        usernameFragment: e.candidate.usernameFragment,
      };
      sendWS({ type: 'ice-candidate', candidate: cand });
    }
  });

  pc.addEventListener('connectionstatechange', () => {
    log('WebRTC connection state:', pc.connectionState);
    if (pc.connectionState === 'connected') {
      appendChatMessage('Video call connected!', 'system');
      document.getElementById('tog-call-btn')?.classList.add('active');
      document.getElementById('tog-call-btn')?.classList.remove('tog-btn-ringing');
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
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    sendWS({
      type: 'offer',
      sdp: { type: offer.type, sdp: offer.sdp },
    });
    log('Offer sent');
    appendChatMessage('Calling friend...', 'system');
    const callBtn = document.getElementById('tog-call-btn');
    if (callBtn) {
      callBtn.classList.add('active');
      callBtn.setAttribute('title', 'End Video Call');
    }
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
  pendingOffer = null;
  showLocalStream(null);
  showRemoteStream(null);

  const callBtn = document.getElementById('tog-call-btn');
  if (callBtn) {
    callBtn.classList.remove('active');
    callBtn.classList.remove('tog-btn-ringing');
    callBtn.setAttribute('title', 'Start Video Call');
  }
  document.getElementById('tog-cam-btn')?.classList.remove('active');
  document.getElementById('tog-mute-btn')?.classList.remove('active');
  document.getElementById('tog-call-banner')?.classList.add('hidden');
  log('Call ended');

  if (notifyPeer) {
    sendWS({ type: 'call-ended' });
  }
}

function showLocalStream(stream) {
  const video       = document.getElementById('tog-local-video');
  const placeholder = document.getElementById('tog-local-placeholder');
  if (!video) return;

  if (stream && stream.getTracks().length > 0) {
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
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

  if (stream && stream.getTracks().length > 0) {
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    if (placeholder) placeholder.style.display = 'none';
    video.style.display = 'block';

    const p = video.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        log('Remote video autoplay blocked, muting to display video:', err);
        video.muted = true;
        video.play().catch(() => {});
        const unmute = () => {
          video.muted = false;
          document.removeEventListener('click', unmute);
          document.removeEventListener('keydown', unmute);
        };
        document.addEventListener('click', unmute, { once: true });
        document.addEventListener('keydown', unmute, { once: true });
      });
    }
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
  document.getElementById('tog-mute-btn').classList.toggle('muted', !track.enabled);
}

function handleCamToggle() {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;

  track.enabled = !track.enabled;
  document.getElementById('tog-cam-btn').classList.toggle('muted', !track.enabled);

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
    case 'room-state':
    case 'room-created':
    case 'joined':
    case 'reconnected':
      roomCode      = message.roomCode;
      participantId = message.participantId;
      isHost        = message.isHost;
      isInRoom      = true;

      injectOverlay();
      const drawerRoomEl = document.getElementById('tog-drawer-room-code');
      if (drawerRoomEl) drawerRoomEl.textContent = roomCode || '———';

      startVideoObserver();
      startAdDetection();
      startMovieSyncMonitor();

      if (isHost) {
        startDriftHeartbeat();
        broadcastMovieUrlIfNeeded(true);
        appendChatMessage('Room created. Share the code!', 'system');
      } else {
        startClockSync();
        if (message.movieUrl) {
          handleIncomingMovieUrl(message.movieUrl, message.movieTitle);
        }
        sendWS({ type: 'state-request' });
        appendChatMessage('Joined room! Ready to watch together.', 'system');
      }

      if (message.type === 'reconnected') {
        appendChatMessage('Reconnected to room.', 'system');
      }
      break;

    case 'you-are-host':
      isHost = true;
      if (clockSyncInterval) {
        clearInterval(clockSyncInterval);
        clockSyncInterval = null;
      }
      startDriftHeartbeat();
      broadcastMovieUrlIfNeeded(true);
      appendChatMessage('You are now the host.', 'system');
      break;

    case 'peer-joined':
      appendChatMessage('Friend joined the room!', 'system');
      if (isHost) {
        broadcastMovieUrlIfNeeded(true);
      }
      break;

    case 'peer-reconnected':
      appendChatMessage('Friend reconnected.', 'system');
      if (isHost) {
        broadcastMovieUrlIfNeeded(true);
      }
      break;

    case 'peer-disconnected':
      appendChatMessage('Friend disconnected.', 'system');
      break;

    case 'left-room':
      isInRoom = false;
      roomCode = null;
      participantId = null;
      isHost = false;
      stopDriftHeartbeat();
      stopAdDetection();
      if (movieSyncInterval) {
        clearInterval(movieSyncInterval);
        movieSyncInterval = null;
      }
      if (clockSyncInterval) {
        clearInterval(clockSyncInterval);
        clockSyncInterval = null;
      }
      if (overlayRoot) {
        overlayRoot.remove();
        overlayRoot = null;
      }
      const syncBanner = document.getElementById('tog-sync-banner');
      if (syncBanner) syncBanner.remove();
      const movieBanner = document.getElementById('tog-movie-banner');
      if (movieBanner) movieBanner.remove();
      endCall(false);
      log('Left room');
      break;

    // ── Server asks us to send state snapshot (for reconnected guest) ──────
    case 'send-state-snapshot':
      if (isHost) {
        sendWS({
          type: 'state-snapshot',
          currentTime: videoEl ? videoEl.currentTime : 0,
          paused: videoEl ? videoEl.paused : true,
          rate: videoEl ? videoEl.playbackRate : 1.0,
          url: window.location.href,
          title: getMovieTitle(),
          sentAt: Date.now(),
        });
        log('Host dispatched state snapshot to guest:', window.location.href);
      }
      break;

    // ── Server asks guest to request state ─────────────────────────────────
    case 'request-state':
      sendWS({ type: 'state-request' });
      break;

    // ── Movie change broadcast from host ──────────────────────────────────
    case 'movie-change':
      if (!isHost && message.url) {
        handleIncomingMovieUrl(message.url, message.title);
      }
      break;

    // ── Incoming state snapshot (for guest on join/reconnect) ──────────────
    case 'state-snapshot':
      if (!isHost) {
        if (message.url) {
          handleIncomingMovieUrl(message.url, message.title);
        }
        applySync(message.paused ? 'pause' : 'play', message.currentTime, message.sentAt, message.rate);
      }
      break;

    // ── Playback sync ───────────────────────────────────────────────────────
    case 'sync':
      if (isHost) break; // server already validated, but double-guard
      if (message.url) {
        handleIncomingMovieUrl(message.url, message.title);
      }
      if (!syncEnabled) break;
      applySync(message.action, message.currentTime, message.sentAt, message.rate);
      break;

    // ── Drift heartbeat ─────────────────────────────────────────────────────
    case 'drift-heartbeat':
      if (!isHost) {
        if (message.url) {
          handleIncomingMovieUrl(message.url, message.title);
        }
        if (syncEnabled) {
          applyDriftCorrection(message.currentTime, message.sentAt, message.paused, message.rate);
        }
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

    // ── Clock Synchronization ────────────────────────────────────────────────
    case 'clock-ping':
      handleClockPing(message);
      break;

    case 'clock-pong':
      handleClockPong(message);
      break;
  }
});

// ─── WebRTC signaling handlers ────────────────────────────────────────────────

async function handleIncomingOffer(message) {
  log('Received incoming call offer');

  // Handle glare collision (both clicked call around the same time)
  if (pc && pc.signalingState !== 'stable') {
    if (isHost) {
      log('Glare detected: Host is impolite peer, ignoring guest offer');
      return;
    }
    log('Glare detected: Guest is polite peer, rolling back local offer to accept host offer');
    try {
      await pc.setLocalDescription({ type: 'rollback' });
    } catch (e) {
      log('Rollback error:', e);
    }
  }

  pendingOffer = message;

  // If local stream is already active (user turned on cam / clicked call), auto-answer immediately
  if (localStream && localStream.getTracks().some((t) => t.readyState === 'live')) {
    await answerCall(message);
  } else {
    document.getElementById('tog-call-banner')?.classList.remove('hidden');
    document.getElementById('tog-call-btn')?.classList.add('tog-btn-ringing');
    appendChatMessage('📞 Friend is calling you... Click "Answer" or the Call button to connect video.', 'system');
  }
}

async function answerCall(offerMessage) {
  pendingOffer = null;
  document.getElementById('tog-call-banner')?.classList.add('hidden');
  document.getElementById('tog-call-btn')?.classList.remove('tog-btn-ringing');
  log('Answering video call...');

  try {
    localStream = await getLocalMediaStream();
    showLocalStream(localStream);
  } catch (err) {
    log('Could not get local stream on answer call:', err);
    appendChatMessage('Could not access camera/mic: ' + (err.message || 'Permission denied'), 'system');
  }

  await setupPeerConnection();

  try {
    const sdpObj = offerMessage.sdp?.sdp ? offerMessage.sdp : { type: offerMessage.sdp?.type || 'offer', sdp: offerMessage.sdp?.sdp || offerMessage.sdp };
    await pc.setRemoteDescription(new RTCSessionDescription(sdpObj));
    await flushIceCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendWS({
      type: 'answer',
      sdp: { type: answer.type, sdp: answer.sdp },
    });
    log('Answer sent');
    appendChatMessage('Connected to video call.', 'system');
    const callBtn = document.getElementById('tog-call-btn');
    if (callBtn) {
      callBtn.classList.add('active');
      callBtn.setAttribute('title', 'End Video Call');
    }
  } catch (err) {
    log('Handle offer failed:', err);
    appendChatMessage('Failed to answer call.', 'system');
  }
}

async function handleIncomingAnswer(message) {
  if (!pc) return;
  try {
    const sdpObj = message.sdp?.sdp ? message.sdp : { type: message.sdp?.type || 'answer', sdp: message.sdp?.sdp || message.sdp };
    await pc.setRemoteDescription(new RTCSessionDescription(sdpObj));
    await flushIceCandidates();
    log('Answer received, remote description set');
  } catch (err) {
    log('Handle answer failed:', err);
  }
}

async function handleIncomingIce(message) {
  if (!message.candidate) return;
  if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
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
  if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) return;
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
  const drawerRoomEl = document.getElementById('tog-drawer-room-code');
  if (drawerRoomEl) drawerRoomEl.textContent = roomCode || '———';

  startVideoObserver();
  startAdDetection();
  startMovieSyncMonitor();

  if (isHost) {
    startDriftHeartbeat();
    broadcastMovieUrlIfNeeded(true);
  } else {
    startClockSync();
    if (data.movieUrl) {
      handleIncomingMovieUrl(data.movieUrl, data.movieTitle);
    }
  }

  // Ask for fresh state from host
  sendWS({ type: 'state-request' });
  log('Restored room session:', roomCode, 'isHost:', isHost);
}

// Start watching for video elements immediately on page load
startVideoObserver();

// Restore state if already in a room (e.g. page reload or navigation within active session)
try {
  if (chrome.runtime?.id && chrome.storage?.session) {
    chrome.storage.session.get(['roomCode', 'participantId', 'isHost', 'movieUrl', 'movieTitle'], (data) => {
      if (chrome.runtime?.id && data && data.roomCode) {
        initRoom(data);
      } else if (chrome.runtime?.id) {
        sendToBackground({ type: 'get-room-state' });
      }
    });
  } else if (chrome.runtime?.id) {
    sendToBackground({ type: 'get-room-state' });
  }
} catch {}
