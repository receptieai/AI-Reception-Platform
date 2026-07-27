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

  // Name
  scores.name = sources.name?.confidence || (merged.name ? 70 : 0);

  // Phone
  scores.phone = sources.phone?.confidence || (merged.phone ? 70 : 0);

  // Email
  scores.email = sources.email?.confidence || (merged.email ? 70 : 0);

  // City
  scores.city = sources.city?.confidence || (merged.city ? 60 : 0);

  // Address
  scores.address = sources.address?.confidence || (merged.address ? 60 : 0);

  // Hours
  scores.hours = sources.hours?.confidence || (merged.hours ? 65 : 0);

  // Services — based on count and price coverage
  const svcCount = merged.services?.length || 0;
  const withPrice = (merged.services || []).filter(s => s.price).length;
  const priceRatio = svcCount > 0 ? withPrice / svcCount : 0;
  scores.services = svcCount > 20 ? 95 : svcCount > 10 ? 88 : svcCount > 5 ? 75 : svcCount > 0 ? 55 : 0;
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
  scores.faq = faqCount > 5 ? 90 : faqCount > 2 ? 75 : faqCount > 0 ? 60 : 0;

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

module.exports = { calculateConfidence };
