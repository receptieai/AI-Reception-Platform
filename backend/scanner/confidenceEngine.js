'use strict';

// Confidence Engine — scor per camp + global

const WEIGHTS = {
  name:        { weight: 12, label: 'Nume afacere' },
  phone:       { weight: 15, label: 'Telefon' },
  email:       { weight: 8,  label: 'Email' },
  city:        { weight: 4,  label: 'Oraș' },
  address:     { weight: 4,  label: 'Adresă' },
  hours:       { weight: 8,  label: 'Program' },
  services:    { weight: 20, label: 'Servicii' },
  prices:      { weight: 12, label: 'Prețuri' },
  facebook:    { weight: 3,  label: 'Facebook' },
  instagram:   { weight: 2,  label: 'Instagram' },
  doctors:     { weight: 6,  label: 'Doctori/Echipă' },
  faq:         { weight: 4,  label: 'FAQ' },
  brain:       { weight: 2,  label: 'Business Brain' },
};

function calculateConfidence(merged, sources, extractedRaw) {
  const scores = {};

  // Contact fields — use raw extractor confidence where available
  const rc = extractedRaw?._rawConfidence || {};
  scores.name = Math.max(sources.name?.confidence || 0, rc.name || 0) || (merged.name ? 80 : 0);
  scores.phone = Math.max(sources.phone?.confidence || 0, rc.phone || 0) || (merged.phone ? 80 : 0);
  scores.email = Math.max(sources.email?.confidence || 0, rc.email || 0) || (merged.email ? 80 : 0);
  scores.city = Math.max(sources.city?.confidence || 0, rc.city || 0) || (merged.city ? 70 : 0);
  scores.address = Math.max(sources.address?.confidence || 0, rc.address || 0) || (merged.address ? 70 : 0);
  scores.hours = merged.hours ? Math.max(sources.hours?.confidence || 0, rc.hours || 0, 78) : 0;

  // Services — based on count and price coverage
  const svcCount = merged.services?.length || 0;
  const realSvcs = (merged.services || []).filter(s => s.source !== 'businessBrain' || s.method !== 'typical');
  const typicalSvcs = svcCount - realSvcs.length;
  const withPrice = realSvcs.filter(s => s.price).length;
  const priceRatio = realSvcs.length > 0 ? withPrice / realSvcs.length : 0;
  // Typical services get lower score
  if (typicalSvcs > 0 && realSvcs.length === 0) {
    scores.services = 30; // Only typical — low confidence
  } else {
    scores.services = realSvcs.length > 20 ? 95 : realSvcs.length > 10 ? 88 : realSvcs.length > 5 ? 75 : realSvcs.length > 0 ? 55 : 0;
  }
  scores.prices = priceRatio > 0.8 ? 95 : priceRatio > 0.5 ? 80 : priceRatio > 0.2 ? 60 : withPrice > 0 ? 40 : 0;

  // Social — nu penalizam daca site-ul pur si simplu nu are social media
  // Daca brain a scanat si nu a gasit, consideram 50 (neutral) nu 0
  scores.facebook = merged.facebook ? (sources.facebook?.confidence || 90) : 40;
  scores.instagram = merged.instagram ? (sources.instagram?.confidence || 90) : 40;

  // Doctors
  const docCount = merged.doctors?.length || 0;
  scores.doctors = docCount > 5 ? 90 : docCount > 2 ? 80 : docCount > 0 ? 65 : 0;

  // FAQ
  const faqCount = merged.faq?.length || 0;
  // Daca nu avem FAQ dar avem date bune, AI-ul poate raspunde oricum
  const hasSufficientData = (merged.services?.length > 5 || merged.doctors?.length > 0) && merged.phone;
  scores.faq = faqCount > 5 ? 92 : faqCount > 2 ? 82 : faqCount > 0 ? 65 : hasSufficientData ? 50 : 0;

  // Brain
  scores.brain = Math.min((merged.brain?.facilities?.length || 0) * 8 + (merged.brain?.insurances?.length || 0) * 10, 100);

  // Global weighted score
  let wSum = 0, wTotal = 0;
  for (const [key, { weight }] of Object.entries(WEIGHTS)) {
    wSum += (scores[key] || 0) * weight;
    wTotal += weight * 100;
  }
  const global = Math.round(wSum / wTotal * 100);

  // Missing fields
  const missing = [];
  if (!merged.phone) missing.push('telefon');
  if (!merged.email) missing.push('email');
  if (!merged.hours) missing.push('program');
  if (!merged.address) missing.push('adresa');
  if (svcCount === 0) missing.push('servicii');
  if (withPrice === 0) missing.push('preturi');
  if (docCount === 0) missing.push('echipa');

  return {
    global,
    fields: scores,
    missing,
    breakdown: Object.entries(WEIGHTS).map(([key, { weight, label }]) => ({
      field: key,
      label,
      score: scores[key] || 0,
      weight,
      contribution: Math.round((scores[key] || 0) * weight / wTotal * 100 * 100) / 100,
    })).sort((a, b) => b.score - a.score),
  };
}

function calculateReadiness(merged, industry) {
  let score = 0;
  const missing = [];
  const recommendations = [];

  if (merged.phone) score += 20;
  else { missing.push('Număr de telefon'); recommendations.push('Adaugă telefon vizibil pe site — clienții îl caută primul'); }

  const realSvcs = (merged.services||[]).filter(s => s.method !== 'typical');
  if (realSvcs.length >= 5) score += 20;
  else if (realSvcs.length > 0) { score += 10; recommendations.push('Adaugă mai multe servicii cu prețuri — crește conversia cu 40%'); }
  else { missing.push('Servicii cu prețuri'); recommendations.push('Listează serviciile și prețurile pe site — cel mai important factor de conversie'); }

  if (merged.hours) score += 10;
  else { missing.push('Program de lucru'); recommendations.push('Adaugă programul de lucru — 60% din clienți întreabă când ești deschis'); }

  if (merged.email) score += 8;
  else { missing.push('Email de contact'); recommendations.push('Adaugă email de contact pe site'); }

  if (merged.faq?.length >= 3) score += 10;
  else { recommendations.push('Adaugă FAQ — AI-ul va răspunde mai bine la întrebări frecvente'); }

  if (merged.facebook || merged.instagram) score += 7;
  else { recommendations.push('Linkează social media — crește credibilitatea'); }

  if (merged.brain?.insurances?.length) score += 10;
  else if (['dental','medical','physio'].includes(industry)) {
    recommendations.push('Menționează asigurările acceptate pe site');
  }

  if (merged.doctors?.length) score += 8;
  else if (['dental','medical','vet','physio'].includes(industry)) {
    recommendations.push('Adaugă pagina echipei cu medicii — crește încrederea pacienților');
  }

  if (merged.address) score += 7;
  else { missing.push('Adresă'); recommendations.push('Adaugă adresa completă pe site'); }

  return {
    score: Math.min(score, 100),
    missing,
    recommendations: recommendations.slice(0, 5),
    grade: score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F'
  };
}

module.exports = { calculateConfidence, calculateReadiness };
