/**
 * RecepAI Health Monitor v1.0
 * Checks: Server, Claude API, Storage, Integrations, Railway
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const checks = {

  // ── CLAUDE API ──
  async claude() {
    const key = process.env.CLAUDE_API_KEY;
    if (!key) return { status: 'error', message: 'API key lipsă' };
    return new Promise((resolve) => {
      const body = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }]
      });
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 8000,
      }, (res) => {
        resolve(res.statusCode === 200
          ? { status: 'ok', message: 'Claude API operațional' }
          : { status: 'error', message: 'Claude API status ' + res.statusCode });
      });
      req.on('timeout', () => { req.destroy(); resolve({ status: 'error', message: 'Claude API timeout' }); });
      req.on('error', (e) => resolve({ status: 'error', message: e.message }));
      req.write(body);
      req.end();
    });
  },

  // ── STORAGE ──
  async storage() {
    const dataDir = path.join(__dirname, '../data');
    const files = ['profiles.json', 'users.json'];
    const results = {};
    let allOk = true;

    for (const f of files) {
      const fp = path.join(dataDir, f);
      if (fs.existsSync(fp)) {
        try {
          JSON.parse(fs.readFileSync(fp, 'utf8'));
          results[f] = 'ok';
        } catch(e) {
          results[f] = 'corrupt';
          allOk = false;
        }
      } else {
        results[f] = 'missing';
      }
    }

    const diskSpace = await getDiskSpace(dataDir);
    return {
      status: allOk ? 'ok' : 'warning',
      message: allOk ? 'Storage operațional' : 'Unele fișiere lipsesc',
      files: results,
      diskSpace,
    };
  },

  // ── GMAIL ──
  async gmail(clientId) {
    const storage = require('./storage');
    const settings = storage.getSettings(clientId || 'default');
    if (!settings.gmail?.connected) return { status: 'disconnected', message: 'Gmail neconectat' };
    if (!settings.gmail?.accessToken) return { status: 'error', message: 'Token Gmail lipsă' };
    return { status: 'ok', message: 'Gmail conectat: ' + (settings.gmail.email || '—') };
  },

  // ── WHATSAPP ──
  async whatsapp(clientId) {
    const storage = require('./storage');
    const settings = storage.getSettings(clientId || 'default');
    if (!settings.whatsapp?.connected) return { status: 'disconnected', message: 'WhatsApp neconectat' };
    return { status: 'ok', message: 'WhatsApp conectat' };
  },

  // ── RAILWAY / SERVER ──
  async server() {
    const uptime = process.uptime();
    const mem = process.memoryUsage();
    return {
      status: 'ok',
      message: 'Server operațional',
      uptime: formatUptime(uptime),
      memory: Math.round(mem.heapUsed / 1024 / 1024) + ' MB',
      node: process.version,
    };
  },
};

// ── RUN ALL CHECKS ──
async function runAll(clientId) {
  const start = Date.now();
  const results = {};

  const checkList = ['server', 'claude', 'storage'];
  if (clientId) checkList.push('gmail', 'whatsapp');

  await Promise.all(checkList.map(async (name) => {
    try {
      results[name] = await checks[name](clientId);
    } catch(e) {
      results[name] = { status: 'error', message: e.message };
    }
  }));

  const allOk = Object.values(results).every(r => r.status === 'ok' || r.status === 'disconnected');
  const hasError = Object.values(results).some(r => r.status === 'error');

  return {
    status: hasError ? 'error' : allOk ? 'ok' : 'warning',
    checkedAt: new Date().toISOString(),
    duration: Date.now() - start + 'ms',
    checks: results,
  };
}

// ── HELPERS ──
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}z ${h}h ${m}m`;
}

async function getDiskSpace(dir) {
  try {
    const files = fs.readdirSync(dir);
    let size = 0;
    for (const f of files) {
      try { size += fs.statSync(path.join(dir, f)).size; } catch(e) {}
    }
    return Math.round(size / 1024) + ' KB';
  } catch(e) { return 'unknown'; }
}

module.exports = { runAll, checks };
