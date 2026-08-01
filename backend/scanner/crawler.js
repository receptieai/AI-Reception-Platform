'use strict';

const http = require('http');
const https = require('https');

const PRIORITY_PATHS = [
  '/', '/servicii', '/servicii/', '/tarife', '/tarife/', '/preturi', '/preturi/',
  '/contact', '/contact/', '/despre', '/despre-noi', '/echipa', '/echipa/',
  '/medici', '/doctori', '/doctori/', '/faq', '/faq/', '/urgente',
  '/tratamente', '/tratamente/', '/oferte', '/programari',
  '/pachete', '/pachete/', '/pachete-locatii', '/pachete-locatii/', '/pachete-bucuresti', '/pachete-bucuresti/',
  '/pachete-bucuresti', '/pachete-bucuresti/', '/pachete-cluj', '/pachete-timisoara',
  '/tratamente-faciale', '/epilare', '/epilare-definitiva', '/cosmetica',
  '/servicii-si-preturi', '/lista-preturi', '/preturi-servicii',
  '/servicii-medicale', '/consultatii', '/proceduri', '/produse',
];

const IMPORTANT_KEYWORDS = [
  'servic','tarif','pret','contact','despre','echip','medic','doctor',
  'tratament','procedur','faq','urgent','program','ofert','implant',
  'estetica','ortodont','chirurg','pediatr','veterinar','consultat',
];

async function fetchHtml(url, timeout=12000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
      },
      timeout,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (!loc.startsWith('http')) { try { loc = new URL(url).origin + loc; } catch(e) {} }
        fetchHtml(loc, timeout).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode >= 400) { reject(new Error('HTTP ' + res.statusCode)); return; }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; if (data.length > 500000) { req.destroy(); resolve(data); } });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function extractLinks(html, origin) {
  const links = new Set();
  for (const m of html.matchAll(/href=["']([^"'#?]+)["']/gi)) {
    let href = m[1].trim();
    if (!href || /^(mailto:|tel:|javascript:)/.test(href)) continue;
    try {
      const u = new URL(href, origin);
      if (u.origin === origin) links.add(u.pathname);
    } catch(e) {}
  }
  return [...links];
}

function scorePath(path) {
  const p = path.toLowerCase();
  let score = 0;
  for (const kw of IMPORTANT_KEYWORDS) { if (p.includes(kw)) score += 10; }
  if (path.length > 60) score -= 5;
  if (/\.(jpg|png|gif|pdf|css|js|xml)$/i.test(path)) score -= 100;
  if (/\/(tag|category|author|page\/\d|wp-|feed|rss)/i.test(path)) score -= 50;
  return score;
}

async function parseSitemap(url) {
  try {
    const xml = await fetchHtml(url, 6000);
    return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => m[1].trim());
  } catch(e) { return []; }
}

function getLabel(path) {
  const p = path.toLowerCase();
  if (p === '/' || p === '') return 'homepage';
  if (/tarif|pret|cost/.test(p)) return 'prices';
  if (/servic|tratament|procedur/.test(p)) return 'services';
  if (/contact/.test(p)) return 'contact';
  if (/echip|medic|doctor|team/.test(p)) return 'team';
  if (/despre|about/.test(p)) return 'about';
  if (/faq|intreab/.test(p)) return 'faq';
  if (/urgent/.test(p)) return 'emergency';
  return 'other';
}

async function crawl(startUrl, options={}) {
  const maxPages = options.maxPages || 12;
  const timeout = options.timeout || 10000;
  const normalUrl = startUrl.startsWith('http') ? startUrl : 'https://' + startUrl;
  const origin = new URL(normalUrl).origin;
  console.log('[CRAWLER] Start:', origin);

  const results = [];
  const fetched = new Set();

  // Homepage
  let homepageHtml = '';
  try {
    homepageHtml = await fetchHtml(normalUrl, timeout);
    results.push({ url: normalUrl, path: '/', html: homepageHtml, label: 'homepage', priority: 100 });
    fetched.add('/');
    console.log('[CRAWLER] Homepage:', homepageHtml.length, 'chars');
  } catch(e) {
    console.log('[CRAWLER] Homepage failed:', e.message);
    return { pages: [], origin, error: e.message };
  }

  // Discover links from homepage + sitemap
  const discovered = extractLinks(homepageHtml, origin);
  console.log('[CRAWLER] Discovered links:', discovered.length);

  const sitemapUrls = await parseSitemap(origin + '/sitemap.xml');
  if (sitemapUrls.length > 0) {
    console.log('[CRAWLER] Sitemap:', sitemapUrls.length, 'URLs');
    for (const u of sitemapUrls) {
      try { const p = new URL(u).pathname; if (!discovered.includes(p)) discovered.push(p); } catch(e) {}
    }
  }

  // Build candidates — discovered links first (they definitely exist), then priority paths
  const seen = new Set(fetched);
  const candidates = [];

  // First: discovered links sorted by score (these definitely work)
  for (const path of discovered) {
    if (!seen.has(path)) {
      const score = scorePath(path);
      if (score > -50) { candidates.push({ path, score: score + 5, fromSite: true }); seen.add(path); }
    }
  }

  // Then: priority paths not yet discovered
  for (const path of PRIORITY_PATHS) {
    if (!seen.has(path)) { candidates.push({ path, score: 50, fromSite: false }); seen.add(path); }
  }

  candidates.sort((a, b) => b.score - a.score);
  console.log('[CRAWLER] Candidates:', candidates.length, '| From site:', candidates.filter(c=>c.fromSite).length);

  // Fetch discovered links first (parallel), then try priority paths
  const discovered_batch = candidates.filter(c => c.fromSite).slice(0, maxPages - 1);
  const priority_batch = candidates.filter(c => !c.fromSite).slice(0, 6);

  // Fetch discovered in parallel
  const depth2Links = new Set();
  await Promise.all(discovered_batch.map(async ({ path }) => {
    try {
      const html = await fetchHtml(origin + path, timeout);
      if (html.length > 500) {
        results.push({ url: origin + path, path, html, label: getLabel(path), priority: scorePath(path) + 5 });
        console.log('[CRAWLER] ✓ (site):', path, html.length, 'chars');
        // Depth-2: extract links from important pages
        if (scorePath(path) > 20) {
          for (const link of extractLinks(html, origin)) {
            if (!seen.has(link) && scorePath(link) > 5) { depth2Links.add(link); seen.add(link); }
          }
        }
      }
    } catch(e) { console.log('[CRAWLER] ✗:', path, e.message.substring(0,30)); }
  }));

  // Fetch depth-2 links
  if (results.length < maxPages && depth2Links.size > 0) {
    const d2 = [...depth2Links].slice(0, 4);
    await Promise.all(d2.map(async path => {
      try {
        const html = await fetchHtml(origin + path, timeout);
        if (html.length > 500) {
          results.push({ url: origin + path, path, html, label: getLabel(path), priority: scorePath(path) });
          console.log('[CRAWLER] ✓ (depth2):', path, html.length, 'chars');
        }
      } catch(e) {}
    }));
  }

  // Fetch priority paths that weren't discovered (may 404, that's ok)
  if (results.length < maxPages) {
    for (let i = 0; i < priority_batch.length && results.length < maxPages; i += 3) {
      const chunk = priority_batch.slice(i, i+3);
      await Promise.all(chunk.map(async ({ path }) => {
        try {
          const html = await fetchHtml(origin + path, timeout);
          if (html.length > 500) {
            results.push({ url: origin + path, path, html, label: getLabel(path), priority: scorePath(path) });
            console.log('[CRAWLER] ✓ (priority):', path, html.length, 'chars');
          }
        } catch(e) {}
      }));
      await new Promise(r => setTimeout(r, 100));
    }
  }

  console.log('[CRAWLER] Done:', results.length, 'pages');
  return { pages: results.sort((a, b) => b.priority - a.priority), origin, totalFetched: results.length };
}

module.exports = { crawl, fetchHtml };
