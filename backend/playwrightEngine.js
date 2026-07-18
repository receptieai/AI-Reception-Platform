'use strict';

/**
 * RecepAI — Playwright Engine V2
 * 
 * Rol: DOAR rendering. Nu extrage nimic.
 * Scanner-ul decide când să îl folosească.
 * 
 * Regula: Playwright DOAR când HTML fetch normal
 * returnează < 5 servicii și site-ul e detectat JS.
 */

const JS_SIGNALS = [
  '__next', '__nuxt', 'ng-version', 'data-reactroot',
  '_next/static', '__NEXT_DATA__', 'vue-app',
  'webpack', 'react-root', 'ember-application',
];

function isJsSite(html) {
  if (!html || html.length < 2000) return true;
  const text = html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  if (text.split(' ').filter(w => w.length > 3).length < 50) return true;
  return JS_SIGNALS.some(s => html.includes(s));
}

async function renderPage(url, options = {}) {
  const {
    waitAfterLoad = 2000,
    timeout = 20000,
    acceptCookies = true,
    scrollPage = true,
    expandAccordions = true,
  } = options;

  try {
    const { chromium } = require('playwright');

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'ro-RO',
    });

    // Block images/fonts/media — not needed
    await context.route('**/*', route => {
      const type = route.request().resourceType();
      if (['image','font','media'].includes(type)) route.abort();
      else route.continue();
    });

    const page = await context.newPage();

    let normalUrl = url.trim();
    if (!normalUrl.startsWith('http')) normalUrl = 'https://' + normalUrl;

    console.log('[PLAYWRIGHT] Rendering:', normalUrl);
    await page.goto(normalUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(waitAfterLoad);

    // Accept cookies
    if (acceptCookies) {
      const cookieSelectors = [
        'button[class*="accept"]','button[id*="accept"]',
        'button:text("Accept")','button:text("Acceptă")',
        'button:text("OK")','button:text("De acord")',
        'button:text("Accept all")','button:text("Allow all")',
      ];
      for (const sel of cookieSelectors) {
        try {
          const btn = await page.$(sel);
          if (btn && await btn.isVisible()) {
            await btn.click();
            await page.waitForTimeout(500);
            console.log('[PLAYWRIGHT] Cookie accepted:', sel);
            break;
          }
        } catch(e) {}
      }
    }

    // Scroll for lazy loading
    if (scrollPage) {
      await page.evaluate(async () => {
        await new Promise(resolve => {
          let total = 0;
          const timer = setInterval(() => {
            window.scrollBy(0, 400);
            total += 400;
            if (total >= document.body.scrollHeight || total > 10000) {
              clearInterval(timer);
              window.scrollTo(0, 0);
              resolve();
            }
          }, 100);
        });
      }).catch(() => {});
      await page.waitForTimeout(500);
    }

    // Expand accordions
    if (expandAccordions) {
      const accordionSelectors = [
        '[aria-expanded="false"]',
        '.accordion-button:not(.collapsed)',
        '[data-bs-toggle="collapse"]',
        'details:not([open]) summary',
        '.faq-question',
        '[class*="accordion"] button',
        '[class*="expand"]',
      ];
      let clicked = 0;
      for (const sel of accordionSelectors) {
        try {
          const els = await page.$$(sel);
          for (const el of els.slice(0, 15)) {
            try {
              if (await el.isVisible()) {
                await el.click({ force: true });
                clicked++;
                await page.waitForTimeout(150);
              }
            } catch(e) {}
          }
        } catch(e) {}
      }
      if (clicked > 0) {
        console.log('[PLAYWRIGHT] Expanded', clicked, 'accordions');
        await page.waitForTimeout(600);
      }
    }

    const html = await page.content();
    const textContent = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    const title = await page.title().catch(() => '');
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(h => h.startsWith('http'))
        .slice(0, 50)
    ).catch(() => []);

    await browser.close();

    console.log('[PLAYWRIGHT] Done:', html.length, 'chars | text:', textContent.length);

    return { html, textContent, title, links, success: true, url: normalUrl };

  } catch(e) {
    console.error('[PLAYWRIGHT] Error:', e.message);
    return { html: '', textContent: '', title: '', links: [], success: false, error: e.message };
  }
}

module.exports = { renderPage, isJsSite };
