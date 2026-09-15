/**
 * webrtc_bridge.js — Together Watch Party WebRTC Engine
 *
 * Runs inside the extension iframe (chrome-extension://.../webrtc_bridge.html).
 * Bypasses host streaming page Content Security Policy (CSP) completely.
 * Implements W3C Perfect Negotiation to prevent glare / duplicate collision.
 */

'use strict';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:openrelay.metered.ca:80' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
      'turns:openrelay.metered.ca:443?transport=tcp',
      'turns:openrelay.metered.ca:5349?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

let pc = null;
let localStream = null;
let remoteStream = null;
let pendingOffer = null;
let pendingIceCandidates = [];
let isHost = false;

// Perfect negotiation state variables
let makingOffer = false;
let ignoreOffer = false;
let isSettingRemoteAnswerPending = false;

function log(...args) {
  console.log('[Together-Bridge]', ...args);
}

// Single-channel communication with parent content script (NO chrome.runtime duplicate loops)
function notifyContent(payload) {
  try {
    window.parent.postMessage({ ...payload, source: 'webrtc_bridge' }, '*');
  } catch (err) {
    log('notifyContent error:', err);
  }
}

function sendWS(payload) {
  notifyContent({ type: 'ws-send', payload });
}

// ─── Local Media Stream ───────────────────────────────────────────────────────

async function getLocalMediaStream() {
  if (localStream && localStream.getTracks().some((t) => t.readyState === 'live')) {
    return localStream;
  }

  // 1. Standard 640x480 webcam
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err1) {
    log('Standard getUserMedia failed, trying basic:', err1);
  }

  // 2. Fallback basic video+audio
  try {
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err2) {
    log('Basic video+audio failed, trying video only:', err2);
  }

  // 3. Fallback video only
  try {
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  } catch (err3) {
    log('Video only failed, trying audio only:', err3);
    return await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
  }
}

function showLocalStream(stream) {
  const video = document.getElementById('tog-local-video');
  const placeholder = document.getElementById('tog-local-placeholder');
  if (!video) return;

  if (stream && stream.getTracks().length > 0) {
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    video.muted = true;
    const hasVideo = stream.getVideoTracks().length > 0 && stream.getVideoTracks().some((t) => t.enabled && t.readyState === 'live');
    if (placeholder) placeholder.style.display = hasVideo ? 'none' : '';
    video.style.display = hasVideo ? 'block' : 'none';
    video.play().catch(() => {});
  } else {
    video.srcObject = null;
    if (placeholder) placeholder.style.display = '';
    video.style.display = 'none';
  }
}

function showRemoteStream(stream) {
  const video = document.getElementById('tog-remote-video');
  const audio = document.getElementById('tog-remote-audio');
  const placeholder = document.getElementById('tog-remote-placeholder');

  if (audio && stream && stream.getAudioTracks().length > 0) {
    if (audio.srcObject !== stream) {
      audio.srcObject = stream;
    }
    audio.muted = false;
    audio.volume = 1.0;
    audio.play().catch(() => {});
  } else if (audio) {
    audio.srcObject = null;
  }

  if (!video) return;

  if (stream && stream.getTracks().length > 0) {
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;

    const checkVideo = () => {
      const vTracks = stream.getVideoTracks();
      const hasLive = vTracks.length > 0 && vTracks.some((t) => t.enabled && t.readyState === 'live');
      if (placeholder) placeholder.style.display = hasLive ? 'none' : '';
      video.style.display = hasLive ? 'block' : 'none';
      if (hasLive) video.play().catch(() => {});
    };

    checkVideo();
    stream.onaddtrack = checkVideo;
    stream.onremovetrack = checkVideo;
    stream.getVideoTracks().forEach((track) => {
      track.onunmute = checkVideo;
      track.onmute = checkVideo;
    });
    video.onloadedmetadata = checkVideo;
  } else {
    video.srcObject = null;
    if (placeholder) placeholder.style.display = '';
    video.style.display = 'none';
  }
}

// ─── Peer Connection ──────────────────────────────────────────────────────────

async function setupPeerConnection() {
  if (pc && pc.signalingState !== 'closed') {
    return pc;
  }

  pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    iceTransportPolicy: 'all',
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  });

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }

  if (pc.addTransceiver) {
    const senders = pc.getSenders();
    if (!senders.some((s) => s.track && s.track.kind === 'audio')) {
      try { pc.addTransceiver('audio', { direction: 'sendrecv' }); } catch {}
    }
    if (!senders.some((s) => s.track && s.track.kind === 'video')) {
      try { pc.addTransceiver('video', { direction: 'sendrecv' }); } catch {}
    }
  }

  pc.addEventListener('track', (e) => {
    log('Remote track received in bridge:', e.track.kind, e.track.id);
    if (e.streams && e.streams[0]) {
      remoteStream = e.streams[0];
    } else {
      if (!remoteStream) remoteStream = new MediaStream();
      if (!remoteStream.getTracks().some((t) => t.id === e.track.id)) {
        remoteStream.addTrack(e.track);
      }
    }
    showRemoteStream(remoteStream);
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

  pc.addEventListener('iceconnectionstatechange', async () => {
    log('Bridge ICE state:', pc.iceConnectionState);
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      log('Bridge WebRTC media stream connected successfully!');
      notifyContent({ type: 'bridge-status', status: 'connected' });
    } else if (pc.iceConnectionState === 'failed') {
      log('Bridge ICE failed, restarting ICE...');
      try {
        if (typeof pc.restartIce === 'function' && isHost) {
          pc.restartIce();
          const offer = await pc.createOffer({ iceRestart: true });
          await pc.setLocalDescription(offer);
          sendWS({ type: 'offer', sdp: { type: offer.type, sdp: offer.sdp } });
        }
      } catch (err) {
        log('Bridge ICE restart error:', err);
      }
    }
  });

  pc.addEventListener('connectionstatechange', () => {
    log('Bridge WebRTC connection state:', pc.connectionState);
    if (pc.connectionState === 'connected') {
      notifyContent({ type: 'bridge-status', status: 'connected' });
    } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      notifyContent({ type: 'bridge-status', status: 'disconnected' });
    }
  });

  return pc;
}

async function startCall() {
  if (makingOffer) return;
  makingOffer = true;
  log('Bridge starting call...');

  try {
    localStream = await getLocalMediaStream();
  } catch (err) {
    log('Bridge getLocalMediaStream failed:', err);
    notifyContent({ type: 'bridge-error', message: 'Camera/Microphone permission denied.' });
    makingOffer = false;
    return;
  }

  showLocalStream(localStream);
  await setupPeerConnection();

  try {
    if (pc.signalingState !== 'stable') {
      log('Cannot create offer: signalingState is', pc.signalingState);
      return;
    }
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    sendWS({ type: 'offer', sdp: { type: offer.type, sdp: offer.sdp } });
    log('Bridge offer dispatched');
    notifyContent({ type: 'bridge-status', status: 'calling' });
  } catch (err) {
    log('Bridge offer creation failed:', err);
  } finally {
    makingOffer = false;
  }
}

async function answerCall(offerMessage) {
  const offer = offerMessage || pendingOffer;
  if (!offer) return;
  pendingOffer = null;

  log('Bridge answering call...');
  try {
    localStream = await getLocalMediaStream();
    showLocalStream(localStream);
  } catch (err) {
    log('Bridge answer getLocalMediaStream failed:', err);
  }

  await setupPeerConnection();

  try {
    const sdpObj = offer.sdp?.sdp ? offer.sdp : { type: offer.sdp?.type || 'offer', sdp: offer.sdp?.sdp || offer.sdp };
    await pc.setRemoteDescription(new RTCSessionDescription(sdpObj));
    await flushIceCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendWS({ type: 'answer', sdp: { type: answer.type, sdp: answer.sdp } });
    log('Bridge answer dispatched');
    notifyContent({ type: 'bridge-status', status: 'connected' });
  } catch (err) {
    log('Bridge answer error:', err);
  }
}

async function handleIncomingOffer(message) {
  log('Bridge received incoming offer');
  const isPolite = !isHost;
  const readyForOffer = !makingOffer && (pc === null || pc.signalingState === 'stable' || isSettingRemoteAnswerPending);
  const offerCollision = !readyForOffer;

  ignoreOffer = !isPolite && offerCollision;
  if (ignoreOffer) {
    log('Glare detected: Impolite host ignoring guest offer');
    return;
  }

  pendingOffer = message;

  if (offerCollision && isPolite && pc && pc.signalingState !== 'closed') {
    try {
      await pc.setLocalDescription({ type: 'rollback' });
      log('Polite peer rolled back local offer');
    } catch (e) {
      log('Rollback error:', e);
    }
  }

  if (localStream && localStream.getTracks().some((t) => t.readyState === 'live')) {
    await answerCall(message);
  } else {
    notifyContent({ type: 'bridge-status', status: 'incoming-offer' });
  }
}

async function handleIncomingAnswer(message) {
  if (!pc || pc.signalingState === 'closed') return;
  if (pc.signalingState === 'stable') {
    log('Ignoring duplicate answer SDP: connection is already stable');
    return;
  }
  if (pc.signalingState !== 'have-local-offer') {
    log('Ignoring answer SDP in state:', pc.signalingState);
    return;
  }

  try {
    isSettingRemoteAnswerPending = true;
    const sdpObj = message.sdp?.sdp ? message.sdp : { type: message.sdp?.type || 'answer', sdp: message.sdp?.sdp || message.sdp };
    await pc.setRemoteDescription(new RTCSessionDescription(sdpObj));
    await flushIceCandidates();
    log('Bridge remote answer applied successfully');
    notifyContent({ type: 'bridge-status', status: 'connected' });
  } catch (err) {
    log('Bridge handle answer error:', err);
  } finally {
    isSettingRemoteAnswerPending = false;
  }
}

async function handleIncomingIce(message) {
  if (!message.candidate) return;
  const cand = message.candidate.candidate ? message.candidate : (typeof message.candidate === 'string' ? { candidate: message.candidate } : message.candidate);
  if (!cand || !cand.candidate) return;

  if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
    pendingIceCandidates.push(cand);
    return;
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(cand));
  } catch (e) {
    if (!ignoreOffer) {
      log('Bridge ICE candidate error:', e);
    }
  }
}

async function flushIceCandidates() {
  if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) return;
  while (pendingIceCandidates.length > 0) {
    const candidate = pendingIceCandidates.shift();
    try {
      if (candidate) {
        const cand = candidate.candidate ? candidate : (typeof candidate === 'string' ? { candidate: candidate } : candidate);
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      }
    } catch (e) {
      log('Bridge flush ICE error:', e);
    }
  }
}

function endCall(notify = true) {
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
  makingOffer = false;
  ignoreOffer = false;
  isSettingRemoteAnswerPending = false;
  showLocalStream(null);
  showRemoteStream(null);
  notifyContent({ type: 'bridge-status', status: 'ended' });
  if (notify) {
    sendWS({ type: 'call-ended' });
  }
}

function handleMuteToggle() {
  if (!localStream) return;
  const audioTracks = localStream.getAudioTracks();
  if (!audioTracks.length) return;
  const isEnabled = !audioTracks[0].enabled;
  audioTracks.forEach((t) => { t.enabled = isEnabled; });
  notifyContent({ type: 'bridge-mute-status', enabled: isEnabled });
}

function handleCamToggle() {
  if (!localStream) return;
  const videoTracks = localStream.getVideoTracks();
  if (!videoTracks.length) return;
  const isEnabled = !videoTracks[0].enabled;
  videoTracks.forEach((t) => { t.enabled = isEnabled; });
  showLocalStream(localStream);
  notifyContent({ type: 'bridge-cam-status', enabled: isEnabled });
}

// ─── Message Dispatcher ───────────────────────────────────────────────────────

function handleIncomingBridgeMessage(data) {
  if (!data || typeof data !== 'object') return;
  const { type } = data;

  switch (type) {
    case 'start-call':
      startCall();
      break;
    case 'answer-call':
      answerCall(data.offer || pendingOffer);
      break;
    case 'end-call':
      endCall(data.notify ?? true);
      break;
    case 'toggle-mute':
      handleMuteToggle();
      break;
    case 'toggle-cam':
      handleCamToggle();
      break;
    case 'set-role':
      isHost = data.isHost ?? false;
      break;
    case 'set-spotlight':
      document.body.className = data.mode || '';
      break;
    case 'unlock-audio':
      unlockAudio();
      break;
    case 'offer':
      handleIncomingOffer(data);
      break;
    case 'answer':
      handleIncomingAnswer(data);
      break;
    case 'ice-candidate':
      handleIncomingIce(data);
      break;
    case 'call-ended':
      endCall(false);
      break;
  }
}

function unlockAudio() {
  const audio = document.getElementById('tog-remote-audio');
  if (audio && audio.srcObject && audio.paused) audio.play().catch(() => {});
  const video = document.getElementById('tog-remote-video');
  if (video && video.srcObject && video.paused) video.play().catch(() => {});
}

// Listen to postMessage from parent content script (Single Source of Truth)
window.addEventListener('message', (event) => {
  if (event.data && event.data.source === 'together_content') {
    handleIncomingBridgeMessage(event.data);
  }
});

// Spotlight click handlers inside the frame
document.getElementById('tog-remote-tile')?.addEventListener('click', () => {
  if (document.body.classList.contains('spotlight-remote')) {
    document.body.className = '';
    notifyContent({ type: 'bridge-toast', message: '👥 Dual View' });
  } else {
    document.body.className = 'spotlight-remote';
    notifyContent({ type: 'bridge-toast', message: '🔍 Spotlight: Friend' });
  }
});

document.getElementById('tog-local-tile')?.addEventListener('click', () => {
  if (document.body.classList.contains('spotlight-local')) {
    document.body.className = '';
    notifyContent({ type: 'bridge-toast', message: '👥 Dual View' });
  } else {
    document.body.className = 'spotlight-local';
    notifyContent({ type: 'bridge-toast', message: '🔍 Spotlight: You' });
  }
});

// Global gesture unlocker for audio/video playback
['click', 'pointerdown', 'keydown'].forEach((evt) => {
  document.addEventListener(evt, unlockAudio, { capture: true });
});
