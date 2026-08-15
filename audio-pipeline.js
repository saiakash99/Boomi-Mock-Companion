'use strict';

const { getDomainConfig } = require('./domain-vocabulary.js');

const AUDIO_MIME_CANDIDATES = [
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/ogg'
];

function pickSupportedAudioMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const candidate of AUDIO_MIME_CANDIDATES) {
    if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return '';
}

// Nova-3 models use the `keyterm` query parameter (not `keywords`); weights /
// intensifiers are not supported, so each vocabulary term is appended as a
// plain keyterm to prevent mishearing domain jargon.
function buildDeepgramStreamUrl({ model = 'nova-3', smartFormat = true, keepalive = true, interimResults = true, endpointing = 300, vadEvents = true, domain = 'Boomi' } = {}) {
  const url = new URL('wss://api.deepgram.com/v1/listen');
  url.searchParams.set('model', model);
  url.searchParams.set('smart_format', String(!!smartFormat));
  url.searchParams.set('keepalive', String(!!keepalive));
  url.searchParams.set('interim_results', String(!!interimResults));
  url.searchParams.set('endpointing', String(endpointing));
  url.searchParams.set('vad_events', String(!!vadEvents));
  // Phase 8 — filler words bypass: tell Deepgram to drop hesitations ("um",
  // "uh", "you know") so they never appear in the transcript and artificially
  // extend the engine's pause watchdog timers.
  url.searchParams.set('filler_words', 'false');

  const config = getDomainConfig(domain);
  for (const term of config.stt_keyterms || []) {
    url.searchParams.append('keyterm', term);
  }

  return url.toString();
}

// Phase 10 Part 1 — Candidate Audio Capture.
// Captures the candidate's PHYSICAL MICROPHONE (NOT desktop/system audio) and
// streams it to its own Deepgram WebSocket. Every final/interim transcript is
// forwarded to onCandidateTranscript(text) so the engine can analyze what the
// candidate actually said.
//
// Returns a Promise that resolves with a `{ stop }` handle once the mic +
// Deepgram socket are live, and rejects on failure (no mic, no API key, socket
// error). The caller is responsible for passing the Deepgram API key.
function startCandidateAudio(onCandidateTranscript, { apiKey, domain = 'Boomi', model = 'nova-3' } = {}) {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return Promise.reject(new Error('Candidate microphone capture is not supported in this environment.'));
  }
  if (!apiKey) {
    return Promise.reject(new Error('DEEPGRAM_API_KEY is required for candidate audio analysis.'));
  }

  // Physical microphone, NOT chromeMediaSource. Native echo cancellation +
  // noise suppression keep the candidate's answer clean for analysis.
  return navigator.mediaDevices.getUserMedia({
    audio: {
      noiseSuppression: true,
      echoCancellation: true
    }
  }).then((stream) => {
    const mimeType = pickSupportedAudioMimeType() || 'audio/webm;codecs=opus';
    const wsUrl = buildDeepgramStreamUrl({ model, smartFormat: true, keepalive: true, interimResults: true, endpointing: 300, vadEvents: true, domain });
    const socket = new WebSocket(wsUrl, ['token', apiKey]);
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    let stopped = false;
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (e) { /* noop */ }
      try { stream.getTracks().forEach(t => t.stop()); } catch (e) { /* noop */ }
      try { if (socket && socket.readyState === WebSocket.OPEN) socket.close(); } catch (e) { /* noop */ }
    };

    return new Promise((resolve, reject) => {
      socket.onopen = () => {
        recorder.start(250);
        resolve({ stop: cleanup });
      };
      socket.onerror = (err) => {
        cleanup();
        reject(err);
      };
      socket.onclose = cleanup;

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'Results') {
            const transcript = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0] && msg.channel.alternatives[0].transcript;
            if (transcript && String(transcript).trim().length > 0 && typeof onCandidateTranscript === 'function') {
              onCandidateTranscript(String(transcript));
            }
          }
        } catch (e) {
          // ignore non-JSON / parse noise from the candidate socket
        }
      };

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0 && socket && socket.readyState === WebSocket.OPEN) {
          socket.send(event.data);
        }
      };
    });
  });
}

module.exports = {
  AUDIO_MIME_CANDIDATES,
  pickSupportedAudioMimeType,
  buildDeepgramStreamUrl,
  startCandidateAudio
};
