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

## 👫 Sharing with Your friend (Cross-Computer Setup)

The cloud signaling server is already live at `wss://together-online-video-call.onrender.com`. You can connect with your partner from anywhere in the world in under a minute!

### Step 1: Send the Extension to Your friend
Send them the `together-extension.zip` file (or zip the `extension/` folder).

### Step 2: Install on Your friend's Computer
1. Have your friend extract `together-extension.zip` to a folder (e.g. on Desktop).
2. In Google Chrome (or Edge/Brave), open `chrome://extensions`.
3. Turn on the **Developer mode** toggle in the top-right corner.
4. Click **Load unpacked** (top-left) and select the extracted `extension` folder.
5. Click the puzzle icon (Extensions) in Chrome's top bar and **pin 📌 Together**.

---

## 🍿 How to Watch Together

1. **Host (You)**:
   - Open Hotstar and start any movie or episode.
   - Click the **Together** extension icon in Chrome.
   - Click **Create Room** — you will get a 6-character room code (e.g. `ABC123`).
   - Share this code with your partner over chat/call.

2. **Guest (Your Partner)**:
   - Open Hotstar in their browser.
   - Click the **Together** extension icon.
   - Paste the code into **Room Code** and click **Join Room**.
   - Hotstar will automatically navigate and sync to the movie you're watching!

3. **Enjoying the Experience**:
   - 📞 **Video & Audio Call**: Click the call button in the floating PiP toolbar to see and talk to each other.
   - ⏯️ **Instant Sync**: When either of you pauses, plays, or seeks, both screens react instantly.
   - 🍿 **Ad Alert**: If either of you hits an ad, click the `🍿` button so your partner can pause with 1 click.
   - ❤️ **Reactions & Chat**: Send floating hearts, emojis, and instant messages.

---

## Technical Stack & Architecture

- **Signaling**: WebSockets over HTTPS (`wss://together-online-video-call.onrender.com`) hosted on Render.
- **Audio/Video**: Direct Peer-to-Peer WebRTC with STUN NAT traversal.
- **Playback Sync**: Ultra-low latency event relay (<200ms) with NTP clock drift calibration.
- **UI**: Glassmorphic draggable & resizable PiP floating window, Shadow-DOM isolated.

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
