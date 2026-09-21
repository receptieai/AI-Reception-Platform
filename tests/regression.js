'use strict';

// ── OFFLINE REGRESSION SUITE ────────────────────────────────────────
// Runs the FULL scanner pipeline (extractors → JSON-LD → hours →
// business brain → merge → confidence) against LOCAL HTML FIXTURES.
//
// No network. No Claude. Deterministic. Run after EVERY extractor
// change to prove nothing regressed:
//
//   node tests/regression.js
//
// A fixture is a directory under tests/fixtures/ containing:
//   - one or more .html files (any number of "pages")
//   - expected.json  (what the scanner MUST find)
//
// expected.json:
//   {
//     "name":   "DentaVita Clinic",
//     "phone":  "+40 745 111 222",
//     "email":  "office@dentavita.ro",
//     "city":   "Cluj-Napoca",
//     "hours":  "Luni-Vineri 09:00-18:00",     // substring match
//     "services": [ "Implant dentar", "Aparat dentar Invisalign" ], // names must appear
//     "prices": 2,                              // min count of services with a price
//     "doctors": ["Dr. Ana Popescu"],
//     "faq": 2                                  // min FAQ count
//   }
//
// Exit code 0 = all pass, 1 = any failure.

const fs = require('fs');
const path = require('path');
const { extractAll } = require('../backend/extractors_v2/index');
const { extractJsonLdFull } = require('../backend/extractors_v2/jsonLdExtractor');
const { extractHours } = require('../backend/extractors_v2/hoursExtractor');
const { extractContact } = require('../backend/extractors_v2/contactExtractor');
const { applyBrain, detectIndustry, getTypicalServices } = require('../backend/scanner/businessBrain');
const { mergeResults } = require('../backend/scanner/mergeEngine');
const { calculateConfidence, calculateReadiness } = require('../backend/scanner/confidenceEngine');
const { unionServices } = require('../backend/scanner/index');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// Run the same pipeline the real scanner uses, but over local HTML files
// instead of a crawl. Returns a result shaped like scan().
async function scanFixture(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
  if (!files.length) throw new Error('no .html files in fixture ' + path.basename(dir));
  const pages = files.map(f => {
    const html = fs.readFileSync(path.join(dir, f), 'utf8');
    const name = path.basename(f, '.html');
    return { url: 'fixture://' + name, path: '/' + name, html, label: name };
  });

  const perPageServices = [];
  const allDoctors = [];
  const contactFields = {};
  const socialFields = {};
  let bestHours = { value: null, confidence: 0 };
  let bestFacilities = {};
  let bestPayments = {};
  let mergedFaq = [];
  const maxServicesConfidence = { services: 0, prices: 0 };

  for (const page of pages) {
    const ext = await extractAll(page.html, page.url, page.label);
    if (!ext) continue;
    perPageServices.push(ext.services || []);

    let jsonld = null;
    try { jsonld = extractJsonLdFull(page.html); } catch (e) {}
    if (jsonld) {
      for (const p of jsonld.people || []) {
        const n = (p.name || '').toLowerCase();
        if (n && !allDoctors.some(x => (x.name || '').toLowerCase() === n)) allDoctors.push(p);
      }
      const list = perPageServices[perPageServices.length - 1] || (perPageServices.push([]), perPageServices[perPageServices.length - 1]);
      for (const s of jsonld.services || []) {
        if (!s.name) continue;
        if (!list.some(x => (x.name || '').toLowerCase() === s.name.toLowerCase())) list.push(s);
      }
      if (jsonld.faq && jsonld.faq.length && mergedFaq.length < jsonld.faq.length) {
        mergedFaq = jsonld.faq.map(f => ({ q: f.q, a: f.a }));
      }
      const biz = jsonld.business;
      if (biz) {
        const setBiz = (k, v) => { if (v && (!contactFields[k] || contactFields[k]._conf < 95)) contactFields[k] = { value: v, _conf: 95 }; };
        setBiz('name', biz.name); setBiz('phone', biz.phone); setBiz('email', biz.email);
        setBiz('address', biz.address); setBiz('city', biz.city);
      }
      if (jsonld.openingHours && jsonld.openingHours.length) {
        const ohLine = jsonld.openingHours.map(h => (h.days || []).join(',') + ' ' + h.opens + '-' + h.closes).join(' | ');
        if (bestHours.confidence < 95) { bestHours.value = ohLine; bestHours.confidence = 95; }
      }
    }

    const takeIfBetter = (key, val, conf) => {
      if (val && (!contactFields[key] || (conf || 0) > (contactFields[key]._conf || 0))) contactFields[key] = { value: val, _conf: conf || 0 };
    };
    takeIfBetter('name', ext.name, ext._confidence?.name);
    takeIfBetter('phone', ext.phone, ext._confidence?.phone);
    takeIfBetter('email', ext.email, ext._confidence?.email);
    takeIfBetter('city', ext.city, ext._confidence?.city);
    takeIfBetter('address', ext.address, ext._confidence?.address);

    if (ext.facebook) socialFields.facebook = { value: ext.facebook, confidence: 90 };
    if (ext.instagram) socialFields.instagram = { value: ext.instagram, confidence: 90 };
    if (ext.hours && (ext._confidence?.hours || 0) > bestHours.confidence) {
      bestHours.value = ext.hours; bestHours.confidence = ext._confidence?.hours || 0;
    }
    if (Object.keys(ext.facilities || {}).length > Object.keys(bestFacilities).length) bestFacilities = ext.facilities;
    if (Object.keys(ext.payments || {}).length > Object.keys(bestPayments).length) bestPayments = ext.payments;
    const s = ext._confidence?.services || 0, p = ext._confidence?.prices || 0;
    if (s > maxServicesConfidence.services) maxServicesConfidence.services = s;
    if (p > maxServicesConfidence.prices) maxServicesConfidence.prices = p;
  }

  const services = unionServices(perPageServices);
  const extracted = {
    name: contactFields.name?.value || null,
    phone: contactFields.phone?.value || null,
    email: contactFields.email?.value || null,
    city: contactFields.city?.value || null,
    address: contactFields.address?.value || null,
    hours: bestHours.value,
    _rawConfidence: {
      name: contactFields.name?._conf || 0, phone: contactFields.phone?._conf || 0,
      email: contactFields.email?._conf || 0, city: contactFields.city?._conf || 0,
      address: contactFields.address?._conf || 0, hours: bestHours.confidence,
    },
    social: {
      facebook: socialFields.facebook || null, instagram: socialFields.instagram || null,
      tiktok: null, youtube: null, whatsapp: null,
    },
    services,
    servicesConfidence: services.length > 10 ? 90 : services.length > 3 ? 70 : services.length > 0 ? 50 : 0,
    doctors: allDoctors,
    facilities: bestFacilities,
    payments: bestPayments,
    _confidence: { services: maxServicesConfidence.services, prices: maxServicesConfidence.prices },
  };

  const combinedHtml = pages.map(p => p.html).join('\n');
  const industry = detectIndustry(combinedHtml, null);
  const textForBrain = pages.map(p => p.html.replace(/<[^>]+>/g, ' ')).join(' ');
  const brainResult = applyBrain(textForBrain, industry, extracted);
  const faq = mergedFaq.length ? mergedFaq : [];
  const claudeResult = { faq, description: faq.length ? null : null };
  const { merged, sources } = mergeResults(extracted, claudeResult, brainResult);
  merged.faq = faq; // JSON-LD FAQ wins over empty
  const confidence = calculateConfidence(merged, sources, extracted);
  const readiness = calculateReadiness(merged, industry);

  return {
    success: true, readiness, industry,
    name: merged.name, phone: merged.phone, email: merged.email,
    city: merged.city, address: merged.address, hours: merged.hours,
    services: merged.services, doctors: merged.doctors, faq,
    brain: merged.brain, confidence: confidence.global,
    fieldConfidence: confidence.fields, readinessScore: readiness.score,
    _meta: { pagesScanned: pages.length },
  };
}

// Score one fixture result against its expected.json.
function checkFixture(name, result, expected) {
  const failures = [];
  const checks = [];
  const norm = (x) => String(x == null ? '' : x).toLowerCase().replace(/\s+/g, ' ').trim();

  const expectEq = (field, actual, exp) => {
    const a = norm(actual), e = norm(exp);
    const pass = a === e;
    checks.push({ field, pass, actual, expected: exp });
    if (!pass) failures.push(field + ': expected "' + exp + '" got "' + (actual || '(null)') + '"');
  };
  const expectIncludes = (field, actual, sub) => {
    const pass = actual != null && String(actual).toLowerCase().includes(String(sub).toLowerCase());
    checks.push({ field, pass, actual, expected: 'includes ' + sub });
    if (!pass) failures.push(field + ': should include "' + sub + '" got "' + (actual || '(null)') + '"');
  };
  const expectEach = (field, items, names) => {
    for (const n of names) {
      const pass = items.some(s => (s.name || '').toLowerCase().includes(String(n).toLowerCase()));
      checks.push({ field, pass, actual: items.length + ' items', expected: 'includes "' + n + '"' });
      if (!pass) failures.push(field + ': missing service/doctor "' + n + '"');
    }
  };
  const expectMin = (field, actual, min) => {
    const pass = actual >= min;
    checks.push({ field, pass, actual, expected: '>= ' + min });
    if (!pass) failures.push(field + ': expected >= ' + min + ' got ' + actual);
  };

  if (expected.name) expectEq('name', result.name, expected.name);
  if (expected.phone) expectEq('phone', result.phone, expected.phone);
  if (expected.email) expectEq('email', result.email, expected.email);
  if (expected.city) expectIncludes('city', result.city, expected.city);
  if (expected.hours) expectIncludes('hours', result.hours, expected.hours);
  if (expected.services) expectEach('services', result.services, expected.services);
  if (expected.doctors) expectEach('doctors', result.doctors, expected.doctors);
  if (expected.prices) expectMin('prices', result.services.filter(s => s.price).length, expected.prices);
  if (expected.faq) expectMin('faq', (result.faq || []).length, expected.faq);
  if (expected.minConfidence) expectMin('confidence', result.confidence, expected.minConfidence);

  return { name, pass: failures.length === 0, failures, checks, confidence: result.confidence, serviceCount: result.services.length };
}

async function runAll() {
  const dirs = fs.readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(FIXTURES_DIR, d.name));

  let passCount = 0;
  const results = [];
  for (const dir of dirs) {
    const expFile = path.join(dir, 'expected.json');
    if (!fs.existsSync(expFile)) { console.log('· skip ' + path.basename(dir) + ' (no expected.json)'); continue; }
    const expected = JSON.parse(fs.readFileSync(expFile, 'utf8'));
    try {
      const result = await scanFixture(dir);
      const r = checkFixture(path.basename(dir), result, expected);
      results.push(r);
      passCount += r.pass ? 1 : 0;
      const icon = r.pass ? '✅ PASS' : '❌ FAIL';
      console.log(icon + ' ' + r.name + '  (conf ' + r.confidence + '%, ' + r.serviceCount + ' services)');
      if (!r.pass) r.failures.forEach(f => console.log('     - ' + f));
    } catch (e) {
      results.push({ name: path.basename(dir), pass: false, failures: ['RUN ERROR: ' + e.message] });
      console.log('❌ FAIL ' + path.basename(dir) + '  RUN ERROR: ' + e.message);
    }
  }

  const total = results.length;
  console.log('\n' + '='.repeat(56));
  console.log('  REGRESSION SUITE: ' + passCount + '/' + total + ' fixtures pass');
  console.log('='.repeat(56));
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = path.join(__dirname, 'regression-results', 'regression-' + ts + '.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ timestamp: ts, pass: passCount, total, results }, null, 2));
  console.log('  saved: ' + path.relative(process.cwd(), outFile));
  process.exitCode = passCount === total && total > 0 ? 0 : 1;
}

// Auto-run only when executed directly (not when required as a module).
if (require.main === module) {
  runAll().catch(e => { console.error(e); process.exitCode = 1; });
}

module.exports = { scanFixture, checkFixture, runAll };
