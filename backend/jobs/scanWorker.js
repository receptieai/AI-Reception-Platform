'use strict';

const { updateJob } = require('./scanQueue');
const { extractAll: extractV1 } = require('../extractors');
const { extractAll: extractV2 } = require('../extractors_v2/index');
const { crawlSitemap, fetchRaw } = require('../crawler/sitemapCrawler');
const { renderPage, isJsSite } = require('../playwrightEngine');

const PRICE_KEYWORDS = ['pret','tarif','servicii','tratament','implant','ortodont','profilax','estetica'];

async function fetchUrl(url, timeout=12000) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const http = require('http');
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ro-RO,ro;q=0.9',
        'Accept-Encoding': 'identity',
      },
      timeout,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (!loc.startsWith('http')) { try { loc = new URL(url).origin + loc; } catch(e) {} }
        fetchUrl(loc, timeout).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode >= 400) { reject(new Error('HTTP ' + res.statusCode)); return; }
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

async function runScanJob(jobId, url) {
  const progress = (pct, text) => updateJob(jobId, { progress: pct, progressText: text, status: 'processing' });

  try {
    updateJob(jobId, { status: 'processing', startedAt: new Date().toISOString() });
    const normalUrl = url.startsWith('http') ? url : 'https://' + url;
    const origin = new URL(normalUrl).origin;

    // Phase 1: V1 fast scan
    progress(10, 'Se descarcă site-ul...');
    let homepageHtml = await fetchUrl(normalUrl).catch(() => fetchUrl(origin).catch(() => ''));

    progress(25, 'Fetch pagini statice...');
    const staticPages = ['/tarife','/preturi','/servicii','/contact'];
    const staticResults = await Promise.all(staticPages.map(p => fetchUrl(origin+p).catch(() => '')));
    const combinedV1 = homepageHtml + staticResults.join('');

    progress(35, 'Analizez cu V1...');
    const v1Result = extractV1(combinedV1, url, 'homepage');
    updateJob(jobId, { result: { ...flattenResult(v1Result), _scanVersion:'v1', _v1Complete:true, _v2Complete:false } });

    progress(45, `V1: ${v1Result.services?.length||0} servicii. Analiză avansată...`);

    // Phase 2: Crawler + V2
    progress(50, 'Descopăr pagini importante...');
    const crawled = await crawlSitemap(normalUrl, { maxPages:8, timeout:6000 });

    const fetchedPages = await Promise.all(
      crawled.pages.slice(0,6).map(async page => {
        try { return { page, html: await fetchRaw(page.url, 5000) }; }
        catch(e) { return { page, html: '' }; }
      })
    );

    progress(65, 'Renderez pagini JavaScript...');
    let playwrightCount = 0;
    let combinedV2 = homepageHtml;

    for (const { page, html: pageHtml } of fetchedPages) {
      if (!pageHtml || pageHtml.length < 500) continue;
      let finalHtml = pageHtml;
      const isPricePage = PRICE_KEYWORDS.some(k => page.url.toLowerCase().includes(k));
      const noServices = !pageHtml.includes('lei') && !pageHtml.includes('RON');
      if (playwrightCount < 3 && isPricePage && noServices && isJsSite(pageHtml)) {
        try {
          const rendered = await renderPage(page.url, { waitAfterLoad:1500, expandAccordions:true, acceptCookies:true });
          if (rendered.success && rendered.html.length > pageHtml.length) { finalHtml = rendered.html; playwrightCount++; }
        } catch(e) {}
      }
      combinedV2 += finalHtml;
      if (combinedV2.length > 1500000) break;
    }

    progress(80, 'Extrag date avansate...');
    const v2Result = await extractV2(combinedV2, url, 'homepage');

    progress(90, 'Finalizez...');
    const merged = mergeResults(v1Result, v2Result);

    updateJob(jobId, {
      status: 'completed', progress: 100,
      progressText: `Gata! ${merged.services?.length||0} servicii, ${merged.doctors?.length||0} doctori.`,
      completedAt: new Date().toISOString(),
      result: { ...merged, _scanVersion:'hybrid', _v1Complete:true, _v2Complete:true, _playwrightPages:playwrightCount },
    });

    console.log('[WORKER] Done:', jobId, '| Services:', merged.services?.length, '| Confidence:', merged.confidence + '%');

  } catch(e) {
    console.error('[WORKER] Failed:', jobId, e.message);
    updateJob(jobId, { status:'failed', error:e.message, completedAt:new Date().toISOString() });
  }
}

function flattenResult(r) {
  return {
    name:r.name||null, phone:r.phone||null, email:r.email||null,
    city:r.city||null, address:r.address||null, hours:r.hours||null,
    facebook:r.facebook||null, instagram:r.instagram||null,
    tiktok:r.tiktok||null, youtube:r.youtube||null, whatsapp:r.whatsapp||null,
    services:r.services||[], doctors:r.doctors||[], facilities:r.facilities||{}, payments:r.payments||{},
    confidence:r._globalConfidence||r.confidence||0, fieldConfidence:r._confidence||{}, missing:r.missing||[],
  };
}

function mergeResults(v1, v2) {
  const m = flattenResult(v2);
  if (v1.phone && !m.phone) m.phone = v1.phone;
  if (v1.email && !m.email) m.email = v1.email;
  if (v1.city && !m.city) m.city = v1.city;
  if (v1.address && !m.address) m.address = v1.address;
  if (v1.hours && !m.hours) m.hours = v1.hours;
  if (v1.facebook && !m.facebook) m.facebook = v1.facebook;
  if (v1.instagram && !m.instagram) m.instagram = v1.instagram;
  if (v1.name && !m.name) m.name = v1.name;
  const v1s = v1.services||[], v2s = m.services||[];
  m.services = v1s.length > v2s.length ? v1s : v2s;
  const fc = m.fieldConfidence||{};
  fc.services = m.services.length>10?90:m.services.length>3?70:m.services.length>0?50:0;
  fc.prices = m.services.filter(s=>s.price).length>10?90:m.services.filter(s=>s.price).length>0?60:0;
  const w = {phone:15,email:10,name:15,city:5,hours:10,services:25,prices:15,facebook:3,instagram:2};
  let ws=0,wt=0;
  Object.entries(w).forEach(([k,v])=>{ws+=(fc[k]||0)*v;wt+=v*100;});
  m.confidence = Math.round(ws/wt*100);
  m.fieldConfidence = fc;
  return m;
}

module.exports = { runScanJob };
