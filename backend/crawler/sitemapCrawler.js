'use strict';

const https = require('https');
const http = require('http');
const { classifyPages } = require('./pageClassifier');

function fetchRaw(url, timeout=8000) {
  return new Promise((resolve) => {
    try {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.request(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xml,*/*',
          'Accept-Encoding': 'identity',
        },
        timeout,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let loc = res.headers.location;
          if (!loc.startsWith('http')) { try { loc = new URL(url).origin + loc; } catch(e) {} }
          fetchRaw(loc, timeout).then(resolve);
          return;
        }
        if (res.statusCode >= 400) { resolve(''); return; }
        let d = '';
        res.setEncoding('utf8');
        res.on('data', c => { d += c; if (d.length > 200000) { req.destroy(); resolve(d); } });
        res.on('end', () => resolve(d));
      });
      req.on('timeout', () => { req.destroy(); resolve(''); });
      req.on('error', () => resolve(''));
      req.end();
    } catch(e) { resolve(''); }
  });
}

function parseSitemap(xml) {
  const urls = [];
  for (const m of xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)) {
    const url = m[1].trim().replace(/&amp;/g,'&');
    if (url.startsWith('http')) urls.push(url);
  }
  const childSitemaps = [];
  for (const m of xml.matchAll(/<sitemap>[\s\S]*?<loc>([\s\S]*?)<\/loc>/gi)) {
    childSitemaps.push(m[1].trim());
  }
  return { urls, childSitemaps };
}

function discoverFromHtml(html, hostname) {
  const urls = new Set();
  for (const m of html.matchAll(/href=["']([^"'\s#?]+)["']/gi)) {
    try {
      const href = m[1].startsWith('http') ? m[1] : null;
      if (href) {
        const u = new URL(href);
        if (u.hostname === hostname) urls.add(href.split('?')[0].split('#')[0]);
      }
    } catch(e) {}
  }
  return [...urls];
}

async function crawlSitemap(siteUrl, options={}) {
  const { maxPages=15, timeout=8000 } = options;
  let origin, hostname;
  try { const u = new URL(siteUrl); origin = u.origin; hostname = u.hostname; }
  catch(e) { return { pages:[], discovered:0 }; }

  const discovered = new Set();

  // 1. Try sitemap.xml variants
  for (const path of ['/sitemap.xml','/sitemap_index.xml','/wp-sitemap.xml','/sitemap-index.xml']) {
    const xml = await fetchRaw(origin + path, timeout);
    if (xml && xml.includes('<loc>')) {
      const { urls, childSitemaps } = parseSitemap(xml);
      for (const child of childSitemaps.slice(0,2)) {
        const childXml = await fetchRaw(child, timeout);
        if (childXml) parseSitemap(childXml).urls.forEach(u => discovered.add(u));
      }
      urls.forEach(u => discovered.add(u));
      console.log('[CRAWLER] Sitemap found:', origin + path, '|', discovered.size, 'URLs');
      break;
    }
  }

  // 2. robots.txt
  const robots = await fetchRaw(origin + '/robots.txt', 5000);
  if (robots) {
    const m = robots.match(/Sitemap:\s*(https?:\/\/[^\s]+)/i);
    if (m && !discovered.size) {
      const xml = await fetchRaw(m[1], timeout);
      if (xml) parseSitemap(xml).urls.forEach(u => discovered.add(u));
    }
  }

  // 3. Homepage links
  const homepage = await fetchRaw(siteUrl, timeout);
  if (homepage) {
    discoverFromHtml(homepage, hostname).forEach(u => discovered.add(u));
  }

  // 4. Static important pages
  ['/tarife','/preturi','/servicii','/tratamente','/echipa','/medici','/contact','/despre'].forEach(p => discovered.add(origin + p));

  // 5. Classify and rank
  const classified = classifyPages([...discovered].filter(u => {
    try { return new URL(u).hostname === hostname; } catch(e) { return false; }
  }));

  console.log('[CRAWLER] Classified:', classified.length, 'pages');
  classified.slice(0,5).forEach(p => console.log(`  [${p.type}] ${p.priority}% ${p.url}`));

  return {
    pages: classified.slice(0, maxPages),
    discovered: discovered.size,
  };
}

module.exports = { crawlSitemap, fetchRaw };
