'use strict';

/**
 * AI Output Validator — the last gate before the model's answer is trusted.
 *
 * LLMs hallucinate: they invent phone numbers, prices and hours that were
 * never on the page. This module rejects impossible values deterministically
 * (no AI) so a bad hallucination never reaches the client's widget.
 *
 *   - phone: must be a plausible RO number (07xx / 02xx-03xx / +40)
 *   - email: standard format + not an image link
 *   - hours: must mention a day name or a time range
 *   - services: names are kept, impossible prices are nulled (service kept,
 *     price dropped — the service itself is still useful)
 *
 * Returns { data, dropped } where dropped lists rejected fields.
 */

const { isValidEmail } = require('../extractors_v2/utils');

function isRoPhone(p) {
  if (!p || typeof p !== 'string') return false;
  const d = p.replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('40')) {          // +40 …
    const n = d.charAt(2);
    return n >= '2' && n <= '7';
  }
  if (d.length === 10 && d.charAt(0) === '0') return true; // 02xx/03xx/07xx
  if (d.length === 9 && d.charAt(0) === '7') return true;  // 7xx (no leading 0)
  return false;
}

function isPrice(p) {
  if (p === null || p === undefined) return true; // null price is fine
  if (typeof p !== 'string') return false;
  // "150 RON", "2.500 lei", "350 lei", "1.200 RON", "de la 200 RON"
  return /\d{2,6}(?:[ .,]\d{1,2})*\s*(?:RON|lei|lei)/i.test(p)
    || /^[\d .,]{2,12}$/i.test(p.trim());
}

function isHours(h) {
  if (!h || typeof h !== 'string') return false;
  return /luni|mar[țt]i|miercuri|joi|vineri|s[âa]mb[âa]t[âa]|duminic|non-?stop|\d{1,2}\s*[:\-]\s*\d{2}/i.test(h);
}

function validateAiOutput(parsed) {
  const dropped = [];
  if (!parsed || typeof parsed !== 'object') return { data: parsed, dropped };

  const d = { ...parsed };

  if (d.phone != null && !isRoPhone(d.phone)) {
    dropped.push('phone (imposibil RO)');
    d.phone = null;
  }
  if (d.email != null && !isValidEmail(d.email)) {
    dropped.push('email (format invalid)');
    d.email = null;
  }
  if (d.hours != null && !isHours(d.hours)) {
    dropped.push('hours (nu seamănă cu program)');
    d.hours = null;
  }
  if (Array.isArray(d.services)) {
    d.services = d.services
      .filter(s => s && typeof s.name === 'string' && s.name.length > 1)
      .map(s => {
        if (s.price != null && !isPrice(s.price)) {
          dropped.push('price:' + s.name);
          return { ...s, price: null, _priceRejected: true };
        }
        return s;
      });
  }
  return { data: d, dropped };
}

module.exports = { validateAiOutput, isRoPhone, isPrice, isHours };
