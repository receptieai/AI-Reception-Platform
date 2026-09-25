'use strict';

// ─────────────────────────────────────────────────────────────────────
// RecepAI Founder Dashboard — server standalone
//
// Reuse-și scanner-ul recepAI (../backend/scanner) ca să fie același
// cod care rulează pentru clienți. Clienții primesc rezultatul direct;
// tu (fondator) îl vezi aici + îl poți corecta + calibra.
//
// Fără deps: Node pur, fs + http + path. Rulează:
//   node founder-dashboard/server.js
// Deschide:
//   http://localhost:8081
//
// PORT poate fi suprapus cu env PORT.
// ─────────────────────────────────────────────────────────────────────

const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8081;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const WEB  = path.join(ROOT, 'index.html');

// Reuse scanner-ul recepAI
const { scan } = require(path.join(ROOT, '..', 'backend', 'scanner', 'index.js'));
const scannerLearning = require(path.join(ROOT, '..', 'backend', 'learning', 'scannerLearning.js'));

// ── small JSON store helpers ────────────────────────────────────────
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

const GOLDEN = path.join(DATA, 'golden.json');
const LEARN  = path.join(DATA, 'learning.json');
const METRIC = path.join(DATA, 'metrics.json');

// ── CORS + helpers ──────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function safeError(res, e) {
  console.error('[FOUNDER-DASH] error:', e);
  json(res, 500, { error: e.message || 'Internal error' });
}

// ── scan cache (in-memory, per URL) — rescan-ul e instant ─────────
const SCAN_CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── golden set operations ───────────────────────────────────────────
function goldenAll() {
  return readJson(GOLDEN, { items: [] }).items || [];
}
function goldenFind(id) {
  return goldenAll().find(g => g.id === id) || null;
}
function goldenUpdate(item) {
  const doc = readJson(GOLDEN, { items: [] });
  const idx = doc.items.findIndex(g => g.id === item.id);
  if (idx >= 0) doc.items[idx] = { ...doc.items[idx], ...item, history: item.history || doc.items[idx].history };
  else doc.items.push(item);
  doc._meta.updatedAt = new Date().toISOString();
  writeJson(GOLDEN, doc);
  return doc;
}

// ── learning operations ─────────────────────────────────────────────
function learningAll() { return readJson(LEARN, { recommendations: [], corrections: [], stats: {} }); }
function learningSave(doc) {
  doc._meta = doc._meta || {};
  doc._meta.updatedAt = new Date().toISOString();
  const stats = {
    totalRecommendations: (doc.recommendations || []).length,
    approved: (doc.recommendations || []).filter(r => r.status === 'approved').length,
    pending: (doc.recommendations || []).filter(r => r.status === 'pending').length,
    dismissed: (doc.recommendations || []).filter(r => r.status === 'dismissed').length,
    totalCorrections: (doc.corrections || []).length,
  };
  doc.stats = stats;
  writeJson(LEARN, doc);
  return doc;
}

// ── scan + verify + correction flow ────────────────────────────────
async function runScan(item, force = false) {
  const cacheKey = item.id + ':' + item.url;
  const cached = SCAN_CACHE.get(cacheKey);
  if (cached && !force && (Date.now() - cached.at < CACHE_TTL_MS)) return cached.result;

  const industry = item.industry === 'auto' ? undefined : item.industry;
  const result = await scan(item.url, {
    industry,
    businessKey: item.id,
    maxPages: 15,
    timeout: 12000,
  });

  // Record this result in the item's history
  const entry = {
    at: new Date().toISOString(),
    global: result.confidence,
    fields: result.fieldConfidence || {},
    servicesCount: (result.services || []).length,
    pricesCount: (result.services || []).filter(s => s.price).length,
    ready: result.readiness ? result.readiness.score : null,
    pages: result._meta ? result._meta.pagesScanned : null,
    durationMs: result._meta ? result._meta.durationMs : null,
  };
  item.history = (item.history || []);
  item.history.push(entry);
  if (item.history.length > 20) item.history = item.history.slice(-20);

  // Golden accuracy: how well did the scan hit the expected targets?
  if (item.expected) {
    entry.accuracy = goldenAccuracy(item, result);
  }
  goldenUpdate(item);

  const out = { ...result, _golden: entry };
  SCAN_CACHE.set(cacheKey, { at: Date.now(), result: out });
  return out;
}

// Compute how close the scan is to the golden expectation
function goldenAccuracy(item, result) {
  const e = item.expected || {};
  const svc = (result.services || []).filter(s => s.method !== 'typical').length;
  const prc = (result.services || []).filter(s => s.price && s.method !== 'typical').length;
  let score = 0, total = 0;

  if (e.minServices != null) { total++; score += svc >= e.minServices ? 1 : svc / e.minServices; }
  if (e.minPrices   != null) { total++; score += prc >= e.minPrices   ? 1 : prc / e.minPrices; }
  if (e.hasPhone)             { total++; score += result.phone ? 1 : 0; }
  if (e.hasEmail)             { total++; score += result.email ? 1 : 0; }
  if (e.hasHours)             { total++; score += result.hours  ? 1 : 0; }

  return Math.round((score / total) * 100);
}

// ── HTTP server ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const p = u.pathname;
  const m = req.method;

  if (m === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  // ── API ────────────────────────────────────────────────────────
  if (p.startsWith('/api/founder/')) {
    try {
      // GET /api/founder/state — everything on one call (dashboard load)
      if (p === '/api/founder/state' && m === 'GET') {
        return json(res, 200, {
          golden: readJson(GOLDEN, { items: [] }),
          learning: readJson(LEARN, { recommendations: [], corrections: [], stats: {} }),
          metrics: readJson(METRIC, {}),
        });
      }

      // POST /api/founder/scan — scan a golden item
      if (p === '/api/founder/scan' && m === 'POST') {
        const body = await readBody(req);
        const item = goldenFind(body.id);
        if (!item) return json(res, 404, { error: 'Golden item not found: ' + body.id });
        const result = await runScan(item, !!body.force);
        return json(res, 200, { ok: true, result });
      }

      // POST /api/founder/golden — add a new golden item
      if (p === '/api/founder/golden' && m === 'POST') {
        const body = await readBody(req);
        if (!body.url || !body.name) return json(res, 400, { error: 'name + url required' });
        const doc = readJson(GOLDEN, { items: [] });
        const slug = (body.name || body.url).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
        const newItem = {
          id: slug + '_' + Date.now().toString(36),
          name: body.name,
          url: body.url,
          industry: body.industry || 'auto',
          city: body.city || null,
          verified: false,
          verifiedBy: null,
          notes: body.notes || '',
          expected: body.expected || { minServices: 5, minPrices: 0, hasPhone: true },
          history: [],
        };
        doc.items.push(newItem);
        writeJson(GOLDEN, doc);
        return json(res, 201, { ok: true, item: newItem });
      }

      // PATCH /api/founder/golden/:id — verify, update expected, mark verified
      const gpatch = p.match(/^\/api\/founder\/golden\/([\w-]+)$/);
      if (gpatch && m === 'POST') {
        const body = await readBody(req);
        const item = goldenFind(gpatch[1]);
        if (!item) return json(res, 404, { error: 'not found' });
        if (body.verified !== undefined) { item.verified = !!body.verified; item.verifiedBy = body.verifiedBy || 'founder'; }
        if (body.expected) item.expected = { ...item.expected, ...body.expected };
        if (body.notes !== undefined) item.notes = body.notes;
        if (body.industry) item.industry = body.industry;
        goldenUpdate(item);
        return json(res, 200, { ok: true, item });
      }

      // POST /api/founder/correction — record a correction (feeds scannerLearning)
      if (p === '/api/founder/correction' && m === 'POST') {
        const body = await readBody(req);
        // body: { id, field, correction, previousValue, detector }
        const entry = scannerLearning.recordCorrection(
          'founder_' + (body.id || 'global'),
          body.field || 'unknown',
          body.correction,
          { previousValue: body.previousValue, detector: body.detector || 'founder-lab' }
        );
        // Also store in learning.json for the dashboard UI
        const doc = learningAll();
        doc.corrections = doc.corrections || [];
        doc.corrections.unshift({
          id: entry.id,
          industry: body.industry || 'global',
          field: body.field,
          previousValue: body.previousValue,
          correctedValue: typeof body.correction === 'string' ? body.correction : JSON.stringify(body.correction).slice(0, 120),
          reason: body.reason || 'corecție manuală în Scan & Learn Lab',
          appliedTo: 0,
          createdAt: entry.timestamp,
        });
        learningSave(doc);
        return json(res, 201, { ok: true, entry });
      }

      // POST /api/founder/learning/:id — approve/dismiss a recommendation
      const lpatch = p.match(/^\/api\/founder\/learning\/([\w-]+)$/);
      if (lpatch && m === 'POST') {
        const body = await readBody(req);
        const doc = learningAll();
        const rec = doc.recommendations.find(r => r.id === lpatch[1]);
        if (!rec) return json(res, 404, { error: 'recommendation not found' });
        rec.status = body.status === 'approved' || body.status === 'dismissed' ? body.status : rec.status;
        if (rec.status === 'approved') rec.appliedAt = new Date().toISOString();
        learningSave(doc);
        return json(res, 200, { ok: true, rec });
      }

      // POST /api/founder/metrics/reset — reset metrics to defaults
      if (p === '/api/founder/metrics/reset' && m === 'POST') {
        const defaults = {
          mrr: 0, activeClients: 0,
          clientsByIndustry: { dental: 0, vet: 0, beauty: 0, physio: 0, other: 0 },
          leadsToday: 0, leadsTotal: 0,
          avgResponseTimeSec: 1.8,
          costAI: 0, costPerClient: 0,
          gatewayStatus: { openmayhem: 'unknown', claudeFallback: 'off' },
          alerts: [],
          feed: [],
        };
        defaults._meta = { version: 1, updatedAt: new Date().toISOString(), note: 'Reset manually' };
        writeJson(METRIC, defaults);
        return json(res, 200, { ok: true });
      }

      // Fallback — unknown API route
      return json(res, 404, { error: 'Unknown founder route: ' + p });
    } catch (e) {
      return safeError(res, e);
    }
  }

  // ── Static ─────────────────────────────────────────────────────
  if (m === 'GET' && (p === '/' || p === '/index.html')) {
    try {
      const html = fs.readFileSync(WEB, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('index.html missing: ' + e.message);
    }
  }

  // Favicon / 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 — ' + p);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  🧠  RecepAI Founder Dashboard');
  console.log('');
  console.log('     → ' + 'http://localhost:' + PORT);
  console.log('');
  console.log('     Scanner: reusit din ../backend/scanner');
  console.log('     Data:    ' + DATA);
  console.log('');
});
