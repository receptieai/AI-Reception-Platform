/**
 * RecepAI — Scanner Benchmark
 * 
 * Compară V1 (extractors.js) cu V2 (extractors_v2/)
 * 
 * Rulare:
 *   node tests/benchmark.js         -- ambele versiuni
 *   node tests/benchmark.js --v1    -- doar V1
 *   node tests/benchmark.js --v2    -- doar V2
 */

'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const sites = JSON.parse(fs.readFileSync(path.join(__dirname, 'benchmark-sites.json'))).sites;
const args = process.argv.slice(2);
const runV1 = !args.includes('--v2');
const runV2 = !args.includes('--v1');

const V1 = runV1 ? require('../backend/extractors') : null;
const V2 = runV2 ? require('../backend/extractors_v2/index') : null;
const { crawlSitemap, fetchRaw } = runV2 ? require('../backend/crawler/sitemapCrawler') : { crawlSitemap: null, fetchRaw: null };

// ── FETCH URL ──────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ro-RO,ro;q=0.9',
        'Accept-Encoding': 'identity',
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (!loc.startsWith('http')) loc = new URL(url).origin + loc;
        fetchUrl(loc).then(resolve).catch(reject);
        return;
      }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => { d += c; if (d.length > 400000) { req.destroy(); resolve(d); } });
      res.on('end', () => resolve(d));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ── SCORE RESULT ──────────────────────────────
function scoreResult(extracted, expected, version) {
  const checks = {
    phone: extracted.phone ? '✅' : (expected.phone ? '❌' : '➖'),
    email: extracted.email ? '✅' : (expected.email ? '❌' : '➖'),
    facebook: extracted.facebook ? '✅' : '➖',
    instagram: extracted.instagram ? '✅' : '➖',
    hours: extracted.hours ? '✅' : '❌',
    city: extracted.city ? '✅' : '❌',
    address: extracted.address ? '✅' : '➖',
  };

  const services = extracted.services || [];
  const prices = services.filter(s => s.price);
  const doctors = extracted.doctors || [];
  const facilities = extracted.facilities || {};

  checks.services = services.length >= (expected.minServices || 0) ? '✅' : `⚠️ ${services.length}/${expected.minServices}`;
  checks.prices = prices.length >= (expected.minPrices || 0) ? '✅' : `⚠️ ${prices.length}/${expected.minPrices}`;

  const passed = Object.values(checks).filter(v => v === '✅').length;
  const total = Object.values(checks).filter(v => v !== '➖').length;
  const score = total > 0 ? Math.round(passed / total * 100) : 0;

  return {
    checks,
    services: services.length,
    prices: prices.length,
    doctors: doctors.length,
    facilities: Object.keys(facilities).length,
    confidence: extracted._globalConfidence || extracted.confidence || 0,
    durationMs: extracted._durationMs || 0,
    score,
  };
}

// ── RUN BENCHMARK ─────────────────────────────
async function runBenchmark() {
  console.log('\n' + '═'.repeat(70));
  console.log('  RecepAI Scanner Benchmark');
  console.log('  ' + new Date().toLocaleString('ro-RO'));
  console.log('═'.repeat(70));

  const results = [];
  let v1Total = 0, v2Total = 0;
  let v1Count = 0, v2Count = 0;

  for (const site of sites) {
    console.log(`\n📍 ${site.name} (${site.category})`);
    console.log(`   ${site.url}`);

    let html = '';
    try {
      const start = Date.now();
      html = await fetchUrl(site.url);
      // Fetch price pages too
      const origin = new URL(site.url).origin;
      const extraPages = ['/tarife','/tarife/','/preturi','/preturi/','/servicii','/servicii/','/contact'];
      for (const p of extraPages) {
        try {
          const extra = await fetchUrl(origin + p);
          if (extra.length > 5000) html += extra;
          if (html.length > 800000) break;
        } catch(e) {}
      }
      console.log(`   Fetched: ${html.length} chars in ${Date.now()-start}ms`);
    } catch(e) {
      console.log(`   ❌ Fetch error: ${e.message}`);
      continue;
    }

    const siteResult = { site: site.name, category: site.category };

    // V1
    if (V1) {
      try {
        const start = Date.now();
        const r1 = V1.extractAll(html, site.url, 'benchmark');
        r1._durationMs = Date.now() - start;
        const s1 = scoreResult(r1, site.expected, 'V1');
        siteResult.v1 = s1;
        v1Total += s1.score;
        v1Count++;
        console.log(`\n   V1: Score ${s1.score}% | Services:${s1.services} Prices:${s1.prices} Doctors:${s1.doctors} | ${s1.durationMs}ms`);
        console.log(`       Phone:${s1.checks.phone} Email:${s1.checks.email} FB:${s1.checks.facebook} IG:${s1.checks.instagram} Hours:${s1.checks.hours} City:${s1.checks.city}`);
        console.log(`       Services:${s1.checks.services} Prices:${s1.checks.prices}`);
      } catch(e) {
        console.log(`   V1 Error: ${e.message}`);
      }
    }

    // V2 with crawler + Playwright on price pages
    if (V2) {
      try {
        const start = Date.now();
        const { renderPage, isJsSite } = require('../backend/playwrightEngine');
        const crawled = await crawlSitemap(site.url, { maxPages: 10, timeout: 8000 });
        let combinedHtml = html;

        const PRICE_KEYWORDS = ['pret','tarif','servicii','tratament','implant','ortodont','profilax','estetica'];

        for (const page of crawled.pages.slice(0, 8)) {
          try {
            let pageHtml = await fetchRaw(page.url, 6000);
            if (!pageHtml || pageHtml.length < 500) continue;

            // Render with Playwright if price page or JS site
            const isPricePage = PRICE_KEYWORDS.some(k => page.url.toLowerCase().includes(k));
            const noServices = !pageHtml.includes('lei') && !pageHtml.includes('RON');
            if (isPricePage || (isJsSite(pageHtml) && noServices)) {
              const rendered = await renderPage(page.url, { waitAfterLoad: 2500, expandAccordions: true, acceptCookies: true });
              if (rendered.success && rendered.html.length > pageHtml.length) {
                pageHtml = rendered.html;
                console.log('   [Playwright] rendered:', page.url);
              }
            }

            combinedHtml += pageHtml;
            if (combinedHtml.length > 2000000) break;
          } catch(e) {}
        }

        const r2 = await V2.extractAll(combinedHtml, site.url, 'benchmark');
        r2._durationMs = Date.now() - start;
        const s2 = scoreResult(r2, site.expected, 'V2');
        siteResult.v2 = s2;
        v2Total += s2.score;
        v2Count++;
        console.log(`\n   V2: Score ${s2.score}% | Services:${s2.services} Prices:${s2.prices} Doctors:${s2.doctors} Facilities:${s2.facilities} | ${s2.durationMs}ms`);
        console.log(`       Phone:${s2.checks.phone} Email:${s2.checks.email} FB:${s2.checks.facebook} IG:${s2.checks.instagram} Hours:${s2.checks.hours} City:${s2.checks.city}`);
        console.log(`       Services:${s2.checks.services} Prices:${s2.checks.prices}`);
      } catch(e) {
        console.log(`   V2 Error: ${e.message}`);
      }
    }

    results.push(siteResult);
  }

  // SUMMARY
  console.log('\n' + '═'.repeat(70));
  console.log('  REZULTATE FINALE');
  console.log('═'.repeat(70));

  if (runV1 && v1Count > 0) {
    const avg1 = Math.round(v1Total / v1Count);
    console.log(`\n  V1 (extractors.js):     ${avg1}% medie (${v1Count} site-uri)`);
  }
  if (runV2 && v2Count > 0) {
    const avg2 = Math.round(v2Total / v2Count);
    console.log(`  V2 (extractors_v2/):    ${avg2}% medie (${v2Count} site-uri)`);
  }
  if (runV1 && runV2 && v1Count > 0 && v2Count > 0) {
    const diff = Math.round(v2Total/v2Count) - Math.round(v1Total/v1Count);
    console.log(`\n  Diferență V2 vs V1:     ${diff > 0 ? '+' : ''}${diff}%`);
    console.log(`  Winner:                  ${diff > 0 ? '🏆 V2' : diff < 0 ? '🏆 V1' : '🤝 Egal'}`);
  }

  // Save results
  const timestamp = new Date().toISOString().replace(/[:.]/g,'-').substring(0,19);
  const outFile = path.join(__dirname, 'benchmark-results', `benchmark-${timestamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ timestamp, results, summary: { v1Avg: v1Count>0?Math.round(v1Total/v1Count):0, v2Avg: v2Count>0?Math.round(v2Total/v2Count):0 }}, null, 2));
  console.log(`\n  Rezultate salvate: ${outFile}`);
  console.log('═'.repeat(70) + '\n');
}

runBenchmark().catch(console.error);
