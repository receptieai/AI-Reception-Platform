/**
 * RecepAI — Deep Scan Mode
 * 
 * Activat automat când:
 * - Servicii găsite > 0 dar Prețuri = 0
 * - Site SPA cu conținut dinamic
 * 
 * Ce face:
 * 1. Colectează toate linkurile interne relevante
 * 2. Face click pe acordeoane/tabs/butoane
 * 3. Navighează la pagini de servicii/tarife
 * 4. Detectează și extrage PDF-uri
 * 5. Returnează tot conținutul combinat
 */

'use strict';

const PRICE_KEYWORDS = /tarif|preț|pret|servicii|profilax|implant|ortodon|endodon|estetică|estetica|chirurgie|coronoară|coroana|albire|detartraj|periaj|plombă|plomba|extractie|extracție|cariologie|parodont|pediatr|radiolog/i;

const CLICK_SELECTORS = [
  // Acordeoane
  '.accordion-button', '.accordion-header', '[data-bs-toggle="collapse"]',
  '[data-toggle="collapse"]', 'details summary', '.faq-question',
  '[aria-expanded="false"]', '.expandable', '.collapse-trigger',
  // Tab-uri
  '[role="tab"]', '.nav-tab', '.tab-link', '.tab-item',
  // Butoane generice
  'button:not([type="submit"])', '.btn-toggle',
  // Meniu servicii
  'a[href*="servicii"]', 'a[href*="tarife"]', 'a[href*="preturi"]',
  'a[href*="service"]', 'a[href*="tratament"]',
];

async function deepScan(startUrl, options = {}) {
  const {
    maxPages = 15,
    timeout = 30000,
    waitAfterClick = 800,
  } = options;

  let browser = null;
  const allText = [];
  const visitedUrls = new Set();
  const foundPdfs = [];

  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'ro-RO',
    });

    // Blochează imagini și fonturi
    await context.route('**/*', route => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media'].includes(type)) route.abort();
      else route.continue();
    });

    let normalUrl = startUrl.trim();
    if (!normalUrl.startsWith('http')) normalUrl = 'https://' + normalUrl;
    const origin = new URL(normalUrl).origin;

    // ── PASUL 1: Pagina principală + click pe acordeoane ──
    const mainPage = await context.newPage();
    console.log('[DEEP] Loading main page...');
    
    await mainPage.goto(normalUrl, { waitUntil: 'domcontentloaded', timeout });
    await mainPage.waitForTimeout(2000);

    // Accept cookies
    for (const sel of ['button[class*="accept"]', 'button:text("Accept")', 'button:text("OK")', 'button:text("De acord")']) {
      try {
        const btn = await mainPage.$(sel);
        if (btn && await btn.isVisible()) { await btn.click(); await mainPage.waitForTimeout(500); break; }
      } catch (e) {}
    }

    // Scroll
    await mainPage.evaluate(async () => {
      for (let i = 0; i < 5; i++) {
        window.scrollBy(0, window.innerHeight);
        await new Promise(r => setTimeout(r, 200));
      }
      window.scrollTo(0, 0);
    }).catch(() => {});

    // Colectează linkuri relevante din pagina principală
    // Încearcă direct /tarife/ cu wait mai lung
    try {
      const tarifePage = await context.newPage();
      await tarifePage.goto(origin + '/tarife/', {waitUntil:'networkidle', timeout:20000});
      await tarifePage.waitForTimeout(4000);
      const tarifeText = await tarifePage.evaluate(() => document.body.innerText).catch(() => '');
      if (tarifeText.length > 500) {
        allText.push({ url: origin + '/tarife/', text: tarifeText });
        console.log('[DEEP] /tarife/ loaded:', tarifeText.length, 'chars');
      }
      await tarifePage.close();
    } catch(e) { console.log('[DEEP] /tarife/ failed:', e.message); }

    const links = await mainPage.evaluate((keywords) => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      return anchors
        .filter(a => {
          const href = a.href || '';
          const text = a.textContent || '';
          return (keywords.test(href) || keywords.test(text)) && href.startsWith('http');
        })
        .map(a => ({ url: a.href, text: a.textContent.trim() }))
        .filter((v, i, arr) => arr.findIndex(x => x.url === v.url) === i)
        .slice(0, 20);
    }, PRICE_KEYWORDS).catch(() => []);

    console.log('[DEEP] Found', links.length, 'relevant links');

    // Text din pagina principală
    const mainText = await mainPage.evaluate(() => document.body.innerText).catch(() => '');
    if (mainText.trim()) allText.push({ url: normalUrl, text: mainText });
    visitedUrls.add(normalUrl);

    // Detectează PDF-uri
    const pdfLinks = await mainPage.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href*=".pdf"]'))
        .map(a => a.href)
        .filter(href => href.startsWith('http'));
    }).catch(() => []);
    foundPdfs.push(...pdfLinks);

    await mainPage.close();

    // ── PASUL 2: Vizitează paginile relevante ──
    let pagesScanned = 1;

    for (const link of links) {
      if (pagesScanned >= maxPages) break;
      if (visitedUrls.has(link.url)) continue;
      if (!link.url.startsWith(origin)) continue;

      visitedUrls.add(link.url);

      try {
        const page = await context.newPage();
        console.log('[DEEP] Visiting:', link.url);
        
        await page.goto(link.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1500);

        // Scroll pentru lazy loading
        await page.evaluate(async () => {
          for (let i = 0; i < 3; i++) {
            window.scrollBy(0, window.innerHeight);
            await new Promise(r => setTimeout(r, 300));
          }
        }).catch(() => {});

        // Click pe acordeoane și tabs
        let clickCount = 0;
        for (const sel of CLICK_SELECTORS.slice(0, 8)) {
          try {
            const elements = await page.$$(sel);
            for (const el of elements.slice(0, 5)) {
              if (await el.isVisible()) {
                await el.click({ force: true, timeout: 2000 });
                clickCount++;
                await page.waitForTimeout(waitAfterClick / 2);
              }
            }
          } catch (e) {}
        }
        if (clickCount > 0) {
          console.log('[DEEP] Clicked', clickCount, 'elements on', link.text);
          await page.waitForTimeout(waitAfterClick);
        }

        const text = await page.evaluate(() => document.body.innerText).catch(() => '');
        if (text.trim().length > 100) {
          allText.push({ url: link.url, text });
          console.log('[DEEP] Got', text.length, 'chars from', link.text);
        }

        // Detectează PDF-uri și pe această pagină
        const pdfs = await page.evaluate(() => 
          Array.from(document.querySelectorAll('a[href*=".pdf"]')).map(a => a.href)
        ).catch(() => []);
        foundPdfs.push(...pdfs);

        await page.close();
        pagesScanned++;
      } catch (e) {
        console.log('[DEEP] Error on', link.url, ':', e.message);
      }
    }

    // ── PASUL 3: Extrage PDF-uri ──
    const pdfTexts = [];
    for (const pdfUrl of [...new Set(foundPdfs)].slice(0, 3)) {
      try {
        const pdfText = await extractPdf(pdfUrl);
        if (pdfText) {
          pdfTexts.push(pdfText);
          console.log('[DEEP] PDF extracted:', pdfUrl, '-', pdfText.length, 'chars');
        }
      } catch (e) {
        console.log('[DEEP] PDF failed:', pdfUrl);
      }
    }

    await browser.close();
    browser = null;

    // Combină tot conținutul
    const combinedText = [
      ...allText.map(t => `\n--- ${t.url} ---\n${t.text}`),
      ...pdfTexts.map(t => `\n--- PDF ---\n${t}`),
    ].join('\n').substring(0, 30000);

    console.log('[DEEP] Complete:', pagesScanned, 'pages,', combinedText.length, 'chars total');

    return {
      success: true,
      text: combinedText,
      pagesScanned,
      pdfCount: pdfTexts.length,
      urls: [...visitedUrls],
    };

  } catch (e) {
    console.error('[DEEP] Fatal error:', e.message);
    if (browser) await browser.close().catch(() => {});
    return { success: false, text: '', error: e.message };
  }
}

// ── PDF EXTRACTOR ─────────────────────────────
async function extractPdf(pdfUrl) {
  try {
    const https = pdfUrl.startsWith('https') ? require('https') : require('http');
    const buffer = await new Promise((resolve, reject) => {
      const chunks = [];
      https.get(pdfUrl, { timeout: 10000 }, res => {
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });

    // Extrage text brut din PDF (fără librării externe)
    const text = buffer.toString('latin1');
    const textMatches = text.match(/BT[\s\S]*?ET/g) || [];
    const extracted = textMatches
      .join(' ')
      .replace(/\([^)]*\)/g, m => m.slice(1, -1))
      .replace(/[^\x20-\x7E\u00C0-\u024F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return extracted.length > 50 ? extracted.substring(0, 5000) : null;
  } catch (e) {
    return null;
  }
}

// ── DETECTARE AUTOMATĂ DEEP SCAN ─────────────
function needsDeepScan(scanResult) {
  const services = scanResult.services || [];
  const withPrices = services.filter(s => s.price).length;
  const totalServices = services.length;

  // Activează dacă:
  // - Avem servicii dar fără prețuri
  // - Sau confidence prețuri sub 30%
  const priceConfidence = scanResult.fieldConfidence?.prices || 0;
  
  return (totalServices > 0 && withPrices === 0) || priceConfidence < 30;
}

module.exports = { deepScan, needsDeepScan, extractPdf };
