'use strict';

const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';

// ── FETCH ─────────────────────────────────
function fetchUrl(url, timeout = 10000) {
  return new Promise((resolve) => {
    try {
      let u = url.trim();
      if (!u.startsWith('http')) u = 'https://' + u;
      const parsed = new URL(u);
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.request({
        hostname: parsed.hostname,
        path: parsed.pathname + (parsed.search || ''),
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,*/*',
          'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
        },
        timeout,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let loc = res.headers.location;
          if (!loc.startsWith('http')) loc = parsed.origin + loc;
          fetchUrl(loc, timeout).then(resolve);
          return;
        }
        if (res.statusCode >= 400) { resolve(''); return; }
        let d = '';
        res.setEncoding('utf8');
        res.on('data', c => { d += c; if (d.length > 500000) { req.destroy(); resolve(d); } });
        res.on('end', () => resolve(d));
      });
      req.on('timeout', () => { req.destroy(); resolve(''); });
      req.on('error', () => resolve(''));
      req.end();
    } catch(e) { resolve(''); }
  });
}

// ── STRIP HTML ────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── DISCOVER PAGES ────────────────────────
function discoverPages(html, origin) {
  const important = ['servicii','preturi','tarife','tratamente','faq','intrebari','despre','echipa','contact','program','medici'];
  const found = new Set();
  
  for (const m of html.matchAll(/href=["']([^"'#?]+)["']/gi)) {
    const href = m[1];
    let full = href.startsWith('http') ? href : (href.startsWith('/') ? origin + href : null);
    if (!full) continue;
    try {
      const u = new URL(full);
      if (u.hostname !== new URL(origin).hostname) continue;
      if (important.some(k => u.pathname.toLowerCase().includes(k))) {
        found.add(full.split('?')[0]);
      }
    } catch(e) {}
  }
  
  // Also try static paths
  important.forEach(p => found.add(origin + '/' + p));
  
  return [...found].slice(0, 10);
}

// ── CLAUDE API ────────────────────────────
function callClaude(system, user) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: user }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 90000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d).content?.[0]?.text || ''); }
        catch(e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Claude timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── MAIN: BUILD BUSINESS BRAIN ────────────
async function buildBusinessBrain(siteUrl, options = {}) {
  const { onProgress } = options;
  const progress = (pct, text) => { if (onProgress) onProgress(pct, text); console.log(`[BRAIN] ${pct}% ${text}`); };

  let origin;
  try {
    const u = new URL(siteUrl.startsWith('http') ? siteUrl : 'https://' + siteUrl);
    origin = u.origin;
  } catch(e) { throw new Error('URL invalid'); }

  progress(10, 'Descărcare homepage...');
  const homepageHtml = await fetchUrl(origin);
  if (!homepageHtml) throw new Error('Site inaccesibil');

  progress(20, 'Descoperire pagini importante...');
  const pages = discoverPages(homepageHtml, origin);
  console.log('[BRAIN] Pages to fetch:', pages.length);

  progress(30, 'Descărcare pagini...');
  const pageContents = await Promise.all(
    pages.map(async (url) => {
      const html = await fetchUrl(url, 8000);
      return html ? `\n\n=== PAGINA: ${url} ===\n${stripHtml(html).substring(0, 5000)}` : '';
    })
  );

  // Combine all content
  const fullContent = (stripHtml(homepageHtml) + pageContents.join('')).substring(0, 25000);

  progress(50, 'Claude analizează site-ul complet...');

  const system = `Ești un expert în analiza afacerilor locale din România. 
Citești conținutul unui website și extragi TOATE informațiile disponibile.
NU inventa informații care nu există pe site.
NU completa cu valori generice.
Dacă o informație nu există pe site, pune null.
Returnezi DOAR JSON valid, fără markdown, fără text extra.`;

  const prompt = `Analizează acest website românesc și construiește un Business Brain complet.

URL: ${siteUrl}

CONȚINUT SITE (toate paginile):
${fullContent}

Returnează EXACT acest JSON (completează cu ce găsești, null dacă nu există):
{
  "name": "numele afacerii",
  "brand": "brandul scurt",
  "description": "descriere scurtă 1-2 propoziții",
  "industry": "dental/vet/beauty/physio/auto/other",
  "address": "adresa completă sau null",
  "city": "orașul sau null",
  "phone": "telefonul principal sau null",
  "phone_urgente": "telefon urgențe sau null",
  "email": "emailul principal sau null",
  "email_programari": "email programări sau null",
  "whatsapp": "număr whatsapp sau null",
  "facebook": "URL facebook sau null",
  "instagram": "URL instagram sau null",
  "website": "${siteUrl}",
  "hours": "program complet text sau null",
  "hours_structured": {
    "luni": "09:00-18:00 sau null",
    "marti": null,
    "miercuri": null,
    "joi": null,
    "vineri": null,
    "sambata": null,
    "duminica": null,
    "urgente": "24/7 sau null"
  },
  "parking": "descriere parcare sau null",
  "accessibility": "acces persoane dizabilități sau null",
  "payment_methods": ["cash", "card", "rate"],
  "financing": "detalii rate/finanțare sau null",
  "insurance": ["lista asigurări acceptate"],
  "languages": ["română"],
  "doctors": [{"name": "Dr. Nume", "specialty": "specialitatea"}],
  "services": [{"name": "serviciu", "price": "preț RON sau null", "duration": "durată sau null", "description": "descriere sau null"}],
  "packages": [],
  "promotions": ["promotii active sau null"],
  "faq": [{"question": "întrebarea exactă de pe site", "answer": "răspunsul exact de pe site"}],
  "guarantees": "garanții oferite sau null",
  "emergency": "detalii urgențe sau null",
  "booking": "cum se face programarea sau null",
  "children": "acceptați copii sau null",
  "specialties": ["lista specialități"],
  "technologies": ["tehnologii/echipamente sau null"],
  "certificates": "certificări sau null",
  "confidence": 85
}`;

  let result;
  try {
    const raw = await callClaude(system, prompt);
    let clean = raw.replace(/```json|```/g, '').trim();
    // Fix truncated JSON
    if (!clean.endsWith('}')) {
      const lastBrace = clean.lastIndexOf('}');
      if (lastBrace > 0) clean = clean.substring(0, lastBrace + 1);
      // Close any open structures
      try { JSON.parse(clean); } catch(e) { clean = clean + '}}'; }
    }
    try { result = JSON.parse(clean); }
    catch(e) {
      // Try to extract partial JSON
      const nameMatch = clean.match(/"name"\s*:\s*"([^"]+)"/);
      const phoneMatch = clean.match(/"phone"\s*:\s*"([^"]+)"/);
      result = { name: nameMatch?.[1], phone: phoneMatch?.[1], services: [], faq: [], confidence: 50, _partial: true };
    }
    progress(90, `Complet! ${result.services?.length || 0} servicii, ${result.faq?.length || 0} FAQ`);
  } catch(e) {
    console.error('[BRAIN] Claude error:', e.message);
    throw new Error('Eroare analiză Claude: ' + e.message);
  }

  result.scannedAt = new Date().toISOString();
  result.scannerVersion = 'brain-v1';

  progress(100, 'Business Brain construit!');
  return result;
}

module.exports = { buildBusinessBrain };
