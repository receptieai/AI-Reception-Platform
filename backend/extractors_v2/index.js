'use strict';
const { extractContact } = require('./contactExtractor');
const { extractDoctors } = require('./doctorExtractor');
const { extractServices } = require('./serviceExtractor');
const { extractFacilities } = require('./facilityExtractor');
const { extractPayments } = require('./paymentExtractor');
const { extractSocial } = require('./socialExtractor');
const { extractHours } = require('./hoursExtractor');
const { deduplicateAndScore } = require('./utils');

async function extractAll(html, url, pageLabel='homepage') {
  const start = Date.now();
  const contact = extractContact(html, pageLabel);
  const doctors = extractDoctors(html, pageLabel);
  const services = extractServices(html, pageLabel);
  const facilities = extractFacilities(html, pageLabel);
  const payments = extractPayments(html, pageLabel);
  const social = extractSocial(html, pageLabel);
  const hours = extractHours(html, pageLabel);

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
  };
}

module.exports = { extractAll };
