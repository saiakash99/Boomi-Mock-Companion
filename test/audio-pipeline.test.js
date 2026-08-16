'use strict';

const assert = require('assert');
const { pickSupportedAudioMimeType, buildDeepgramStreamUrl, startCandidateAudio } = require('../audio-pipeline.js');

function check(name, fn) {
  try {
    fn();
    console.log('  ok  - ' + name);
  } catch (err) {
    console.log('  FAIL - ' + name + '\n        ' + err.message);
    process.exitCode = 1;
  }
}

check('pickSupportedAudioMimeType prefers supported desktop-capture formats', () => {
  const original = global.MediaRecorder;
  global.MediaRecorder = function MediaRecorder() {};
  global.MediaRecorder.isTypeSupported = (type) => type === 'audio/webm;codecs=opus';
  try {
    assert.strictEqual(pickSupportedAudioMimeType(), 'audio/webm;codecs=opus');
  } finally {
    global.MediaRecorder = original;
  }
});

check('buildDeepgramStreamUrl includes required stream options', () => {
  const url = buildDeepgramStreamUrl({ model: 'nova-3', smartFormat: true, keepalive: true, interimResults: true, endpointing: 300, vadEvents: true });
  assert.ok(url.includes('wss://api.deepgram.com/v1/listen'));
  assert.ok(url.includes('model=nova-3'));
  assert.ok(url.includes('smart_format=true'));
  assert.ok(url.includes('keepalive=true'));
  assert.ok(url.includes('interim_results=true'));
  assert.ok(url.includes('endpointing=300'));
  assert.ok(url.includes('vad_events=true'));
  assert.ok(!url.includes('encoding='));
  assert.ok(!url.includes('sample_rate='));
});

check('buildDeepgramStreamUrl leaves browser-blob format untouched', () => {
  const url = buildDeepgramStreamUrl({ model: 'nova-3', interimResults: true });
  assert.ok(url.includes('model=nova-3'));
  assert.ok(url.includes('interim_results=true'));
  assert.ok(!url.includes('encoding='));
  assert.ok(!url.includes('sample_rate='));
});

check('buildDeepgramStreamUrl boosts recognition with domain keyterms', () => {
  const url = buildDeepgramStreamUrl({ model: 'nova-3', domain: 'Boomi' });
  const keyterms = url.split('keyterm=').length - 1;
  assert.ok(keyterms >= 20, 'all Boomi stt_keyterms appended as keyterm params, got ' + keyterms);
  assert.ok(url.includes('keyterm=Boomi'));
  assert.ok(url.includes('keyterm=Process%20Property') || url.includes('keyterm=Process+Property'), 'multi-word term URL-encoded');
  assert.ok(!url.includes('keywords='), 'Nova-3 must use keyterm, not keywords');
});

check('buildDeepgramStreamUrl defaults to Boomi domain', () => {
  const url = buildDeepgramStreamUrl();
  assert.ok(url.includes('keyterm=Boomi'), 'default domain keyterms present');
});

check('buildDeepgramStreamUrl disables Deepgram filler words', () => {
  const url = buildDeepgramStreamUrl();
  assert.ok(url.includes('filler_words=false'), 'filler_words=false appended for pause-watchdog hygiene');
  assert.ok(!url.includes('filler_words=true'), 'filler words must stay off');
});

check('buildDeepgramStreamUrl falls back to Boomi for unknown domains', () => {
  const url = buildDeepgramStreamUrl({ domain: 'UnknownThing' });
  assert.ok(url.includes('keyterm=Boomi'), 'unknown domain falls back to Boomi vocabulary');
});

check('startCandidateAudio rejects cleanly when getUserMedia is unavailable', async () => {
  const original = Object.getOwnPropertyDescriptor(global, 'navigator');
  try {
    Object.defineProperty(global, 'navigator', { value: undefined, configurable: true });
    let rejected = false;
    await startCandidateAudio(() => {})
      .catch(() => { rejected = true; });
    assert.strictEqual(rejected, true, 'candidate mic must reject when getUserMedia is unavailable');
  } finally {
    if (original) Object.defineProperty(global, 'navigator', original);
    else delete global.navigator;
  }
});

check('startCandidateAudio rejects when the Deepgram API key is missing', async () => {
  const original = Object.getOwnPropertyDescriptor(global, 'navigator');
  try {
    Object.defineProperty(global, 'navigator', { value: { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) } }, configurable: true });
    let message = '';
    await startCandidateAudio(() => {}, { apiKey: '' })
      .catch((err) => { message = String(err && err.message || err); });
    assert.ok(message.includes('DEEPGRAM_API_KEY'), 'missing key must be reported, got: ' + message);
  } finally {
    if (original) Object.defineProperty(global, 'navigator', original);
    else delete global.navigator;
  }
});

// STEP 13 — Deepgram frames must arrive as { text, isFinal } so the engine can
// hold interims and append each final exactly once (no transcript duplication).
check('startCandidateAudio forwards {text, isFinal} frames for engine dedupe', async () => {
  const flush = () => new Promise(r => setImmediate(r));
  const originals = {
    WebSocket: global.WebSocket,
    MediaRecorder: global.MediaRecorder,
    navigator: Object.getOwnPropertyDescriptor(global, 'navigator')
  };
  let socket;
  class FakeWebSocket {
    constructor(url, protocols) { socket = this; this.readyState = 0; this.url = url; }
    open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    close() { this.readyState = 3; }
  }
  FakeWebSocket.OPEN = 1;
  function FakeMediaRecorder() { this.state = 'inactive'; }
  FakeMediaRecorder.prototype.start = function () { this.state = 'recording'; };
  FakeMediaRecorder.prototype.stop = function () { this.state = 'inactive'; };
  FakeMediaRecorder.isTypeSupported = () => true;

  try {
    global.WebSocket = FakeWebSocket;
    global.MediaRecorder = FakeMediaRecorder;
    Object.defineProperty(global, 'navigator', { value: { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop: () => {} }] }) } }, configurable: true });

    const received = [];
    const pending = startCandidateAudio((frame) => received.push(frame), { apiKey: 'test-key' });
    await flush();          // getUserMedia().then runs -> socket created
    socket.open();          // resolves the returned handle
    const handle = await pending;
    assert.ok(handle && typeof handle.stop === 'function', 'resolves with a stop handle');

    socket.onmessage({ data: JSON.stringify({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'I would use a' }] } }) });
    socket.onmessage({ data: JSON.stringify({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'I would use a Process Property' }] } }) });
    socket.onmessage({ data: JSON.stringify({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: '   ' }] } }) });

    assert.strictEqual(received.length, 2, 'empty transcripts dropped, got ' + received.length);
    assert.deepStrictEqual(received[0], { text: 'I would use a', isFinal: false }, 'interim forwarded with isFinal=false');
    assert.deepStrictEqual(received[1], { text: 'I would use a Process Property', isFinal: true }, 'final forwarded with isFinal=true');
    handle.stop();
  } finally {
    global.WebSocket = originals.WebSocket;
    global.MediaRecorder = originals.MediaRecorder;
    if (originals.navigator) Object.defineProperty(global, 'navigator', originals.navigator);
    else delete global.navigator;
  }
});

console.log('\n== AUDIO PIPELINE REGRESSION TEST ==');
