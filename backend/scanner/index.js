'use strict';

const { crawl } = require('./crawler');
const { extractAll } = require('../extractors_v2/index');
const { applyBrain, detectIndustry } = require('./businessBrain');
const { fillMissingFields } = require('./claudeEngine');
const { mergeResults } = require('./mergeEngine');
const { calculateConfidence } = require('./confidenceEngine');

async function scan(url, options={}) {
  const startTime = Date.now();
  const apiKey = options.apiKey || process.env.CLAUDE_API_KEY;
  const knownIndustry = options.industry || 'auto';

  console.log('[SCAN] Starting:', url);

  // STEP 1: CRAWLER
  console.log('[SCAN] Step 1: Crawling...');
  const crawlResult = await crawl(url, { maxPages: 12, timeout: 10000 });
  if (!crawlResult.pages || crawlResult.pages.length === 0) {
    throw new Error('Nu am putut accesa site-ul: ' + url);
  }
  console.log('[SCAN] Crawled', crawlResult.pages.length, 'pages');

  // STEP 2: EXTRACTORS — run on combined HTML
  console.log('[SCAN] Step 2: Extracting...');
  const combinedHtml = crawlResult.pages.map(p => p.html).join('\n');
  
  // Run extractors per page for best results
  let bestExtracted = null;
  for (const page of crawlResult.pages) {
    try {
      // Pass a fake URL to prevent Playwright from re-fetching
      const fakeUrl = 'https://recepai-local-extract.invalid/' + page.label;
      const ext = await extractAll(page.html, fakeUrl, page.label);
      if (!bestExtracted) {
        bestExtracted = ext;
      } else {
        // Merge: keep best values
        if (!bestExtracted.phone && ext.phone) bestExtracted.phone = ext.phone;
        if (!bestExtracted.email && ext.email) bestExtracted.email = ext.email;
        if (!bestExtracted.name && ext.name) bestExtracted.name = ext.name;
        if (!bestExtracted.city && ext.city) bestExtracted.city = ext.city;
        if (!bestExtracted.address && ext.address) bestExtracted.address = ext.address;
        if (!bestExtracted.hours && ext.hours) bestExtracted.hours = ext.hours;
        if (!bestExtracted.facebook && ext.facebook) bestExtracted.facebook = ext.facebook;
        if (!bestExtracted.instagram && ext.instagram) bestExtracted.instagram = ext.instagram;
        if (ext.services && ext.services.length > (bestExtracted.services?.length || 0)) {
          bestExtracted.services = ext.services;
          bestExtracted.servicesConfidence = ext._confidence?.services;
        }
        if (ext.doctors && ext.doctors.length > (bestExtracted.doctors?.length || 0)) {
          bestExtracted.doctors = ext.doctors;
        }
      }
    } catch(e) {
      console.log('[SCAN] Extractor error on', page.label, ':', e.message);
    }
  }

  if (!bestExtracted) throw new Error('Extractorii nu au returnat date');

  // Flatten social into extracted
  const extracted = {
    name: bestExtracted.name,
    phone: bestExtracted.phone,
    email: bestExtracted.email,
    city: bestExtracted.city,
    address: bestExtracted.address,
    hours: bestExtracted.hours,
    social: {
      facebook: bestExtracted.facebook ? { value: bestExtracted.facebook, confidence: 90 } : null,
      instagram: bestExtracted.instagram ? { value: bestExtracted.instagram, confidence: 90 } : null,
      tiktok: bestExtracted.tiktok ? { value: bestExtracted.tiktok, confidence: 90 } : null,
      youtube: bestExtracted.youtube ? { value: bestExtracted.youtube, confidence: 90 } : null,
      whatsapp: bestExtracted.whatsapp ? { value: bestExtracted.whatsapp, confidence: 90 } : null,
    },
    services: bestExtracted.services || [],
    servicesConfidence: bestExtracted._confidence?.services || 0,
    doctors: bestExtracted.doctors?.items || bestExtracted.doctors || [],
    facilities: bestExtracted.facilities || {},
    payments: bestExtracted.payments || {},
    _confidence: bestExtracted._confidence || {},
  };

  console.log('[SCAN] Extracted:', {
    phone: !!extracted.phone,
    email: !!extracted.email,
    services: extracted.services.length,
    doctors: extracted.doctors.length,
  });

  // STEP 3: BUSINESS BRAIN
  console.log('[SCAN] Step 3: Business Brain...');
  const industry = detectIndustry(combinedHtml, knownIndustry !== 'auto' ? knownIndustry : null);
  const textForBrain = crawlResult.pages.map(p => p.html.replace(/<[^>]+>/g, ' ')).join(' ');
  const brainResult = applyBrain(textForBrain, industry, extracted);
  console.log('[SCAN] Brain:', industry, '|', brainResult.tags.length, 'tags |', brainResult.facilities.length, 'facilities |', brainResult.insurances.length, 'insurances');

  // STEP 4: DETECT MISSING FIELDS
  const missingFields = [];
  if (!extracted.name) missingFields.push('name');
  if (!extracted.hours) missingFields.push('hours');
  if (extracted.services.length === 0) missingFields.push('services');
  if (extracted.doctors.length === 0) missingFields.push('doctors');
  missingFields.push('faq');
  missingFields.push('description');

  // STEP 5: CLAUDE — only for missing fields
  console.log('[SCAN] Step 4: Claude for missing:', missingFields.join(', '));
  let claudeResult = null;
  if (apiKey && missingFields.length > 0) {
    claudeResult = await fillMissingFields({
      industry,
      pages: crawlResult.pages,
      alreadyExtracted: {
        phone: extracted.phone,
        email: extracted.email,
        name: extracted.name,
        city: extracted.city,
        address: extracted.address,
        hours: extracted.hours,
        facebook: extracted.facebook,
        services_count: extracted.services.length,
        brain_facilities: brainResult.facilities.slice(0, 5),
        brain_insurances: brainResult.insurances,
      },
      missingFields,
      brainInferences: brainResult,
    }, apiKey);
  }

  // STEP 6: MERGE
  console.log('[SCAN] Step 5: Merging...');
  const { merged, sources } = mergeResults(extracted, claudeResult, brainResult);

  // STEP 7: CONFIDENCE
  console.log('[SCAN] Step 6: Confidence...');
  const confidence = calculateConfidence(merged, sources, extracted);
  console.log('[SCAN] Global confidence:', confidence.global + '%');

  const duration = Date.now() - startTime;

  return {
    success: true,
    url,
    origin: crawlResult.origin,
    industry,
    name: merged.name,
    phone: merged.phone,
    email: merged.email,
    city: merged.city,
    address: merged.address,
    hours: merged.hours,
    facebook: merged.facebook,
    instagram: merged.instagram,
    tiktok: merged.tiktok,
    youtube: merged.youtube,
    whatsapp: merged.whatsapp,
    services: merged.services,
    doctors: merged.doctors,
    faq: merged.faq,
    description: merged.description,
    facilities: merged.facilities,
    payments: merged.payments,
    brain: merged.brain,
    confidence: confidence.global,
    fieldConfidence: confidence.fields,
    missing: confidence.missing,
    confidenceBreakdown: confidence.breakdown,
    sources,
    _meta: {
      pagesScanned: crawlResult.totalFetched,
      durationMs: duration,
      industry,
      usedClaude: !!claudeResult,
      extractorServices: extracted.services.length,
      claudeServices: claudeResult?.services?.length || 0,
    },
  };
}

module.exports = { scan };
