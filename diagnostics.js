'use strict';

// ============================================================
// Boomi Companion — Phase 2A Diagnostic / Interaction Timeline Logger
//
// Purpose (observability only — never changes engine behaviour):
//   During a real mock interview, every important internal event in the
//   question/turn pipeline is captured automatically and persisted as a
//   timestamped JSONL session file that another engineer/AI can analyse.
//
// Guarantees:
//   - One session per run; never overwrites a previous session.
//   - Machine-readable JSONL (source of truth) + optional human-readable .txt.
//   - Monotonic high-resolution timer for elapsedMs (wall clock is separate).
//   - Monotonically increasing event IDs (event_000001 ...) per session.
//   - Non-blocking: events are buffered and written asynchronously on a
//     periodic flush; nothing on the audio/Deepgram pipeline waits on disk.
//   - Crash safety: frequent flushes + a synchronous final write on end().
//   - Bounded disk growth: rotates to a new part file past maxBytes.
//   - Secret redaction: API keys / tokens / authorization material is never
//     written, even if a caller passes it (defence in depth).
//   - DEBUG_DIAGNOSTICS=false (disabled) -> minimal event set only.
//
// NOTE: transcript text IS logged when diagnostics are enabled. This is an
// intentional developer/test mode for interview analysis.
// ============================================================

const fs = require('fs');
const path = require('path');

// Keys whose values must never reach the log (lowercased compare).
const SECRET_KEY_PATTERN =
  /(apikey|api_key|api-key|x-api-key|authorization|bearer|access_token|refresh_token|id_token|session_token|token|secret|cookie|cookies|password|passwd|credential|credentials|private_key|client_secret|auth)/i;

const REDACTED = '[REDACTED]';

// Looks like a JWT / opaque credential value: 3+ dot-separated chunks, or an
// explicit "Bearer " prefix.
const JWT_LIKE = /^[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]{8,}){2,}$/;

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ISO-8601 wall-clock timestamp WITH local timezone offset:
//   2026-08-13T22:58:31.123+05:30
function isoWithOffset(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const base = d.toISOString().slice(0, 23);
  return base + sign + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0');
}

// Monotonic, high-resolution elapsed clock. Never used for wall-clock display.
function defaultMonotonic() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  if (typeof process !== 'undefined' && typeof process.hrtime === 'function') {
    const t = process.hrtime();
    return t[0] * 1000 + t[1] / 1e6;
  }
  return Date.now();
}

// Events still written when diagnostics are non-verbose (enabled but minimal).
const ALWAYS_EVENTS = new Set([
  'SESSION_STARTED',
  'SESSION_ENDED',
  'SESSION_SUMMARY',
  'ERROR',
  'WARNING',
  'LOG_ROTATED'
]);

class DiagnosticLogger {
  constructor(opts) {
    opts = opts || {};
    this.enabled = opts.enabled !== false;
    this.verbose = opts.verbose !== false; // false -> only ALWAYS_EVENTS written
    this.dir = opts.dir || path.join(process.cwd(), 'logs');
    this.maxBytes = opts.maxBytes != null ? opts.maxBytes : 5 * 1024 * 1024; // 5 MB default
    this.flushMs = opts.flushMs != null ? opts.flushMs : 400;
    this.txtEnabled = opts.txtEnabled !== false;
    this.domain = opts.domain || '';
    this.mode = opts.mode || 'normal'; // 'diagnostic' | 'normal'

    this.nowMonotonic = typeof opts.nowMonotonic === 'function' ? opts.nowMonotonic : defaultMonotonic;
    this.nowWall = typeof opts.nowWall === 'function' ? opts.nowWall : Date.now;

    this._started = false;
    this._ended = false;
    this._eventSeq = 0;
    this._bytesWritten = 0;
    this._buffer = [];
    this._flushTimer = null;
    this._rotations = 0;
    this._startMonotonic = 0;
    this._startWall = 0;
    this.sessionId = '';
    this.jsonlPath = '';
    this.txtPath = '';
    this._baseJsonl = '';
    this._baseTxt = '';

    this._marks = new Map();      // turnId -> { markName: elapsedMs }
    this._stats = {
      turns: 0,
      snapshots: 0,
      followUps: 0,
      boundaryDecisions: 0,
      finalize: 0,
      waitForMore: 0,
      continue: 0,
      pauses: 0,
      clears: 0,
      errors: 0,
      warnings: 0,
      snapshotLatencies: []
    };
  }

  // ---------------- session lifecycle ----------------

  start() {
    if (this._started) return this;
    this._started = true;
    const now = this.nowWall();
    this._startWall = now;
    this._startMonotonic = this.nowMonotonic();
    const d = new Date(now);
    const pad = (n) => String(n).padStart(2, '0');
    const fileBase =
      `session-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    const rnd = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    this.sessionId =
      `session_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${rnd}`;
    this._baseJsonl = path.join(this.dir, fileBase + '.jsonl');
    this._baseTxt = path.join(this.dir, fileBase + '.txt');
    // Collision safety: never overwrite an earlier session started in the
    // same second — bump a numeric suffix until a free name is found.
    let suffix = 0;
    let jsonlPath = this._baseJsonl;
    let txtPath = this._baseTxt;
    while (fs.existsSync(jsonlPath) || fs.existsSync(txtPath)) {
      suffix += 1;
      jsonlPath = this._baseJsonl + '.' + suffix;
      txtPath = this._baseTxt + '.' + suffix;
    }
    this.jsonlPath = jsonlPath;
    this.txtPath = txtPath;

    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (this.txtEnabled) {
        const header = [
          '# BOOMI COMPANION — DIAGNOSTIC SESSION',
          `# sessionId: ${this.sessionId}`,
          `# started:   ${isoWithOffset(d)}`,
          `# domain:    ${this.domain}`,
          `# mode:      ${this.mode}`,
          '# NOTE: transcript content is intentionally logged (developer test mode).',
          '# Source of truth: ' + fileBase + '.jsonl',
          ''
        ].join('\n');
        fs.appendFileSync(this.txtPath, header, 'utf8');
      }
    } catch (err) {
      this._lastError = err;
      // The logger must never crash the application; continue in-memory.
    }

    this._emitNow('SESSION_STARTED', {
      domain: this.domain,
      mode: this.mode,
      jsonlPath: this.jsonlPath,
      txtPath: this.txtPath,
      maxBytes: this.maxBytes,
      flushMs: this.flushMs,
      diagnosticsVerbose: this.verbose,
      transcriptLoggingEnabled: true
    });
    this._scheduleFlush();
    return this;
  }

  // Public API: record a structured event.
  emit(eventType, data) {
    if (!this.enabled) return null;
    if (!this._started) this.start();
    if (!this.verbose && !ALWAYS_EVENTS.has(eventType)) return null;
    this._updateStats(eventType, data || {});
    return this._emitNow(eventType, data || {});
  }

  _emitNow(eventType, data) {
    this._eventSeq += 1;
    const now = this.nowWall();
    const elapsedMs = this.nowMonotonic() - this._startMonotonic;
    const ev = {
      sessionId: this.sessionId,
      eventId: 'event_' + String(this._eventSeq).padStart(6, '0'),
      timestamp: isoWithOffset(new Date(now)),
      elapsedMs: round2(elapsedMs),
      eventType: eventType,
      ...this._sanitize(data || {})
    };
    const line = JSON.stringify(ev);
    this._buffer.push(line);
    if (this._buffer.length >= 200) this._scheduleFlush(0);
    else this._scheduleFlush(this.flushMs);
    return ev;
  }

  // ---------------- performance timeline ----------------
  // Marks are keyed by turn so T0..T7 and the derived latency metrics stay
  // attached to the question they belong to.
  perfMark(name, turnId) {
    if (!this.enabled || !this.verbose) return;
    const elapsedMs = this.nowMonotonic() - this._startMonotonic;
    const key = turnId || '_global_';
    let t = this._marks.get(key);
    if (!t) {
      t = {};
      this._marks.set(key, t);
    }
    if (t[name] == null) t[name] = elapsedMs; // first occurrence wins
    this._lastMark = this._lastMark || {};
    if (this._lastMark[name] == null) this._lastMark[name] = elapsedMs; // global fallback

    this._emitNow('PERFORMANCE_MARK', { turnId: key, mark: name, markElapsedMs: round2(elapsedMs) });

    if (name === 'snapshot' && !t._derived) {
      t._derived = true;
      const last = this._lastMark || {};
      const first = t.firstInterim != null ? t.firstInterim : (t.firstAudio != null ? t.firstAudio : last.firstInterim != null ? last.firstInterim : last.firstAudio);
      const cand = t.candidate != null ? t.candidate : last.candidate;
      const boundary = t.boundary != null ? t.boundary : last.boundary;
      const derived = { turnId: key, snapshotMs: round2(elapsedMs) };
      if (t.firstInterim != null) derived.transcriptFirstMs = round2(t.firstInterim);
      else if (last.firstInterim != null) derived.transcriptFirstMs = round2(last.firstInterim);
      if (t.firstAudio != null) derived.firstAudioMs = round2(t.firstAudio);
      else if (last.firstAudio != null) derived.firstAudioMs = round2(last.firstAudio);
      if (cand != null) derived.candidateMs = round2(cand);
      if (boundary != null) derived.boundaryMs = round2(boundary);
      if (first != null && boundary != null) derived.firstTranscriptToBoundaryMs = round2(boundary - first);
      if (cand != null && boundary != null) derived.candidateToBoundaryMs = round2(boundary - cand);
      if (first != null) {
        const lat = elapsedMs - first;
        this._stats.snapshotLatencies.push(lat);
        derived.firstTranscriptToSnapshotMs = round2(lat);
      }
      this._emitNow('PERFORMANCE_MARK', derived);
    }
  }

  // ---------------- buffered async flush ----------------

  _scheduleFlush(ms) {
    if (this._flushTimer != null || this._ended) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush().catch(() => {});
    }, ms);
  }

  flush() {
    if (!this._started || !this.enabled) return Promise.resolve();
    if (!this._buffer.length) return Promise.resolve();
    const lines = this._buffer.splice(0);
    return this._writeLines(lines).catch((err) => {
      // never break the application because the log disk failed
      this._lastError = err;
      this._emitNow('ERROR', { error: String(err && err.message || err), context: 'diagnostic_flush' });
      this._scheduleFlush(250); // retry once later
    });
  }

  async _writeLines(lines) {
    await fs.promises.appendFile(this.jsonlPath, lines.join('\n') + '\n', 'utf8');
    this._bytesWritten += lines.reduce((s, l) => s + Buffer.byteLength(l) + 1, 0);
    if (this.txtEnabled) {
      await fs.promises.appendFile(this.txtPath, this._toTxt(lines).join('\n') + '\n', 'utf8');
    }
    this._maybeRotate();
  }

  // Bounded disk growth: rotate to a new part file once maxBytes is reached.
  _maybeRotate() {
    if (this._bytesWritten < this.maxBytes) return;
    this._rotations += 1;
    this._bytesWritten = 0;
    const part = this._rotations + 1;
    this.jsonlPath = this._baseJsonl + '.' + part;
    this.txtPath = this._baseTxt + '.' + part;
    this._emitNow('LOG_ROTATED', { part: part, reason: 'max_bytes_reached', maxBytes: this.maxBytes });
  }

  // ---------------- end / summary ----------------

  // Synchronous final write so a crash right at shutdown cannot lose the
  // session footer. One sync write at the very end is acceptable.
  end() {
    if (!this._started || this._ended) return;
    this._ended = true;
    if (this._flushTimer != null) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    const elapsedMs = this.nowMonotonic() - this._startMonotonic;
    const lat = this._stats.snapshotLatencies;
    const summary = {
      sessionDurationMs: round2(elapsedMs),
      turns: this._stats.turns,
      snapshots: this._stats.snapshots,
      followUps: this._stats.followUps,
      boundaryDecisions: this._stats.boundaryDecisions,
      finalizeCount: this._stats.finalize,
      waitForMoreCount: this._stats.waitForMore,
      continueCount: this._stats.continue,
      pauses: this._stats.pauses,
      clears: this._stats.clears,
      averageSnapshotLatencyMs: lat.length ? round2(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      minSnapshotLatencyMs: lat.length ? round2(Math.min.apply(null, lat)) : null,
      maxSnapshotLatencyMs: lat.length ? round2(Math.max.apply(null, lat)) : null,
      errors: this._stats.errors,
      warnings: this._stats.warnings,
      rotations: this._rotations
    };
    this._emitNow('SESSION_ENDED', { reason: 'app_shutdown', sessionDurationMs: round2(elapsedMs) });
    this._emitNow('SESSION_SUMMARY', summary);
    this._flushSync();
  }

  _flushSync() {
    const lines = this._buffer.splice(0);
    if (!lines.length) return;
    try {
      fs.appendFileSync(this.jsonlPath, lines.join('\n') + '\n', 'utf8');
      if (this.txtEnabled) fs.appendFileSync(this.txtPath, this._toTxt(lines).join('\n') + '\n', 'utf8');
      this._bytesWritten += lines.reduce((s, l) => s + Buffer.byteLength(l) + 1, 0);
    } catch (err) {
      this._lastError = err;
    }
  }

  // ---------------- stats ----------------

  _updateStats(eventType, data) {
    switch (eventType) {
      case 'TURN_STARTED': this._stats.turns += 1; break;
      case 'QUESTION_SNAPSHOT_CREATED': this._stats.snapshots += 1; break;
      case 'FOLLOWUP_DETECTED': this._stats.followUps += 1; break;
      case 'BOUNDARY_DECISION':
        this._stats.boundaryDecisions += 1;
        if (data.decision === 'FINALIZE') this._stats.finalize += 1;
        else if (data.decision === 'WAIT_FOR_MORE') this._stats.waitForMore += 1;
        else if (data.decision === 'CONTINUE') this._stats.continue += 1;
        break;
      case 'PAUSE_STARTED': this._stats.pauses += 1; break;
      case 'CLEAR': this._stats.clears += 1; break;
      case 'ERROR': this._stats.errors += 1; break;
      case 'WARNING': this._stats.warnings += 1; break;
      default: break;
    }
  }

  // ---------------- security: sanitise + redact ----------------

  _sanitize(obj) {
    if (obj == null) return {};
    const out = {};
    for (const key of Object.keys(obj)) {
      if (SECRET_KEY_PATTERN.test(key)) continue; // drop secret-named fields entirely
      let v = obj[key];
      if (typeof v === 'function' || typeof v === 'undefined' || typeof v === 'symbol') continue;
      if (typeof v === 'string') {
        const t = v.trim();
        if (/^bearer\s+/i.test(t) || JWT_LIKE.test(t)) v = REDACTED;
        out[key] = v;
      } else if (Array.isArray(v)) {
        const cleaned = [];
        for (const item of v) {
          const s = this._sanitize(item);
          if (s !== undefined) cleaned.push(s);
        }
        out[key] = cleaned;
      } else if (isObject(v)) {
        out[key] = this._sanitize(v);
      } else {
        out[key] = v;
      }
    }
    return out;
  }

  // ---------------- human-readable txt ----------------

  _toTxt(lines) {
    return lines.map((line) => {
      try {
        const ev = JSON.parse(line);
        const t = String(ev.timestamp || '').slice(11, 23);
        const parts = [String(ev.elapsedMs || '').padStart(9), t, ev.eventType];
        for (const k of ['turnId', 'questionState', 'decision', 'reason', 'transcript']) {
          if (ev[k] != null && ev[k] !== '') {
            parts.push(k + '=' + JSON.stringify(String(ev[k]).slice(0, 160)));
          }
        }
        return parts.join(' ');
      } catch (_) {
        return line;
      }
    });
  }
}

module.exports = {
  DiagnosticLogger,
  isoWithOffset,
  SECRET_KEY_PATTERN,
  REDACTED
};
