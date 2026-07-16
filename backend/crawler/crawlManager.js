'use strict';

const { crawlSitemap, fetchRaw } = require('./sitemapCrawler');
const { classifyPage } = require('./pageClassifier');

async function crawlAndExtract(siteUrl, extractAll, options={}) {
  const { maxPages=10, timeout=8000 } = options;

  console.log('[CRAWL] Starting:', siteUrl);

  // Step 1: Discover pages
  const { pages, discovered } = await crawlSitemap(siteUrl, { maxPages, timeout });
  console.log('[CRAWL] Discovered:', discovered, '| Will fetch:', pages.length);

  // Step 2: Fetch and extract per page type
  const results = {
    services: [],
    doctors: [],
    contact: null,
    hours: null,
    social: {},
    facilities: {},
    payments: {},
    pagesScanned: 0,
    pagesSummary: [],
  };

  // Always include homepage
  const homepageHtml = await fetchRaw(siteUrl, timeout);
  if (homepageHtml) {
    const extracted = await extractAll(homepageHtml, siteUrl, 'homepage');
    mergeResults(results, extracted, 'homepage');
    results.pagesScanned++;
  }

  // Fetch classified pages
  for (const page of pages) {
    if (page.type === 'skip') continue;
    if (results.pagesScanned >= maxPages) break;

    try {
      const html = await fetchRaw(page.url, timeout);
      if (!html || html.length < 1000) continue;

      const extracted = await extractAll(html, page.url, page.type);
      mergeResults(results, extracted, page.type);
      results.pagesScanned++;
      results.pagesSummary.push({ url: page.url, type: page.type, services: extracted.services?.length || 0 });
      console.log(`[CRAWL] ${page.type}: ${page.url} → ${extracted.services?.length || 0} services`);
    } catch(e) {
      console.log('[CRAWL] Error on', page.url, e.message);
    }
  }

  console.log('[CRAWL] Done. Pages:', results.pagesScanned, '| Services:', results.services.length, '| Doctors:', results.doctors.length);

  return results;
}

function mergeResults(results, extracted, pageType) {
  // Merge services (deduplicate by name)
  if (extracted.services?.length) {
    const existing = new Set(results.services.map(s => s.name?.toLowerCase()));
    extracted.services.forEach(s => {
      if (s.name && !existing.has(s.name.toLowerCase())) {
        results.services.push(s);
        existing.add(s.name.toLowerCase());
      }
    });
  }

  // Merge doctors
  if (extracted.doctors?.length) {
    const existing = new Set(results.doctors.map(d => d.name?.toLowerCase()));
    extracted.doctors.forEach(d => {
      if (d.name && !existing.has(d.name.toLowerCase())) {
        results.doctors.push(d);
        existing.add(d.name.toLowerCase());
      }
    });
  }

  // Take best contact info
  if (!results.contact?.phone && extracted.phone) results.contact = results.contact || {};
  if (extracted.phone && !results.contact?.phone) { results.contact = results.contact || {}; results.contact.phone = extracted.phone; }
  if (extracted.email && !results.contact?.email) { results.contact = results.contact || {}; results.contact.email = extracted.email; }
  if (extracted.address && !results.contact?.address) { results.contact = results.contact || {}; results.contact.address = extracted.address; }
  if (extracted.city && !results.contact?.city) { results.contact = results.contact || {}; results.contact.city = extracted.city; }

  // Hours
  if (extracted.hours && !results.hours) results.hours = extracted.hours;

  // Social
  ['facebook','instagram','tiktok','youtube','whatsapp'].forEach(p => {
    if (extracted[p] && !results.social[p]) results.social[p] = extracted[p];
  });

  // Facilities
  if (extracted.facilities) Object.assign(results.facilities, extracted.facilities);

  // Payments
  if (extracted.payments) Object.assign(results.payments, extracted.payments);
}

module.exports = { crawlAndExtract };
