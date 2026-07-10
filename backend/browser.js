/**
 * RecepAI — Smart Browser v2.0
 * 
 * Nu doar deschide pagina — interacționează cu ea:
 * 1. Accept cookies
 * 2. Click pe acordeoane/tab-uri
 * 3. Scroll pentru lazy loading
 * 4. Extrage HTML complet după interacțiuni
 */

'use strict';

// ── DETECTEAZĂ DACĂ SITE-UL ARE NEVOIE DE BROWSER ──
function needsBrowser(html) {
  if (!html || html.length < 3000) return true;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length < 300) return true;
  const jsFrameworks = [
    'id="__next"', 'id="__nuxt"', 'ng-version',
    'data-reactroot', '_next/static', '__NEXT_DATA__',
    'nuxt.js', 'vue-app',
  ];
  const hasFramework = jsFrameworks.some(f => html.includes(f));
  const fewWords = text.split(' ').filter(w => w.length > 3).length < 50;
  return hasFramework || fewWords;
}

// ── SMART PLAYWRIGHT RENDERER ──────────────────────
async function renderWithBrowser(url, options = {}) {
  const {
    expandAccordions = true,
    clickTabs = true,
    acceptCookies = true,
    scrollPage = true,
    timeout = 25000,
    waitAfterLoad = 2000,
  } = options;

  try {
    const { chromium } = require('playwright');

    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
      ],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'ro-RO',
    });

    // Blochează resurse inutile
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    const page = await context.newPage();

    let normalUrl = url.trim();
    if (!normalUrl.startsWith('http')) normalUrl = 'https://' + normalUrl;

    console.log('[BROWSER] Navigating to:', normalUrl);
    await page.goto(normalUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(waitAfterLoad);

    // ── STEP 1: ACCEPT COOKIES ──────────────────────
    if (acceptCookies) {
      const cookieSelectors = [
        // Generic
        'button[id*="accept"]',
        'button[class*="accept"]',
        'button[id*="cookie"]',
        'button[class*="cookie"]',
        '.cookie-accept',
        '#cookie-accept',
        '[data-accept-cookies]',
        // Romanian specific
        'button:text("Accept")',
        'button:text("Acceptă")',
        'button:text("Accepta")',
        'button:text("De acord")',
        'button:text("OK")',
        'button:text("Înțeleg")',
        // English
        'button:text("Accept all")',
        'button:text("Accept All")',
        'button:text("I agree")',
        'button:text("Got it")',
        'button:text("Allow all")',
      ];

      for (const sel of cookieSelectors) {
        try {
          const btn = await page.$(sel);
          if (btn) {
            await btn.click();
            console.log('[BROWSER] Cookie banner accepted:', sel);
            await page.waitForTimeout(500);
            break;
          }
        } catch (e) { }
      }
    }

    // ── STEP 2: SCROLL PENTRU LAZY LOADING ──────────
    if (scrollPage) {
      try {
        await page.evaluate(async () => {
          await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 300;
            const timer = setInterval(() => {
              window.scrollBy(0, distance);
              totalHeight += distance;
              if (totalHeight >= document.body.scrollHeight || totalHeight > 8000) {
                clearInterval(timer);
                window.scrollTo(0, 0);
                resolve();
              }
            }, 100);
          });
        });
        await page.waitForTimeout(500);
        console.log('[BROWSER] Scroll complete');
      } catch (e) {
        console.log('[BROWSER] Scroll failed:', e.message);
      }
    }

    // ── STEP 3: CLICK PE ACORDEOANE ─────────────────
    if (expandAccordions) {
      const accordionSelectors = [
        // Comune
        '.accordion-header',
        '.accordion-button',
        '.accordion-toggle',
        '[data-toggle="collapse"]',
        '[data-bs-toggle="collapse"]',
        '.collapse-trigger',
        // Bootstrap
        '.accordion .card-header',
        '.accordion-item .accordion-header button',
        // Custom
        '[aria-expanded="false"]',
        '.expandable:not(.expanded)',
        '.faq-question',
        '.faq-item:not(.active) .faq-header',
        // Romanian patterns
        '[class*="acord"]',
        '[class*="expand"]',
        '[class*="toggle"]',
        '[class*="collaps"]',
      ];

      let clickedCount = 0;
      for (const sel of accordionSelectors) {
        try {
          const elements = await page.$$(sel);
          for (const el of elements.slice(0, 20)) {
            try {
              const isVisible = await el.isVisible();
              if (isVisible) {
                await el.click({ force: true });
                clickedCount++;
                await page.waitForTimeout(150);
              }
            } catch (e) { }
          }
        } catch (e) { }
      }
      if (clickedCount > 0) {
        console.log('[BROWSER] Clicked', clickedCount, 'accordion/toggle elements');
        await page.waitForTimeout(800);
      }
    }

    // ── STEP 4: CLICK PE TABS ───────────────────────
    if (clickTabs) {
      const tabSelectors = [
        '.nav-tab:not(.active)',
        '.tab-link:not(.active)',
        '[role="tab"]:not([aria-selected="true"])',
        '.tab:not(.active)',
        '[data-tab]',
      ];

      // Click pe fiecare tab și extrage conținut
      const extraHtml = [];
      for (const sel of tabSelectors) {
        try {
          const tabs = await page.$$(sel);
          for (const tab of tabs.slice(0, 10)) {
            try {
              const isVisible = await tab.isVisible();
              if (isVisible) {
                await tab.click({ force: true });
                await page.waitForTimeout(400);
                const tabContent = await page.content();
                extraHtml.push(tabContent);
              }
            } catch (e) { }
          }
        } catch (e) { }
      }
    }

    // ── STEP 5: EXTRAGE HTML FINAL ──────────────────
    const finalHtml = await page.content();
    const textContent = await page.evaluate(() => document.body.innerText || '');
    const title = await page.title();

    // ── STEP 6: DETECTEAZĂ LINKURI IMPORTANTE ────────
    const importantLinks = await page.evaluate(() => {
      const keywords = /tarif|pret|servicii|contact|despre|faq|echipa|medici|programare|booking/i;
      return Array.from(document.querySelectorAll('a[href]'))
        .filter(a => keywords.test(a.href) || keywords.test(a.textContent))
        .map(a => a.href)
        .filter(href => href.startsWith('http'))
        .slice(0, 10);
    });

    await browser.close();

    console.log('[BROWSER] Done:', {
      htmlSize: finalHtml.length,
      textSize: textContent.length,
      importantLinks: importantLinks.length,
    });

    return {
      html: finalHtml,
      textContent,
      title,
      importantLinks,
      success: true,
    };

  } catch (e) {
    console.error('[BROWSER] Error:', e.message);
    return { html: '', textContent: '', title: '', importantLinks: [], success: false, error: e.message };
  }
}

// ── RENDER MULTIPLE PAGES ────────────────────────────
async function renderPages(urls, options = {}) {
  const results = {};
  for (const url of urls.slice(0, 5)) {
    try {
      console.log('[BROWSER] Rendering page:', url);
      results[url] = await renderWithBrowser(url, options);
    } catch (e) {
      results[url] = { success: false, error: e.message, html: '', textContent: '' };
    }
  }
  return results;
}

module.exports = { renderWithBrowser, renderPages, needsBrowser };
