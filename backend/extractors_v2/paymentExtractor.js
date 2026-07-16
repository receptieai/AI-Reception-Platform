'use strict';
const { stripHtml } = require('./utils');

function extractPayments(html, page='homepage') {
  const text = stripHtml(html).toLowerCase();
  const payments = {
    cash: { keywords:['numerar','cash'], available:true, confidence:60 },
    card: { keywords:['card','visa','mastercard','pos'], available:false },
    transfer: { keywords:['transfer bancar','ordin de plată','op bancar'], available:false },
    rates: { keywords:['rate','tbi','unicredit','finanțare','plată în rate'], available:false, provider:null },
    cas: { keywords:['cas','cnas','asigurare','decontat'], available:false },
  };
  Object.entries(payments).forEach(([key, cfg]) => {
    if (cfg.keywords.some(kw=>text.includes(kw))) {
      payments[key].available = true;
      payments[key].confidence = 85;
      if (key==='rates') {
        if (text.includes('tbi')) payments[key].provider='TBI';
        else if (text.includes('unicredit')) payments[key].provider='UniCredit';
      }
    }
  });
  return payments;
}

module.exports = { extractPayments };
