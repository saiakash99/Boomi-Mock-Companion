'use strict';

// ============================================================
// Boomi Companion — ProviderRouter
//
// Hardened multi-provider LLM router (STEP 4-6). Extracted from the
// renderer (index.html callWithFallback) and made
// deterministic + unit-testable.
//
// Guarantees:
//  - Providers are tried in order (Groq -> OpenRouter -> Cerebras by default).
//  - Time-to-first-token budget for streaming: wait up to ttftMs for the
//    FIRST useful chunk; once streaming starts the stream runs to
//    completion subject to streamingTotalMs. JSON (fast/grader) calls get
//    jsonTotalMs. Every call is aborted when it exceeds its budget — no
//    request can hang the pipeline.
//  - Failures are classified (TRANSIENT / AUTH / BAD_REQUEST / CONFIG /
//    UNKNOWN) so the retry policy is smart:
//       TRANSIENT (429/408/425/5xx/network/timeout/abort) => fail over to the
//         next provider and cool this one down.
//       AUTH / CONFIG (bad or missing credentials) => mark OFFLINE; never
//         retried endlessly for the session.
//  - Per-provider circuit breaker: HEALTHY / DEGRADED / RATE_LIMITED /
//    COOLDOWN / OFFLINE with probeAfterMs half-open recovery.
//  - fetch + timers + clock are injected => deterministic tests with fake
//    network and fake time.
// ============================================================

const ERROR_CLASS = Object.freeze({
  TRANSIENT: 'TRANSIENT',
  AUTH: 'AUTH',
  BAD_REQUEST: 'BAD_REQUEST',
  CONFIG: 'CONFIG',
  UNKNOWN: 'UNKNOWN'
});

const BREAKER_STATE = Object.freeze({
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  RATE_LIMITED: 'RATE_LIMITED',
  COOLDOWN: 'COOLDOWN',
  OFFLINE: 'OFFLINE'
});

const DEFAULT_ROUTER_CFG = Object.freeze({
  order: ['groq', 'openrouter', 'cerebras'], // strict fallback chain (Gemini removed)
  ttftMs: 4000,           // streaming: budget for the FIRST chunk only
  streamingTotalMs: 30000, // streaming: overall stream budget
  jsonTotalMs: 15000,      // non-streaming JSON (fast + grader) budget
  cooldownMs: 60000,       // full circuit-breaker cooldown window (reporting)
  probeAfterMs: 15000,     // when the breaker half-opens and a probe is allowed
  temperature: 0.35
});

// Grab a bare HTTP status (e.g. "Groq API 429 Rate Limited" -> 429).
function extractStatus(err) {
  const m = String(err && err.message || err || '');
  const hit = m.match(/\b(\d{3})\b/);
  return hit ? parseInt(hit[1], 10) : null;
}

function classifyError(err) {
  if (err && err.name === 'AbortError') return ERROR_CLASS.TRANSIENT;
  const m = String(err && err.message || err || '');
  if (/(timeout|timed out|aborted|network error|failed to fetch|fetch failed|enotfound|econn|etimedout|socket|offline|unreachable)/i.test(m)) {
    return ERROR_CLASS.TRANSIENT;
  }
  const code = extractStatus(err);
  if (code != null) {
    if (code === 401 || code === 402 || code === 403) return ERROR_CLASS.AUTH;
    if (code === 408 || code === 425 || code === 429) return ERROR_CLASS.TRANSIENT;
    if (code >= 500 && code <= 504) return ERROR_CLASS.TRANSIENT;
    if (code === 400 || code === 404 || code === 405 || code === 406 || code === 409 || code === 415 || code === 422) return ERROR_CLASS.BAD_REQUEST;
    return ERROR_CLASS.UNKNOWN;
  }
  if (/(api[_ -]?key|authorization|credential|bearer)[^.]*(missing|not set|required|invalid|undefined|not configured|must)/i.test(m)) {
    return ERROR_CLASS.CONFIG;
  }
  return ERROR_CLASS.UNKNOWN;
}

async function readGroqStream(res, onChunk) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        const piece = (delta && (delta.content || '')) || '';
        if (piece) { full += piece; if (onChunk) onChunk(full); }
      } catch (_) { /* ignore malformed chunk */ }
    }
  }
  return full;
}

class ProviderRouter {
  constructor(opts) {
    opts = opts || {};
    this.cfg = Object.assign({}, DEFAULT_ROUTER_CFG, opts.cfg || {});
    this._fetch = typeof opts.fetch === 'function'
      ? opts.fetch.bind(globalThis)
      : (typeof globalThis !== 'undefined' && globalThis.fetch ? globalThis.fetch.bind(globalThis) : null);
    this._now = typeof opts.now === 'function' ? opts.now : (Date.now ? Date.now.bind(Date) : () => 0);
    this._setTimeout = typeof opts.setTimeout === 'function' ? opts.setTimeout : ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : ((id) => clearTimeout(id));
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;

    // Multi-Key Pooling — round-robins across every key per provider so N
    // accounts pool their rate-limit headroom. Sources: the provider's
    // apiKey() closure returns a comma-separated list (openrouter/cerebras),
    // and for groq the process.env.GROQ_API_KEYS / GROQ_API_KEY vars merge in.
    this.groqKeys = this._splitKeys(process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '');
    this._keyIndexes = {};

    this.providers = {};
    for (const name of this.cfg.order) {
      const p = (opts.providers && opts.providers[name]) || {};
      this.providers[name] = {
        name,
        enabled: p.enabled !== false,
        apiKey: typeof p.apiKey === 'function' ? p.apiKey : (() => String(p.apiKey || '')),
        models: Object.assign(
          name === 'groq'
            // Stable Groq IDs — verified against GET /v1/models (Aug 2026).
            // Legacy llama3-8b/70b-8192 are decommissioned.
            ? { fast: 'openai/gpt-oss-20b', answer: 'openai/gpt-oss-120b' }
            : name === 'openrouter'
              // llama-3.1-8b-instruct is no longer free-tier on OpenRouter; the
              // paid slug serves on pooled keys.
              ? { fast: 'meta-llama/llama-3.1-8b-instruct', answer: 'meta-llama/llama-3.3-70b-instruct' }
              : name === 'cerebras'
                ? { fast: 'gemma-4-31b', answer: 'gpt-oss-120b' }
                : { fast: 'openai/gpt-oss-20b', answer: 'openai/gpt-oss-120b' },
          p.models || {}
        ),
        breaker: BREAKER_STATE.HEALTHY,
        consecutiveFailures: 0,
        requestCount: 0,
        failCount: 0,
        lastStatus: null,
        probeAfter: 0
      };
    }
  }

  _emit(type, data) {
    if (!this.onEvent) return;
    try { this.onEvent(type, data); } catch (_) { /* diagnostics must never break routing */ }
  }

  _key(name) {
    try { return String(this.providers[name].apiKey() || '').trim(); } catch (_) { return ''; }
  }

  // Split a possibly comma-separated key string into trimmed, non-empty keys.
  _splitKeys(raw) {
    return String(raw || '').split(',').map(k => k.trim()).filter(Boolean);
  }

  // Effective key pool for a provider. For 'groq' the process.env list
  // (GROQ_API_KEYS / GROQ_API_KEY) merges in first; every provider also pools
  // whatever its apiKey() closure returns. Deduped.
  _keyPool(name) {
    const merged = name === 'groq' ? this.groqKeys.slice() : [];
    for (const k of this._splitKeys(this._key(name))) {
      if (!merged.includes(k)) merged.push(k);
    }
    return merged;
  }

  // Availability probe for the missing-key skip (never rotates the pointer).
  _hasKey(name) {
    return this._keyPool(name).length > 0;
  }

  // Round-robin: returns the next pooled key for a provider (or '' when the
  // pool is empty) and advances that provider's pointer so the NEXT request
  // uses the following key.
  _getActiveKey(name) {
    const pool = this._keyPool(name);
    if (pool.length === 0) return '';
    const idx = this._keyIndexes[name] || 0;
    const key = pool[idx % pool.length];
    this._keyIndexes[name] = idx + 1;
    return key;
  }

  getBreakerState(name) {
    const p = this.providers[name];
    return p ? p.breaker : null;
  }

  breakerSummary() {
    const out = {};
    for (const name of Object.keys(this.providers)) {
      const p = this.providers[name];
      out[name] = {
        state: p.breaker,
        consecutiveFailures: p.consecutiveFailures,
        lastStatus: p.lastStatus,
        requestCount: p.requestCount,
        failCount: p.failCount
      };
    }
    return out;
  }

  _canTry(provider) {
    if (provider.breaker === BREAKER_STATE.OFFLINE) return false;
    if (provider.breaker === BREAKER_STATE.RATE_LIMITED || provider.breaker === BREAKER_STATE.COOLDOWN) {
      return this._now() >= provider.probeAfter; // half-open probe window
    }
    return true;
  }

  _onSuccess(provider) {
    provider.requestCount += 1;
    provider.consecutiveFailures = 0;
    provider.lastStatus = 200;
    const prev = provider.breaker;
    provider.breaker = BREAKER_STATE.HEALTHY;
    provider.probeAfter = 0;
    if (prev === BREAKER_STATE.RATE_LIMITED || prev === BREAKER_STATE.COOLDOWN || prev === BREAKER_STATE.DEGRADED) {
      this._emit('PROVIDER_RECOVERED', { provider: provider.name, from: prev });
    }
  }

  _onFailure(provider, cls, status) {
    provider.requestCount += 1;
    provider.consecutiveFailures += 1;
    provider.failCount += 1;
    provider.lastStatus = status;
    if (cls === ERROR_CLASS.AUTH || cls === ERROR_CLASS.CONFIG) {
      provider.breaker = BREAKER_STATE.OFFLINE;
      provider.probeAfter = 0;
      this._emit('PROVIDER_OFFLINE', { provider: provider.name, reason: cls, status: status });
    } else if (status === 429) {
      provider.breaker = BREAKER_STATE.RATE_LIMITED;
      provider.probeAfter = this._now() + this.cfg.probeAfterMs;
      this._emit('PROVIDER_COOLDOWN', { provider: provider.name, reason: 'rate_limited', status: status, cooldownMs: this.cfg.cooldownMs, probeAfterMs: this.cfg.probeAfterMs });
    } else if (cls === ERROR_CLASS.TRANSIENT) {
      provider.breaker = BREAKER_STATE.COOLDOWN;
      provider.probeAfter = this._now() + this.cfg.probeAfterMs;
      this._emit('PROVIDER_COOLDOWN', { provider: provider.name, reason: 'transient', status: status, cooldownMs: this.cfg.cooldownMs, probeAfterMs: this.cfg.probeAfterMs });
    } else {
      provider.breaker = BREAKER_STATE.DEGRADED;
    }
  }

  async _tryProvider(provider, messages, mode, onChunk, isStreaming) {
    const startedAt = this._now();
    const controller = new AbortController();
    let ttftTimer = null;
    let totalTimer = null;
    let gotFirstChunk = false;
    let firstChunkLatency = null;

    // The TTFT budget only covers the FIRST chunk: once streaming starts the
    // timer is cleared and only the overall streaming budget applies.
    const wrappedChunk = isStreaming ? (chunk) => {
      if (!gotFirstChunk) {
        gotFirstChunk = true;
        firstChunkLatency = this._now() - startedAt;
        if (ttftTimer) { this._clearTimeout(ttftTimer); ttftTimer = null; }
      }
      if (onChunk) onChunk(chunk);
    } : null;

    const armTimeouts = () => {
      if (isStreaming) {
        ttftTimer = this._setTimeout(() => { if (!gotFirstChunk) controller.abort(); }, this.cfg.ttftMs);
        totalTimer = this._setTimeout(() => controller.abort(), this.cfg.streamingTotalMs);
      } else {
        totalTimer = this._setTimeout(() => controller.abort(), this.cfg.jsonTotalMs);
      }
    };
    armTimeouts();

    try {
      const text = await this._callProvider(provider.name, messages, mode, wrappedChunk, controller.signal);
      return { ok: true, text: String(text || ''), latencyMs: this._now() - startedAt, ttftMs: firstChunkLatency, status: 200 };
    } catch (err) {
      console.error("RAW ROUTER ERROR:", provider.name, err && err.message);
      const cls = classifyError(err);
      return { ok: false, error: err, class: cls, status: extractStatus(err), latencyMs: this._now() - startedAt, ttftMs: firstChunkLatency };
    } finally {
      if (ttftTimer) { this._clearTimeout(ttftTimer); ttftTimer = null; }
      if (totalTimer) { this._clearTimeout(totalTimer); totalTimer = null; }
    }
  }

  // Main entry: try providers in order until one succeeds.
  async request(messages, opts) {
    opts = opts || {};
    const mode = opts.mode === true;
    const onChunk = typeof opts.onChunk === 'function' ? opts.onChunk : null;
    const isStreaming = !mode && !!onChunk;
    const attempts = [];
    let failedBefore = false;
    let lastClass = ERROR_CLASS.UNKNOWN;

    for (const name of this.cfg.order) {
      const provider = this.providers[name];
      if (!provider || provider.enabled === false) continue;
      // Key availability is evaluated against the pooled list, so a provider
      // with any comma-separated key is routable (round-robin picks one).
      const hasKey = this._hasKey(name);
      if (!hasKey) {
        attempts.push({ provider: name, skipped: 'missing_key' });
        continue;
      }
      if (!this._canTry(provider)) {
        attempts.push({ provider: name, skipped: 'cooldown' });
        this._emit('PROVIDER_SKIPPED', { provider: name, breaker: provider.breaker });
        continue;
      }
      const attempt = await this._tryProvider(provider, messages, mode, onChunk, isStreaming);
      if (attempt.ok) {
        this._onSuccess(provider);
        const fallback = failedBefore;
        this._emit('PROVIDER_SUCCESS', { provider: name, latencyMs: attempt.latencyMs, ttftMs: attempt.ttftMs, fallback });
        return {
          text: attempt.text,
          provider: name,
          fallback,
          latencyMs: attempt.latencyMs,
          ttftMs: attempt.ttftMs,
          attempts
        };
      }
      attempts.push({ provider: name, status: attempt.status, cls: attempt.class, latencyMs: attempt.latencyMs });
      failedBefore = true;
      lastClass = attempt.class;
      this._emit('PROVIDER_FAILURE', { provider: name, cls: attempt.class, status: attempt.status, latencyMs: attempt.latencyMs });
      this._onFailure(provider, attempt.class, attempt.status);
    }

    const err = new Error(
      'All providers failed: ' + attempts.map(a => a.provider + ':' + (a.skipped ? a.skipped : (a.status != null ? a.status : 'ERR'))).join(', ')
    );
    err.errorClass = lastClass;
    err.providerAttempts = attempts;
    throw err;
  }

  _callProvider(name, messages, mode, onChunk, signal) {
    if (name === 'groq') return this._callGroq(messages, mode, onChunk, signal);
    if (name === 'openrouter') return this._callOpenRouter(messages, mode, onChunk, signal);
    if (name === 'cerebras') return this._callCerebras(messages, mode, onChunk, signal);
    return Promise.reject(new Error('Unknown provider: ' + name));
  }

  async _callGroq(messages, mode, onChunk, signal) {
    return this._callChatCompletions(
      'groq',
      'https://api.groq.com/openai/v1/chat/completions',
      messages, mode, onChunk, signal
    );
  }

  async _callOpenRouter(messages, mode, onChunk, signal) {
    return this._callChatCompletions(
      'openrouter',
      'https://openrouter.ai/api/v1/chat/completions',
      messages, mode, onChunk, signal
    );
  }

  async _callCerebras(messages, mode, onChunk, signal) {
    return this._callChatCompletions(
      'cerebras',
      'https://api.cerebras.ai/v1/chat/completions',
      messages, mode, onChunk, signal
    );
  }

  // OpenAI-compatible chat-completions call shared by Groq/OpenRouter/Cerebras.
  // Fast (mode=true) JSON mode only requests response_format on Groq, since the
  // free OpenRouter/Cerebras models don't all support json_object responses.
  async _callChatCompletions(name, endpoint, messages, mode, onChunk, signal) {
    const isFast = mode === true;
    const key = this._getActiveKey(name);
    if (!key) throw new Error(name + ' API key is missing');
    const model = this.providers[name].models[isFast ? 'fast' : 'answer'];
    const body = {
      model,
      messages,
      temperature: this.cfg.temperature,
      ...(isFast && name === 'groq' ? { response_format: { type: 'json_object' } } : {})
    };
    if (!isFast && onChunk) body.stream = true;
    const res = await this._fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal
    });
    if (!res.ok) throw new Error(name + ' API ' + res.status + ' ' + (res.statusText || ''));
    if (!isFast && onChunk) return readGroqStream(res, onChunk);
    const data = await res.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  }
}

module.exports = {
  ProviderRouter,
  classifyError,
  extractStatus,
  ERROR_CLASS,
  BREAKER_STATE,
  DEFAULT_ROUTER_CFG,
  readGroqStream
};