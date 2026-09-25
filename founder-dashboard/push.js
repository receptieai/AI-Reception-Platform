'use strict';

/**
 * RecepAI Founder Dashboard — Push script
 *
 * Usage:
 *   node founder-dashboard/push.js
 *
 * Reads GITHUB_TOKEN from .env (same folder).
 * Pushes all local files that differ from GitHub main.
 * No token in chat, ever.
 */

const fs = require('fs');
const path = require('path');

// ── Load .env ──────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  console.log('❌ Missing .env file.');
  console.log('   Copy .env.example to .env and put your token there:');
  console.log('     cp .env.example .env');
  console.log('   Then edit .env and set GITHUB_TOKEN=github_pat_...');
  process.exit(1);
}
const envContent = fs.readFileSync(envPath, 'utf8');
const m = envContent.match(/GITHUB_TOKEN\s*=\s*(\S+)/);
if (!m) { console.log('❌ GITHUB_TOKEN not found in .env'); process.exit(1); }
const TOKEN = m[1].trim();

const REPO = 'receptieai/AI-Reception-Platform';
const BASE = path.join(__dirname, '..');

// ── Files to push (all founder-dashboard + key backend fixes) ─
const FILES = [
  'founder-dashboard/server.js',
  'founder-dashboard/index.html',
  'founder-dashboard/diag.js',
  'founder-dashboard/push.js',
  'founder-dashboard/.env.example',
  'founder-dashboard/.gitignore',
  'founder-dashboard/data/golden.json',
  'founder-dashboard/data/learning.json',
  'founder-dashboard/data/metrics.json',
  'backend/scanner/crawler.js',
  'backend/extractors_v2/index.js',
  'backend/extractors_v2/utils.js',
  'backend/extractors_v2/contactExtractor.js',
];

function api(p, method, body) {
  const headers = {
    'Authorization': 'Bearer ' + TOKEN,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'RecepAI-Push',
  };
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  return fetch('https://api.github.com/repos/' + REPO + p, { method, headers, body: payload })
    .then(r => r.text().then(t => ({ status: r.status, body: t })));
}

async function getRemoteSha(relPath) {
  const r = await api('/contents/' + relPath, 'GET');
  if (r.status === 200) return JSON.parse(r.body).sha;
  return null;
}

async function pushOne(relPath) {
  const localPath = path.join(BASE, relPath);
  if (!fs.existsSync(localPath)) { console.log('⏭  ' + relPath + ' (not local, skip)'); return true; }
  const b64 = fs.readFileSync(localPath, 'base64');
  const sha = await getRemoteSha(relPath);
  const body = {
    message: 'founder: ' + relPath,
    content: b64,
  };
  if (sha) body.sha = sha;
  const r = await api('/contents/' + relPath, 'PUT', body);
  if (r.status === 200 || r.status === 201) {
    console.log('✅ ' + relPath);
    return true;
  }
  console.log('❌ ' + relPath + ' HTTP ' + r.status + ' ' + r.body.slice(0, 120));
  return false;
}

(async () => {
  console.log('🧠 RecepAI push — ' + FILES.length + ' files');
  let ok = 0, skipped = 0;
  for (const f of FILES) {
    if (await pushOne(f)) ok++;
  }
  console.log('\nDone: ' + ok + '/' + FILES.length + ' pushed.');
  process.exit(ok === FILES.length ? 0 : 1);
})();
