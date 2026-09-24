'use strict';

// ── Unified inference layer ─────────────────────────────────────────
// Routes the scanner's "fill missing fields" call through:
//   1. Local OpenMayhem gateway (OpenAI-compatible, http://127.0.0.1:11435)
//      if it is reachable and has a live chat model
//   2. Claude API (fallback, needs CLAUDE_API_KEY)
//   3. null (skip — extractors + Business Brain results stand alone)
//
// RULE #1 (no overfitting): this layer is 100% generic. The prompt it
// sends is the standard business-extraction prompt from claudeEngine —
// nothing site-specific. OpenMayhem is just a cheaper inference route,
// the scanner logic is unchanged.
//
// The gateway runs on the OPERATOR'S machine (mayhem up). So the
// gateway route is only usable when the scanner runs on that same
// machine (local benchmarks). On Railway it silently falls back to
// Claude. That is intentional — live widget traffic stays on Claude.

const http = require('http');
const https = require('https');
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 2000;

const GATEWAY_URL = (process.env.MAYHEM_GATEWAY || 'http://127.0.0.1:11435').replace(/\/+$/, '');

let engineCache = { ok: false, model: null, checkedAt: 0 };
const PROBE_TTL_MS = 60000; // re-probe the gateway at most once a minute

// ── tiny JSON-over-HTTP helper ──────────────────────────────────────
function httpJson(method, url, body, headers = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const req = mod.request(u, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers,
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error('HTTP ' + res.statusCode + ' ' + data.slice(0, 200)));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Bad JSON from gateway: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── probe: does the local gateway have a usable chat model? ────────
function pickModel(ids) {
  if (!ids.length) return null;
  // Prefer instruct/assistant-style models, then anything that looks
  // chat-capable. Deliberately generic — no model hardcoded as "the"
  // one; the local catalog decides.
  const score = (id) => {
    const s = String(id).toLowerCase();
    let sc = 0;
    if (s.includes('instruct')) sc += 4;
    if (s.includes('assistant')) sc += 3;
    if (s.includes('chat')) sc += 2;
    if (/8b|14b/.test(s)) sc += 1; // 8–14B instruct models are the
                                    // agent-class the docs recommend
    return sc;
  };
  return [...ids].sort((a, b) => score(b) - score(a))[0];
}

async function probeGateway() {
  const now = Date.now();
  if (engineCache.checkedAt && now - engineCache.checkedAt < PROBE_TTL_MS) {
    return engineCache;
  }
  try {
    const res = await httpJson('GET', GATEWAY_URL + '/v1/models', null, {}, 6000);
    const ids = (res.data || res.models || []).map(m => m.id || m.name).filter(Boolean);
    const model = pickModel(ids);
    engineCache = { ok: !!model, model: model || null, models: ids, checkedAt: now };
  } catch (e) {
    engineCache = { ok: false, model: null, models: [], checkedAt: now, error: e.message };
  }
  return engineCache;
}

async function gatewayChat(model, prompt, timeout = 120000) {
  const res = await httpJson('POST', GATEWAY_URL + '/v1/chat/completions', {
    model,
    temperature: 0,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  }, {}, timeout);
  const text = res.choices && res.choices[0] && res.choices[0].message
    ? res.choices[0].message.content
    : null;
  if (!text) throw new Error('gateway returned no content');
  return text;
}

// ── Claude fallback (same behaviour as the old claudeEngine) ───────
function callClaude(prompt, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.content?.[0]?.text || '');
        } catch (e) { reject(new Error('Claude parse error: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Claude timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── public API ──────────────────────────────────────────────────────
// Returns { text, engine } where engine = 'openmayhem' | 'claude' | 'none'
async function chatCompletion(prompt, apiKey) {
  const probe = await probeGateway();
  if (probe.ok) {
    try {
      const text = await gatewayChat(probe.model, prompt);
      console.log('[INFER] engine: openmayhem (' + probe.model + ')');
      return { text, engine: 'openmayhem' };
    } catch (e) {
      console.log('[INFER] gateway request failed, falling back: ' + e.message);
    }
  } else {
    console.log('[INFER] no local OpenMayhem gateway' + (probe.error ? ' (' + probe.error + ')' : '') + ' at ' + GATEWAY_URL);
  }
  if (apiKey) {
    const text = await callClaude(prompt, apiKey);
    console.log('[INFER] engine: claude');
    return { text, engine: 'claude' };
  }
  console.log('[INFER] no gateway and no Claude key — skipping AI fill');
  return { text: null, engine: 'none' };
}

module.exports = { chatCompletion, probeGateway, GATEWAY_URL };
