'use strict';
const { stripHtml } = require('./utils');

const FACILITIES = {
  parking: { keywords:['parcare','parking','loc de parcare'], question:'Există parcare?' },
  card: { keywords:['card','visa','mastercard','pos','plată cu cardul','plata cu cardul'], question:'Acceptați plata cu cardul?' },
  cas: { keywords:['CAS','CNAS','casa de asigurari','casa de asigurări','decontat','asigurare'], question:'Acceptați asigurări?' },
  wifi: { keywords:['wifi','wi-fi','wireless'], question:'Există WiFi?' },
  urgency: { keywords:['urgente','urgențe','urgență','non-stop','24h','24/7'], question:'Acceptați urgențe?' },
  lift: { keywords:['lift','elevator','ascensor'], question:'Există lift?' },
  disability: { keywords:['persoane cu dizabilități','persoane cu dizabilitati','rampa','rampă'], question:'Există acces pentru persoane cu dizabilități?' },
  whatsapp: { keywords:['whatsapp','wa.me'], question:'Puteți fi contactați pe WhatsApp?' },
  online_booking: { keywords:['programare online','rezervare online','programeaza-te','programează-te'], question:'Există programare online?' },
  rates: { keywords:['rate','tbi','unicredit','plata in rate','plată în rate','finanțare'], question:'Acceptați plata în rate?' },
};

function extractFacilities(html, page='homepage') {
  const text = stripHtml(html).toLowerCase();
  const result = {};
  Object.entries(FACILITIES).forEach(([key, cfg]) => {
    const found = cfg.keywords.some(kw=>text.includes(kw.toLowerCase()));
    if (found) {
      const kw = cfg.keywords.find(kw=>text.includes(kw.toLowerCase()));
      const idx = text.indexOf(kw);
      const ctx = text.substring(Math.max(0,idx-50),idx+150);
      result[key] = { available:!/nu\s+(?:avem|există|acceptam)/.test(ctx), details:/gratuit|gratis/.test(ctx)?'gratuită':null, source:page, confidence:75, question:cfg.question };
    }
  });
  return result;
}

module.exports = { extractFacilities };
