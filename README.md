# Together — Hotstar Watch Party

A Chrome Extension (Manifest V3) that lets **two people** watch Hotstar together with:
- 🔄 Synced play / pause / seek
- 💬 Text chat
- 📹 Webcam video chat (WebRTC, direct peer-to-peer)
- 🎉 Emoji reactions

> **Personal use tool.** Read Hotstar's Terms of Service before sharing publicly.

---

## Project Structure

```
together/
├── server/              ← Node.js signaling server
│   ├── index.js
│   ├── package.json
│   ├── Dockerfile
│   └── render.yaml      ← One-click Render.com deploy
└── extension/           ← Chrome Extension (MV3)
    ├── manifest.json
    ├── background.js    ← Service worker (message router)
    ├── offscreen.html/js← Persistent WebSocket host
    ├── popup.html/js/css← Create / Join room UI
    ├── content_script.js← Injected into Hotstar — all sync/chat/video logic
    ├── overlay.css      ← Overlay styles (CSP-safe, no inline styles)
    ├── webrtc_bridge.html/js ← Extension-scoped camera permission
    └── icons/
```

---

## Setup

### 1. Deploy the Signaling Server

**Option A: Render.com (recommended, free tier)**
1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New Web Service → connect your repo
3. Render auto-detects `render.yaml` and configures everything
4. Copy the deployed URL: `wss://your-app.onrender.com`

**Option B: Run locally** (for dev testing — needs TLS for `wss://`)
```bash
# Install mkcert for local TLS
# https://github.com/FiloSottile/mkcert
mkcert -install
mkcert localhost

cd server
npm install
node index.js
```

> ⚠️ Chrome blocks `ws://` from HTTPS pages (Hotstar). You **must** use `wss://` in production.  
> For local dev, either use mkcert TLS or deploy to Render first, then point the extension at the deployed URL.

### 2. Configure the Extension

Open `extension/offscreen.js` and set your signaling server URL:

```js
const SIGNALING_SERVER_URL = 'wss://your-app.onrender.com';
```

**For WebRTC (Stage 6):** Get a free TURN server from [metered.ca](https://metered.ca) and add your credentials in `extension/content_script.js`:

```js
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: 'turn:YOUR_TURN_SERVER:3478',
    username: 'YOUR_USERNAME',
    credential: 'YOUR_CREDENTIAL',
  },
];
```

### 3. Load the Extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer Mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. Pin the "Together" extension to your toolbar

---

## Testing (Two Chrome Profiles)

1. Create two Chrome profiles: `chrome://settings/manageProfile`
2. Load the unpacked extension in **both** profiles
3. Open Hotstar in both and log in
4. **Profile 1**: Click the extension icon → **Create Room** → copy the 6-character code
5. **Profile 2**: Click the extension icon → **Join Room** → paste the code

> ✅ Test that the connection survives sitting idle for **2+ minutes** (MV3 offscreen document keepalive validation).

---

## Key Technical Notes

| Issue | Solution |
|---|---|
| MV3 SW idle-kill | WebSocket lives in offscreen document, not service worker |
| `ws://` blocked on HTTPS | Always use `wss://` (Render/Railway give you this free) |
| Autoplay policy | Guest clicks "Join & Enable Sync" first; `.play()` rejects are caught |
| SPA video swap | `MutationObserver` re-attaches to `<video>` on each replacement |
| Drift over time | Host heartbeat every 7s; guest uses `playbackRate` nudge or hard seek |
| Ad breaks | DOM class observation pauses sync during ads |
| Camera permissions | `getUserMedia` called from `webrtc_bridge.html` (extension origin, not hotstar.com) |
| Fullscreen | Overlay reparented into fullscreen element on `fullscreenchange` |
| XSS in chat | All messages rendered with `textContent`, never `innerHTML` |
| Host spoofing | Server validates sender ID against `hostId` before relaying `sync` events |

---

## Server API

The signaling server accepts WebSocket connections and routes these events:

| Event | Direction | Description |
|---|---|---|
| `create` | Client → Server | Create a new room |
| `join` | Client → Server | Join existing room (with optional `participantId` for reconnect) |
| `sync` | Host → Guest | Play/pause/seek with `currentTime` |
| `drift-heartbeat` | Host → Guest | Periodic time sync for drift correction |
| `chat` | Both ways | Text message |
| `emoji` | Both ways | Emoji reaction |
| `offer` / `answer` / `ice-candidate` | Both ways | WebRTC signaling |
| `state-request` / `state-snapshot` | Both ways | Snapshot sync on reconnect |

---

## Ad Break Detection

Hotstar's ad detection uses DOM class inspection. If sync breaks during ads, open DevTools on Hotstar and inspect the player container for ad-specific classes/attributes, then update the `AD_CLASS_PATTERNS` array in `content_script.js`.
