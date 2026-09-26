'use strict';

/**
 * RecepAI Founder Dashboard — clean sync
 *
 * Solves the recurring "git pull fails / code stays stale" problem.
 * One command pulls every code file (not local data) from GitHub main
 * directly, bypassing git. No zsh quoting, no token needed (public repo).
 *
 *   node founder-dashboard/sync.js
 *
 * It only syncs CODE files. It NEVER touches founder-dashboard/data/*.json
 * (those are YOUR local scan history + golden set state).
 */

const fs = require('fs');
const path = require('path');

const REPO = 'receptieai/AI-Reception-Platform';
const BASE = path.join(__dirname, '..'); // AI-Reception-Platform/
const API = 'https://api.github.com/repos/' + REPO + '/contents/';

// Optional token (private repos / rate limits). Reads from .env if present.
function loadToken() {
  try {
    const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    const m = env.match(/GITHUB_TOKEN\s*=\s*(\S+)/);
    return m ? m[1].trim() : null;
  } catch (e) { return null; }
}

// CODE files only — data/ is intentionally excluded (local state).
const FILES = [
  'backend/scanner/index.js',
  'backend/scanner/crawler.js',
  'backend/scanner/mergeEngine.js',
  'backend/scanner/confidenceEngine.js',
  'backend/scanner/pageIntelligence.js',
  'backend/scanner/businessBrain.js',
  'backend/scanner/claudeEngine.js',
  'backend/scanner/inference.js',
  'backend/extractors_v2/index.js',
  'backend/extractors_v2/locationExtractor.js',
  'backend/extractors_v2/contactExtractor.js',
  'backend/extractors_v2/utils.js',
  'backend/extractors_v2/jsonLdExtractor.js',
  'backend/extractors_v2/serviceExtractor.js',
  'backend/extractors_v2/hoursExtractor.js',
  'backend/extractors_v2/doctorExtractor.js',
  'backend/brainbank/brainbank.js',
  'backend/playwrightEngine.js',
  'founder-dashboard/server.js',
  'founder-dashboard/index.html',
  'founder-dashboard/diag.js',
  'founder-dashboard/push.js',
  'founder-dashboard/sync.js',
  'founder-dashboard/.env.example',
  'founder-dashboard/.gitignore',
];

async function fetchFile(relPath, token) {
  const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'RecepAI-Sync' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(API + encodeURIComponent(relPath).replace(/%2F/g, '/'), { headers });
  if (r.status === 404) return { status: 404 };
  if (!r.ok) return { status: r.status, body: (await r.text()).slice(0, 200) };
  const j = await r.json();
  return { status: 200, content: j.content, size: j.size, sha: j.sha };
}

(async () => {
  const token = loadToken();
  console.log('🧠 RecepAI sync — ' + FILES.length + ' code files' + (token ? ' (with token)' : ''));
  let ok = 0, skip = 0;
  for (const f of FILES) {
    const res = await fetchFile(f, token);
    if (res.status === 404) { console.log('  ⏭  ' + f + ' (nu există pe GitHub)'); skip++; continue; }
    if (res.status !== 200) { console.log('  ❌ ' + f + ' HTTP ' + res.status); continue; }
    const local = path.join(BASE, f);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    // content from GitHub API is base64
    const buf = Buffer.from(res.content, 'base64');
    fs.writeFileSync(local, buf);
    console.log('  ✅ ' + f + ' (' + res.size + ' bytes)');
    ok++;
  }
  console.log('\nDone: ' + ok + ' synced' + (skip ? ', ' + skip + ' skipped' : '') + '.');
  console.log('Now:  killall node && node founder-dashboard/server.js');
})().catch(e => { console.log('SYNC ERROR:', e.message); process.exit(1); });
