'use strict';

// ── Scanner Learning Engine ──────────────────────────────────────────
// Different from the CONVERSATIONAL Learning Engine (conversationAnalyzer).
//
// This one learns from SCANNER corrections. When a client manually
// corrects a scanned field, we capture:
//   - which field was wrong / missing   (the gap)
//   - the corrected value               (the truth)
//   - the page label + HTML snippet     (the PATTERN the extractor missed)
//   - the detector that produced the wrong value
//
// These patterns accumulate in data/scanner_corrections.json and power
// two things:
//   1. A per-site "known corrections" map the scanner applies before it
//      trusts its own extractors (corrections always win).
//   2. Aggregated statistics (which detectors underperform, which field
//      types are most often missed) for extractor tuning.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const FILE = path.join(DATA_DIR, 'scanner_corrections.json');

function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return raw;
  } catch (e) {
    return { corrections: [], patterns: {}, stats: {} };
  }
}

function save(db) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

// Capture an HTML snippet around where the corrected value SHOULD have
// been (or where the wrong value was). Bounded, tag-stripped optional.
function htmlSnippet(html, anchor, radius = 400) {
  if (!html) return null;
  const clean = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  if (anchor) {
    const idx = clean.indexOf(anchor);
    if (idx >= 0) return clean.slice(Math.max(0, idx - radius), idx + radius + radius);
  }
  return clean.slice(0, radius * 2);
}

// Record a correction.
//   businessKey: clientId or domain — stable identifier
//   field:       'services' | 'phone' | 'price:<name>' | 'hours' | ...
//   correction:  the corrected value
//   scan:        { page, html, previousValue, detector } context
function recordCorrection(businessKey, field, correction, scan = {}) {
  const db = load();
  const entry = {
    id: 'fix_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    businessKey,
    field,
    correction,
    previousValue: scan.previousValue ?? null,
    detector: scan.detector || null,
    industry: scan.industry || null,
    page: scan.page || null,
    htmlPattern: scan.htmlPattern || (scan.html ? htmlSnippet(scan.html, scan.previousValue) : null),
    timestamp: new Date().toISOString(),
    status: 'active', // active | dismissed
  };
  db.corrections.push(entry);

  // Aggregate pattern stats: which field type + detector combo keeps
  // producing corrections → the extractor to improve next.
  const patternKey = (scan.detector || 'unknown') + '::' + field.split(':')[0];
  db.patterns[patternKey] = db.patterns[patternKey] || { count: 0, detectors: new Set(), lastSeen: null };
  db.patterns[patternKey].count++;
  db.patterns[patternKey].lastSeen = entry.timestamp;
  // new Set() does not survive JSON — store as array
  db.patterns[patternKey].detectors = [...new Set([...(Array.isArray(db.patterns[patternKey].detectors) ? db.patterns[patternKey].detectors : []), entry.detector || 'unknown'])];

  save(db);
  return entry;
}

// Corrections to apply for a business, keyed by field.
// The scanner calls this BEFORE merging; any active correction for a
// field overrides the freshly extracted value (corrections always win).
function getCorrections(businessKey) {
  const db = load();
  const out = {};
  for (const c of db.corrections) {
    if (c.businessKey !== businessKey) continue;
    if (c.status !== 'active') continue;
    // Most recent correction for a field wins.
    if (!out[c.field] || out[c.field].timestamp < c.timestamp) out[c.field] = c;
  }
  return out;
}

// Industry-level corrections: a correction recorded for one client in an
// industry applies to ALL clients in that industry (the learning loop).
// Used to FILL a missing field, or OVERRIDE one whose fresh extraction
// failed (low confidence). Most recent correction wins per field.
function getIndustryCorrections(industry) {
  const db = load();
  if (!industry) return {};
  const out = {};
  for (const c of db.corrections) {
    if (c.status !== 'active') continue;
    if (c.industry !== industry) continue;
    if (!c.field || c.field.startsWith('price:')) continue; // field-level only
    if (!out[c.field] || out[c.field].timestamp < c.timestamp) out[c.field] = c;
  }
  return out;
}

// Dismiss a correction (client reverted / it was wrong).
function dismissCorrection(id) {
  const db = load();
  const c = db.corrections.find(x => x.id === id);
  if (c) { c.status = 'dismissed'; save(db); return true; }
  return false;
}

// Aggregated tuning report: what should the extractor team fix next?
function getTuningReport() {
  const db = load();
  const active = db.corrections.filter(c => c.status === 'active');
  const byField = {};
  const byDetector = {};
  for (const c of active) {
    const f = c.field.split(':')[0];
    byField[f] = (byField[f] || 0) + 1;
    const d = c.detector || 'unknown';
    byDetector[d] = (byDetector[d] || 0) + 1;
  }
  return {
    totalActive: active.length,
    byField,
    byDetector,
    topPatterns: Object.entries(db.patterns)
      .map(([k, v]) => ({ key: k, count: v.count, lastSeen: v.lastSeen }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
  };
}

module.exports = { recordCorrection, getCorrections, getIndustryCorrections, dismissCorrection, getTuningReport, load };
