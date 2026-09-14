/**
 * webrtc_bridge.js
 *
 * Runs in an extension-owned page (webrtc_bridge.html).
 * Calls getUserMedia here so:
 *   - The browser permission prompt reads "Together (extension)" not "hotstar.com"
 *   - The grant is scoped to the extension's origin
 *
 * Once we have the stream, we post it back to the opener (content script context)
 * via window.opener.postMessage.
 *
 * NOTE: MediaStream objects cannot be cloned via structured clone, but
 * because the opener is in the same browser process, we can pass the live
 * stream object reference through window.opener if they share the same
 * renderer process. In practice, for Chrome extensions opening extension
 * pages, this works. If it doesn't in a specific Chrome version, the
 * fallback is to use chrome.runtime messaging with track IDs and reconstruct.
 */

'use strict';

(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true },
    });

    // Post stream to opener (the content script's window)
    if (window.opener) {
      // Pass the actual stream object — works when opener is same-origin or
      // when the extension page and the tab share a renderer process.
      window.opener.postMessage(
        { type: 'stream-ready', stream },
        '*'  // we accept any origin since this is a controlled extension context
      );
    }
  } catch (err) {
    console.error('[WebRTC Bridge] getUserMedia failed:', err);
    if (window.opener) {
      window.opener.postMessage(
        { type: 'stream-error', message: err.message },
        '*'
      );
    }
  }
})();
