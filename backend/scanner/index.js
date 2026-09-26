'use strict';

const { crawl } = require('./crawler');
const { extractAll } = require('../extractors_v2/index');
const { extractJsonLdFull } = require('../extractors_v2/jsonLdExtractor');
const { extractLocations } = require('../extractors_v2/locationExtractor');
const { classifyPage, recommendedExtractors } = require('./pageIntelligence');
const { applyBrain, detectIndustry, getTypicalServices, isJsSite } = require('./businessBrain');
const { fillMissingFields } = require('./claudeEngine');
const { mergeResults } = require('./mergeEngine');
const { calculateConfidence, calculateReadiness } = require('./confidenceEngine');
const scannerLearning = require('../learning/scannerLearning');

/**
 * Union services from all pages by name (case-insensitive).
 * Keeps the highest-confidence version for each unique name.
 * Preserves the original page where each service was found.
 */
function unionServices(perPageLists) {
  const byName = new Map();
  for (const list of perPageLists) {
    for (const svc of list || []) {
      const key = (svc.name || '').toLowerCase().trim();
      if (!key) continue;
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, { ...svc });
      } else {
        // Keep the higher-confidence entry, but preserve any missing price
        if ((svc.confidence || 0) > (existing.confidence || 0)) {
          byName.set(key, { ...svc });
        } else if (!existing.price && svc.price) {
          existing.price = svc.price;
        }
      }
    }
  }
  return [...byName.values()];
}

async function scan(url, options = {}) {
  const startTime = Date.now();
  const apiKey = options.apiKey || process.env.CLAUDE_API_KEY;
  const knownIndustry = options.industry || 'auto';

  console.log('[SCAN] Starting:', url);

  // STEP 1: CRAWLER
  console.log('[SCAN] Step 1: Crawling...');
  const crawlResult = await crawl(url, { maxPages: 15, timeout: 10000 });
  if (!crawlResult.pages || crawlResult.pages.length === 0) {
    throw new Error('Nu am putut accesa site-ul: ' + url);
  }
  console.log('[SCAN] Crawled', crawlResult.pages.length, 'pages');

  // STEP 2: EXTRACTORS — run per page, then UNION
  console.log('[SCAN] Step 2: Extracting per page...');
  const perPageServices = [];
  const allDoctors = [];
  const allLocations = [];   // multi-location chains (2+ distinct addresses)
  let mergedFaq = [];             // JSON-LD FAQ (highest confidence)
  const contactFields = {};   // name, phone, email, city, address
  const socialFields = {};    // facebook, instagram, tiktok, youtube, whatsapp
  const bestHours = { value: null, confidence: 0 };
  let bestFacilities = {};
  let bestPayments = {};
  const maxServicesConfidence = { services: 0, prices: 0 };

  for (const page of crawlResult.pages) {
    try {
      // Page Intelligence: classify before extract, so we know the page's role.
      const pageClass = classifyPage(page.url, page.html);
      page.classification = pageClass;

      // Full JSON-LD extraction — high-confidence structured data.
      let jsonld = null;
      try { jsonld = extractJsonLdFull(page.html); } catch (e) {}

      const ext = await extractAll(page.html, page.url, page.label);
      if (!ext) continue;

      perPageServices.push(ext.services || []);
      if (ext.doctors && ext.doctors.length) {
        for (const d of ext.doctors) {
          const name = (d.name || '').toLowerCase().trim();
          if (!name) continue;
          if (!allDoctors.some(x => (x.name || '').toLowerCase() === name)) {
            allDoctors.push(d);
          }
        }
      }

      // Multi-location detection: run on every page, deduplicate by address
      try {
        const locs = extractLocations(page.html, page.label);
        for (const loc of locs) {
          const key = (loc.address || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
          if (key && !allLocations.some(x => (x.address || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 40) === key)) {
            allLocations.push(loc);
          }
        }
      } catch (e) {
        // location extraction is best-effort
      }

      // JSON-LD people / services / faq — merge in with high confidence
      if (jsonld) {
        for (const p of jsonld.people || []) {
          const name = (p.name || '').toLowerCase().trim();
          if (!name) continue;
          if (!allDoctors.some(x => (x.name || '').toLowerCase() === name)) allDoctors.push(p);
        }
        for (const s of jsonld.services || []) {
          if (!s.name) continue;
          perPageServices[perPageServices.length - 1] = (perPageServices[perPageServices.length - 1] || []);
          if (!perPageServices[perPageServices.length - 1].some(x => (x.name || '').toLowerCase() === s.name.toLowerCase())) {
            perPageServices[perPageServices.length - 1].push(s);
          }
        }
        // JSON-LD FAQ
        if (jsonld.faq && jsonld.faq.length) {
          if (!mergedFaq || mergedFaq.length < jsonld.faq.length) mergedFaq = jsonld.faq.map(f => ({ q: f.q, a: f.a }));
        }
        // JSON-LD business — highest-confidence contact data
        const biz = jsonld.business;
        if (biz) {
          const setBiz = (key, val) => {
            if (val && (!contactFields[key] || contactFields[key]._conf < 95)) {
              contactFields[key] = { value: val, _conf: 95 };
            }
          };
          setBiz('name', biz.name);
          setBiz('phone', biz.phone);
          setBiz('email', biz.email);
          setBiz('address', biz.address);
          setBiz('city', biz.city);
        }
        // JSON-LD opening hours — highest confidence
        if (jsonld.openingHours && jsonld.openingHours.length) {
          const ohLine = jsonld.openingHours.map(h => (h.days || []).map(d => ({ Monday: 'Luni', Tuesday: 'Marți', Wednesday: 'Miercuri', Thursday: 'Joi', Friday: 'Vineri', Saturday: 'Sâmbătă', Sunday: 'Duminică' }[d] || d)).join(',') + ' ' + h.opens + '-' + h.closes).join(' | ');
          if (bestHours.confidence < 95) { bestHours.value = ohLine; bestHours.confidence = 95; }
        }
      }

      const takeIfBetter = (key, val, conf) => {
        if (val && (!contactFields[key] || (conf || 0) > (contactFields[key]._conf || 0))) {
          contactFields[key] = { value: val, _conf: conf || 0 };
        }
      };
      takeIfBetter('name', ext.name, ext._confidence?.name);
      takeIfBetter('phone', ext.phone, ext._confidence?.phone);
      takeIfBetter('email', ext.email, ext._confidence?.email);
      takeIfBetter('city', ext.city, ext._confidence?.city);
      takeIfBetter('address', ext.address, ext._confidence?.address);

      if (ext.facebook) socialFields.facebook = { value: ext.facebook, confidence: 90 };
      if (ext.instagram) socialFields.instagram = { value: ext.instagram, confidence: 90 };
      if (ext.tiktok) socialFields.tiktok = { value: ext.tiktok, confidence: 90 };
      if (ext.youtube) socialFields.youtube = { value: ext.youtube, confidence: 90 };
      if (ext.whatsapp) socialFields.whatsapp = { value: ext.whatsapp, confidence: 90 };

      if (ext.hours && (ext._confidence?.hours || 0) > bestHours.confidence) {
        bestHours.value = ext.hours;
        bestHours.confidence = ext._confidence?.hours || 0;
      }

      const fCount = Object.keys(ext.facilities || {}).length;
      if (fCount > Object.keys(bestFacilities).length) bestFacilities = ext.facilities;
      const pCount = Object.keys(ext.payments || {}).length;
      if (pCount > Object.keys(bestPayments).length) bestPayments = ext.payments;

      const svcConf = ext._confidence?.services || 0;
      const prcConf = ext._confidence?.prices || 0;
      if (svcConf > maxServicesConfidence.services) maxServicesConfidence.services = svcConf;
      if (prcConf > maxServicesConfidence.prices) maxServicesConfidence.prices = prcConf;
    } catch (e) {
      console.log('[SCAN] Extractor error on', page.label, ':', e.message);
    }
  }

  // UNION services from ALL pages by name
  const services = unionServices(perPageServices);
  const servicesWithPrice = services.filter(s => s.price).length;
  console.log('[SCAN] Union services:', services.length, '| with price:', servicesWithPrice,
    '| from', perPageServices.length, 'pages');

  const extracted = {
    name: contactFields.name?.value || null,
    phone: contactFields.phone?.value || null,
    email: contactFields.email?.value || null,
    city: contactFields.city?.value || null,
    address: contactFields.address?.value || null,
    hours: bestHours.value,
    _rawConfidence: {
      name: contactFields.name?._conf || 0,
      phone: contactFields.phone?._conf || 0,
      email: contactFields.email?._conf || 0,
      city: contactFields.city?._conf || 0,
      address: contactFields.address?._conf || 0,
      hours: bestHours.confidence,
    },
    social: {
      facebook: socialFields.facebook || null,
      instagram: socialFields.instagram || null,
      tiktok: socialFields.tiktok || null,
      youtube: socialFields.youtube || null,
      whatsapp: socialFields.whatsapp || null,
    },
    services,
    servicesConfidence: services.length > 10 ? 90 : services.length > 3 ? 70 : services.length > 0 ? 50 : 0,
    doctors: allDoctors,
    locations: allLocations.length >= 2 ? allLocations : [],
    facilities: bestFacilities,
    payments: bestPayments,
    _confidence: {
      services: maxServicesConfidence.services,
      prices: maxServicesConfidence.prices,
    },
  };

  if (!extracted.phone && !extracted.name && services.length === 0) {
    throw new Error('Extractorii nu au returnat date relevante');
  }

  // DIRECT CONTACT RENDER: if email is still null after static extraction of
  // ALL crawled pages, render the contact page directly with Playwright —
  // independent of whether the crawler ever visited /contact (price pages can
  // crowd it out). Tries the crawled contact page first, then /contact/ and
  // /contact (WordPress sites almost always use /contact/).
  if (!extracted.email) {
    const { renderPage } = require('../playwrightEngine');
    const { extractEmail } = require('../extractors_v2/contactExtractor');
    const targets = [];
    const contactPage = crawlResult.pages.find(p => p.label === 'contact' || p.path === '/contact' || p.path === '/contact/');
    if (contactPage && contactPage.url) targets.push(contactPage.url);
    targets.push(crawlResult.origin + '/contact/');
    targets.push(crawlResult.origin + '/contact');
    for (const target of targets.slice(0, 2)) {
      if (extracted.email) break;
      try {
        console.log('[SCAN] Email missing — rendering', target, 'with Playwright…');
        const rendered = await renderPage(target, {
          waitAfterLoad: 1500, scrollPage: false, expandAccordions: false
        });
        if (rendered.success && rendered.html) {
          const cf = extractEmail(rendered.html, 'contact-pw');
          if (cf.value) {
            extracted.email = cf.value;
            extracted._rawConfidence.email = cf.confidence;
            console.log('[SCAN] Playwright recovered email:', cf.value, '(' + cf.confidence + '%)');
          } else {
            const textMatch = (rendered.textContent || '').match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
            if (textMatch) {
              extracted.email = textMatch[0].toLowerCase();
              extracted._rawConfidence.email = 80;
              console.log('[SCAN] Playwright text recovered email:', extracted.email);
            }
          }
        }
      } catch (e) {
        console.log('[SCAN] Contact render failed for', target, ':', e.message);
      }
    }
  }

  // STEP 2.5: LEARNING ENGINE — apply saved corrections (client edits beat
  // fresh extraction). businessKey is passed via options.businessKey.
  let appliedCorrections = [];
  try {
    const businessKey = options.businessKey || crawlResult.origin;
    const corrections = scannerLearning.getCorrections(businessKey);
    for (const [field, c] of Object.entries(corrections)) {
      if (field === 'services' || field.startsWith('price:')) {
        const svcName = field.startsWith('price:') ? decodeURIComponent(field.slice(6)) : null;
        if (c.correction && c.correction.name) {
          // Replace or insert a corrected service.
          const idx = extracted.services.findIndex(s => !svcName || (s.name || '').toLowerCase() === c.correction.name.toLowerCase());
          if (idx >= 0) extracted.services[idx] = { ...c.correction, source: 'corrected', method: 'client correction', confidence: 99 };
          else extracted.services.push({ ...c.correction, source: 'corrected', method: 'client correction', confidence: 99 });
        }
      } else if (['name', 'phone', 'email', 'city', 'address', 'hours'].includes(field)) {
        extracted[field] = c.correction;
        extracted._rawConfidence = extracted._rawConfidence || {};
        extracted._rawConfidence[field] = 99;
        if (field === 'hours') extracted.hours = c.correction;
      }
      appliedCorrections.push({ field, value: c.correction, id: c.id });
    }
    if (appliedCorrections.length) {
      console.log('[SCAN] Applied', appliedCorrections.length, 'saved corrections for', businessKey);
    }
  } catch (e) {
    console.log('[SCAN] Correction apply skipped:', e.message);
  }

  // STEP 3: BUSINESS BRAIN
  console.log('[SCAN] Step 3: Business Brain...');
  const combinedHtml = crawlResult.pages.map(p => p.html).join('\n');
  const industry = detectIndustry(combinedHtml, knownIndustry !== 'auto' ? knownIndustry : null);
  const textForBrain = crawlResult.pages.map(p => p.html.replace(/<[^>]+>/g, ' ')).join(' ');
  const brainResult = applyBrain(textForBrain, industry, extracted);
  console.log('[SCAN] Brain:', industry, '|', brainResult.tags.length, 'tags |', brainResult.facilities.length, 'facilities |', brainResult.insurances.length, 'insurances');

  // STEP 4: DETECT MISSING FIELDS
  const missingFields = [];
  if (!extracted.name) missingFields.push('name');
  if (!extracted.hours) missingFields.push('hours');
  const realSvcs = extracted.services.filter(s => s.method !== 'typical');
  const svcsWithPrice = realSvcs.filter(s => s.price);
  if (realSvcs.length === 0 || svcsWithPrice.length < 3) missingFields.push('services');
  if (extracted.doctors.length === 0) missingFields.push('doctors');
  missingFields.push('faq');
  missingFields.push('description');

  // STEP 5: AI FILL — via inference.js: local OpenMayhem gateway → Claude → skip
  // Works even without CLAUDE_API_KEY as long as the local gateway is reachable
  console.log('[SCAN] Step 4: AI fill for missing:', missingFields.join(', ') || '(none)');
  let claudeResult = null;
  if (missingFields.length > 0) {
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
        facebook: socialFields.facebook?.value,
        services_count: extracted.services.length,
        brain_facilities: brainResult.facilities.slice(0, 5),
        brain_insurances: brainResult.insurances,
      },
      missingFields,
      brainInferences: brainResult,
    }, apiKey);
  }

  // Fallback: typical services per industry (only if we have NOTHING)
  const homepageHtml = crawlResult.pages[0]?.html || '';
  const siteIsJs = isJsSite(homepageHtml);
  if (extracted.services.length === 0) {
    const typical = getTypicalServices(industry);
    if (typical.length > 0) {
      extracted.services = typical.map(s => ({ ...s, source: 'businessBrain', method: 'typical', confidence: 40, page: 'inferred' }));
      extracted.servicesConfidence = 40;
      console.log('[SCAN] Using', typical.length, 'typical services for', industry);
    }
  }

  // STEP 6: MERGE
  console.log('[SCAN] Step 5: Merging...');
  const { merged, sources } = mergeResults(extracted, claudeResult, brainResult);

  // STEP 7: CONFIDENCE
  console.log('[SCAN] Step 6: Confidence...');
  const confidence = calculateConfidence(merged, sources, extracted);
  console.log('[SCAN] Global confidence:', confidence.global + '%');

  const duration = Date.now() - startTime;
  const readiness = calculateReadiness(merged, industry);

  return {
    success: true,
    readiness,
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
    locations: merged.locations || [],
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
      isJsSite: siteIsJs || false,
      durationMs: duration,
      industry,
      usedClaude: !!claudeResult,
      extractorServices: extracted.services.length,
      claudeServices: claudeResult?.services?.length || 0,
      servicesByPage: perPageServices.map((list, i) => ({
        page: crawlResult.pages[i]?.label || ('page-' + i),
        url: crawlResult.pages[i]?.url,
        count: (list || []).length,
      })),
      pageTypes: crawlResult.pages.map(p => p.classification?.type || 'UNKNOWN'),
      appliedCorrections,
    },
  };
}

module.exports = { scan, unionServices };
