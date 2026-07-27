'use strict';

// Merge Engine — fiecare câmp are propriul câștigător
// Extractorul câștigă dacă are confidence mai mare

function pickBest(...candidates) {
  // candidates: [{value, confidence, source}]
  const valid = candidates.filter(c => c && c.value !== null && c.value !== undefined && c.value !== '');
  if (valid.length === 0) return { value: null, confidence: 0, source: 'none' };
  return valid.reduce((best, c) => c.confidence > best.confidence ? c : best);
}

function mergeResults(extracted, claudeResult, brainResult) {
  const merged = {};
  const sources = {};

  // CONTACT FIELDS — extractor wins
  const contactFields = ['name', 'phone', 'email', 'city', 'address'];
  for (const field of contactFields) {
    const extVal = extracted[field];
    const claudeVal = claudeResult?.[field];
    const best = pickBest(
      extVal ? { value: extVal.value || extVal, confidence: extVal.confidence || 80, source: 'extractor' } : null,
      claudeVal ? { value: claudeVal, confidence: 70, source: 'claude' } : null,
    );
    merged[field] = best.value;
    sources[field] = { value: best.value, confidence: best.confidence, source: best.source };
  }

  // HOURS — extractor wins, Claude fills if missing
  const hoursExt = extracted.hours;
  const hoursClaude = claudeResult?.hours;
  const hoursBest = pickBest(
    hoursExt ? { value: hoursExt.value || hoursExt, confidence: hoursExt.confidence || 78, source: 'extractor' } : null,
    hoursClaude ? { value: hoursClaude, confidence: 65, source: 'claude' } : null,
  );
  merged.hours = hoursBest.value;
  sources.hours = { value: hoursBest.value, confidence: hoursBest.confidence, source: hoursBest.source };

  // SOCIAL — extractor wins
  const socialFields = ['facebook', 'instagram', 'tiktok', 'youtube', 'whatsapp', 'linkedin'];
  for (const field of socialFields) {
    const extVal = extracted.social?.[field];
    merged[field] = extVal?.value || null;
    sources[field] = extVal ? { value: extVal.value, confidence: extVal.confidence || 90, source: 'extractor' } : { value: null, confidence: 0, source: 'none' };
  }

  // SERVICES — extractor wins, merge with Claude if extractor has < 5
  const extServices = extracted.services || [];
  const claudeServices = claudeResult?.services || [];
  if (extServices.length >= 5) {
    merged.services = extServices;
    sources.services = { count: extServices.length, confidence: extracted.servicesConfidence || 85, source: 'extractor' };
  } else if (claudeServices.length > extServices.length) {
    merged.services = claudeServices;
    sources.services = { count: claudeServices.length, confidence: 70, source: 'claude' };
  } else {
    merged.services = extServices;
    sources.services = { count: extServices.length, confidence: 50, source: 'extractor' };
  }

  // DOCTORS — extractor wins
  merged.doctors = extracted.doctors || [];
  sources.doctors = { count: merged.doctors.length, confidence: merged.doctors.length > 0 ? 85 : 0, source: 'extractor' };

  // FAQ — Claude wins (extractorul nu extrage FAQ)
  const claudeFaq = claudeResult?.faq || [];
  merged.faq = claudeFaq;
  sources.faq = { count: claudeFaq.length, confidence: claudeFaq.length > 0 ? 80 : 0, source: 'claude' };

  // DESCRIPTION — Claude wins
  merged.description = claudeResult?.description || null;
  sources.description = { value: merged.description, confidence: merged.description ? 75 : 0, source: 'claude' };

  // BRAIN INFERENCES
  merged.brain = brainResult ? {
    industry: brainResult.industry,
    tags: brainResult.tags || [],
    facilities: brainResult.facilities || [],
    insurances: brainResult.insurances || [],
    specialties: brainResult.specialties || [],
    technologies: brainResult.technologies || [],
    emergency: brainResult.emergency || false,
    parking: brainResult.parking || false,
    weekendHours: brainResult.weekendHours || false,
  } : {};
  sources.brain = { confidence: brainResult?.brainScore || 0, source: 'businessBrain' };

  // FACILITIES — merge extractor + brain
  const extFacilities = extracted.facilities || {};
  const brainFacilities = brainResult?.facilities || [];
  merged.facilities = { ...extFacilities, brainInferred: brainFacilities };

  // PAYMENTS
  merged.payments = extracted.payments || {};

  return { merged, sources };
}

module.exports = { mergeResults };
