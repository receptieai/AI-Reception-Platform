/**
 * RecepAI — Browser Renderer (Playwright fallback)
 * 
 * Folosit DOAR când fetch-ul normal returnează HTML gol/insuficient.
 * Playwright renderează JavaScript și returnează DOM-ul complet.
 */

'use strict';

async function renderWithBrowser(url) {
  try {
    const { chromium } = require('playwright');
    
    console.log('[BROWSER] Launching Chromium for:', url);
    
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'ro-RO',
    });

    const page = await context.newPage();

    // Block images, fonts, media — nu avem nevoie de ele
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    // Navighează la URL
    let normalUrl = url.trim();
    if (!normalUrl.startsWith('http')) normalUrl = 'https://' + normalUrl;

    await page.goto(normalUrl, {
      waitUntil: 'networkidle',
      timeout: 20000,
    });

    // Așteaptă să se încarce conținutul
    await page.waitForTimeout(1500);

    // Încearcă să închidă banner-ele de cookie
    const cookieSelectors = [
      'button[id*="accept"]',
      'button[class*="accept"]',
      'button[class*="cookie"]',
      '[id*="cookie"] button',
      '.cookie-accept',
      '#cookie-accept',
    ];
    for (const sel of cookieSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) { await btn.click(); await page.waitForTimeout(500); break; }
      } catch (e) { }
    }

    // Extrage HTML-ul complet după render
    const html = await page.content();
    const title = await page.title();

    // Extrage și textul vizibil (mai curat)
    const textContent = await page.evaluate(() => document.body.innerText);

    await browser.close();

    console.log('[BROWSER] Rendered:', html.length, 'chars | Text:', textContent.length, 'chars');

    return { html, textContent, title, success: true };

  } catch (e) {
    console.error('[BROWSER] Error:', e.message);
    return { html: '', textContent: '', title: '', success: false, error: e.message };
  }
}

// Detectează dacă un site are nevoie de browser
function needsBrowser(html) {
  if (!html || html.length < 5000) return true;

  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length < 500) return true;

  // Semne că e JavaScript-rendered
  const jsFrameworks = [
    'id="__next"',           // Next.js
    'id="__nuxt"',           // Nuxt.js
    'id="app"',              // Vue/React generic
    'ng-version',            // Angular
    'data-reactroot',        // React
    '_next/static',          // Next.js
    'nuxt.js',               // Nuxt.js
    '__NEXT_DATA__',         // Next.js data
  ];

  const hasFramework = jsFrameworks.some(f => html.includes(f));
  const hasLittleText = text.split(' ').filter(w => w.length > 3).length < 50;

  return hasFramework || hasLittleText;
}

module.exports = { renderWithBrowser, needsBrowser };
