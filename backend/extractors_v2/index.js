'use strict';
const { extractContact } = require('./contactExtractor');
const { extractDoctors } = require('./doctorExtractor');
const { extractServices } = require('./serviceExtractor');
const { extractFacilities } = require('./facilityExtractor');
const { extractPayments } = require('./paymentExtractor');
const { extractSocial } = require('./socialExtractor');
const { extractHours } = require('./hoursExtractor');
const { isJsSite, renderPage } = require('../playwrightEngine');

async function extractAll(html, url, pageLabel='homepage') {
  const start = Date.now();

  // Playwright fallback pentru site-uri JS cu putine servicii
  let finalHtml = html;
  let textContent = '';

  const initialServices = extractServices(html, pageLabel);
  if (initialServices.items.length < 5 && isJsSite(html)) {
    console.log('[V2] JS site detected, using Playwright for:', url);
    try {
      const rendered = await renderPage(url, { waitAfterLoad: 2000, expandAccordions: true });
      if (rendered.success && rendered.html.length > html.length) {
        finalHtml = rendered.html;
        textContent = rendered.textContent || '';
        console.log('[V2] Playwright upgraded HTML:', finalHtml.length, 'chars');
      }
    } catch(e) {
      console.log('[V2] Playwright failed:', e.message);
    }
  }

  const contact = extractContact(finalHtml, pageLabel);
  const doctors = extractDoctors(finalHtml, pageLabel);
  const services = extractServices(finalHtml, pageLabel);
  const facilities = extractFacilities(finalHtml, pageLabel);
  const payments = extractPayments(finalHtml, pageLabel);
  const social = extractSocial(finalHtml, pageLabel);
  const hours = extractHours(finalHtml, pageLabel);

  // Extract from textContent if contact fields missing
  if (textContent) {
    if (!contact.phone?.value) {
      const pm = textContent.match(/0[7][0-9]{8}/);
      if (pm) contact.phone = { value: pm[0], source: 'textContent', confidence: 75, method: 'text regex' };
    }
    if (!contact.email?.value) {
      const em = textContent.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
      if (em) contact.email = { value: em[0].toLowerCase(), source: 'textContent', confidence: 75, method: 'text regex' };
    }
    if (!contact.city?.value) {
      const cities = ['București','Cluj-Napoca','Timișoara','Iași','Constanța','Craiova','Brașov','Bacău','Arad','Sibiu','Pitești','Oradea','Alba Iulia'];
      const city = cities.find(c => textContent.includes(c));
      if (city) contact.city = { value: city, source: 'textContent', confidence: 65, method: 'city list' };
    }
    if (!contact.address?.value) {
      const am = textContent.match(/(?:Str(?:ada)?|Bd(?:ul)?|Calea|Șos\.?)\s+[A-ZĂÂÎȘȚa-zăâîșț0-9\s\-\.]+(?:nr\.?\s*\d+)/i);
      if (am) contact.address = { value: am[0].trim(), source: 'textContent', confidence: 70, method: 'address regex' };
    }
  }

  const fieldConfidence = {
    phone: contact.phone?.confidence||0,
    email: contact.email?.confidence||0,
    name: contact.name?.confidence||0,
    city: contact.city?.confidence||0,
    address: contact.address?.confidence||0,
    hours: hours.value?.confidence||0,
    facebook: social.facebook?.confidence||0,
    instagram: social.instagram?.confidence||0,
    services: services.items.length>10?90:services.items.length>3?70:services.items.length>0?50:0,
    prices: services.items.filter(s=>s.price).length>10?90:services.items.filter(s=>s.price).length>0?60:0,
  };

  const weights = {phone:15,email:10,name:15,city:5,hours:10,services:25,prices:15,facebook:3,instagram:2};
  let wSum=0, wTotal=0;
  Object.entries(weights).forEach(([k,w])=>{ wSum+=(fieldConfidence[k]||0)*w; wTotal+=w*100; });

  return {
    name: contact.name?.value||null,
    phone: contact.phone?.value||null,
    email: contact.email?.value||null,
    city: contact.city?.value||null,
    address: contact.address?.value||null,
    hours: hours.value?.value||null,
    facebook: social.facebook?.value||null,
    instagram: social.instagram?.value||null,
    tiktok: social.tiktok?.value||null,
    youtube: social.youtube?.value||null,
    whatsapp: social.whatsapp?.value||null,
    linkedin: social.linkedin?.value||null,
    services: services.items,
    doctors: doctors.items,
    facilities,
    payments,
    _confidence: fieldConfidence,
    _globalConfidence: Math.round(wSum/wTotal*100),
    _durationMs: Date.now()-start,
    _usedPlaywright: finalHtml !== html,
  };
}

module.exports = { extractAll };
