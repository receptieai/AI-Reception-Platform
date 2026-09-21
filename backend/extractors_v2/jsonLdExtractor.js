'use strict';

// Full Schema.org / JSON-LD extraction.
// Returns a structured object with: business, services, people, faq, openingHours.
// Each item carries { value fields..., source: 'json_ld', confidence: 95 }.

const { extractJsonLd } = require('./utils');

const BUSINESS_TYPES = new Set([
  'LocalBusiness', 'MedicalBusiness', 'Dentist', 'Physician', 'MedicalClinic',
  'Dentistry', 'VeterinaryCare', 'VeterinaryBusiness', 'BeautySalon',
  'HealthAndBeautyBusiness', 'Physiotherapy', 'Physician', 'Hospital',
  'MedicalOrganization', 'Organization', 'Store', 'ProfessionalService',
]);

const HOURS_TYPES = new Set([
  'OpeningHoursSpecification', 'OpeningHours',
]);

function isObj(x) { return x && typeof x === 'object'; }
function asArray(x) { return x == null ? [] : (Array.isArray(x) ? x : [x]); }

function text(x) {
  if (x == null) return null;
  if (typeof x === 'string') return x.trim() || null;
  if (typeof x === 'number') return String(x);
  if (Array.isArray(x)) return asArray(x).map(text).filter(Boolean).join(', ') || null;
  if (isObj(x)) {
    if (typeof x.name === 'string') return x.name;
    if (typeof x['@value'] === 'string') return x['@value'];
  }
  return null;
}

function pick(obj, keys) {
  for (const k of keys) { if (obj && obj[k] != null && obj[k] !== '') return obj[k]; }
  return null;
}

// ---------------------------------------------------------------------------
// BUSINESS (LocalBusiness / MedicalBusiness / etc.)
// ---------------------------------------------------------------------------
function extractBusiness(items) {
  const best = { name: null, phone: null, email: null, address: null, city: null, geo: null, sameAs: [] };
  let score = 0;
  for (const item of items) {
    const types = asArray(item['@type']).filter(Boolean);
    const isBiz = types.some(t => BUSINESS_TYPES.has(t));
    if (!isBiz) continue;
    const name = text(item.name) || text(item.legalName);
    const phone = text(item.telephone);
    const email = text(item.email);
    const addr = isObj(item.address) ? item.address : null;
    const street = addr ? text(addr.streetAddress) : null;
    const city = addr ? text(addr.addressLocality) : null;
    const postal = addr ? text(addr.postalCode) : null;
    const region = addr ? text(addr.addressRegion) : null;
    const geo = isObj(item.geo) ? { lat: text(item.geo.latitude), lng: text(item.geo.longitude) } : null;
    const sameAs = asArray(item.sameAs || []).map(text).filter(Boolean);

    // Score: prefer items that have more fields
    const s = (name ? 1 : 0) + (phone ? 1 : 0) + (email ? 1 : 0) + (street ? 1 : 0) + (city ? 1 : 0) + (geo ? 1 : 0);
    if (s > score) {
      score = s;
      best.name = name;
      best.phone = phone;
      best.email = email;
      best.address = [street, postal ? postal + ' ' : '', city, region ? (region + ', ') : ''].join('').replace(/\s+/g, ' ').trim() || null;
      best.city = city;
      best.geo = geo;
      best.sameAs = sameAs;
    }
  }
  return { ...best, hasAny: score > 0, confidence: best.name || best.phone ? 95 : 0 };
}

// ---------------------------------------------------------------------------
// SERVICES (Service, MedicalTherapy, MedicalProcedure, Service offers)
// ---------------------------------------------------------------------------
function extractServicesFromJsonLd(items) {
  const out = [];
  const seen = new Set();
  const visit = (item) => {
    const types = asArray(item['@type']).filter(Boolean);
    const isSvc = types.some(t => ['Service', 'MedicalTherapy', 'MedicalProcedure', 'MedicalCondition', 'Offer', 'Product'].includes(t))
      || types.some(t => /service|therap|procedure/i.test(t));
    if (!isSvc) return;
    const name = text(item.name);
    if (!name) return;
    const offers = asArray(item.offers || item.priceSpecification || []);
    let price = null;
    for (const o of offers) {
      const p = text(o.price) || text(o['@value']);
      if (p && /^\d/.test(p)) { price = p; break; }
    }
    if (!price) price = text(item.price) || null;
    const priceCurrency = text(pick(item, ['priceCurrency']) || (offers[0] && offers[0].priceCurrency)) || null;
    const description = text(item.description) || null;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name, price: price ? (price + (priceCurrency ? ' ' + priceCurrency : ' LEI')) : null,
      description, source: 'json_ld', method: 'JSON-LD Service', confidence: 95,
    });
  };
  for (const item of items) visit(item);
  return out;
}

// ---------------------------------------------------------------------------
// PEOPLE (Person, Physician, Physician)
// ---------------------------------------------------------------------------
function extractPeopleFromJsonLd(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const types = asArray(item['@type']).filter(Boolean);
    const isPerson = types.some(t => ['Person', 'Physician', 'Employee', 'MedicalClinic'].includes(t));
    if (!isPerson) continue;
    let name = text(item.name);
    if (!name && (item.givenName || item.familyName)) {
      name = [item.givenName, item.familyName].filter(Boolean).map(x => text(x)).filter(Boolean).join(' ');
    }
    if (!name) continue;
    const specialty = text(item.jobTitle) || text(item.medicalSpecialty) || text(item.specialty) || null;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, specialty, source: 'json_ld', method: 'JSON-LD Person', confidence: 95 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// FAQ (FAQPage)
// ---------------------------------------------------------------------------
function extractFaqFromJsonLd(items) {
  const out = [];
  const seen = new Set();
  const walk = (node) => {
    if (!isObj(node)) return;
    const types = asArray(node['@type']).filter(Boolean);
    if (types.includes('FAQPage')) {
      for (const q of asArray(node.mainEntity)) walkQuestion(q);
    }
    if (types.includes('Question')) walkQuestion(node);
  };
  const walkQuestion = (q) => {
    if (!isObj(q)) return;
    const name = text(q.name);
    const accepted = asArray(q.acceptedAnswer);
    const answer = accepted.length ? text(accepted[0]) || (accepted[0] && text(accepted[0].text)) : null;
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ q: name, a: answer || '', source: 'json_ld', method: 'JSON-LD FAQ', confidence: 95 });
  };
  for (const item of items) walk(item);
  return out;
}

// ---------------------------------------------------------------------------
// OPENING HOURS
// ---------------------------------------------------------------------------
function extractHoursFromJsonLd(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const types = asArray(item['@type']).filter(Boolean);
    const isHours = types.some(t => HOURS_TYPES.has(t));
    // Also handle nested openingHours inside a business item
    if (isHours || isObj(item.openingHours) || Array.isArray(item.openingHours)) {
      const specs = isHours ? [item] : asArray(item.openingHours);
      for (const s of specs) {
        const dows = asArray(s.dayOfWeek).map(x => text(x)).filter(Boolean);
        const opens = text(s.opens);
        const closes = text(s.closes);
        if (dows.length && opens && closes) {
          const key = dows.join(',') + opens + closes;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ days: dows, opens, closes, source: 'json_ld', method: 'JSON-LD OpeningHours', confidence: 95 });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// TOP-LEVEL API
// ---------------------------------------------------------------------------
function extractJsonLdFull(html) {
  const items = extractJsonLd(html);
  return {
    items,
    business: extractBusiness(items),
    services: extractServicesFromJsonLd(items),
    people: extractPeopleFromJsonLd(items),
    faq: extractFaqFromJsonLd(items),
    openingHours: extractHoursFromJsonLd(items),
  };
}

module.exports = { extractJsonLdFull, extractBusiness, extractServicesFromJsonLd, extractPeopleFromJsonLd, extractFaqFromJsonLd, extractHoursFromJsonLd };
