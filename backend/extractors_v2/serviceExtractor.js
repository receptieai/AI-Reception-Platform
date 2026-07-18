'use strict';
const { extractJsonLd } = require('./utils');

const PRICE_REGEX = /(\d{1,5}(?:[.,]\d{2}?)?)\s*(?:lei|ron|€|eur|\$)/i;

function cleanName(name) {
  return name.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').replace(/^[\-–—•·\s]+/,'').trim();
}

function isValidName(name) {
  if (!name || name.length < 3 || name.length > 120) return false;
  if (!/[a-zA-ZăâîșțĂÂÎȘȚ]{3,}/.test(name)) return false;
  if (/^[\\/\d\s\-\+\.]+$/.test(name)) return false;
  return true;
}

function extractServices(html, page='homepage') {
  const services = [];
  const seen = new Set();

  function add(name, price, source, method, confidence) {
    const n = cleanName(name);
    if (!isValidName(n)) return;
    if (seen.has(n.toLowerCase())) return;
    seen.add(n.toLowerCase());
    services.push({ name: n, price: price ? price.replace(/\s+/g,' ').trim().toUpperCase() : null, source, method, confidence, page });
  }

  // JSON-LD (95%)
  extractJsonLd(html).forEach(item => {
    [].concat(item.offers||[]).forEach(o => { if (o.name) add(o.name, o.price?o.price+' LEI':null,'json_ld','JSON-LD Offer',95); });
  });

  // Table rows (88%)
  [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].forEach(m => {
    const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c=>c[1].replace(/<[^>]+>/g,'').trim());
    if (cells.length >= 2) {
      const priceCell = cells.find(c=>PRICE_REGEX.test(c));
      const nameCell = cells.find(c=>!PRICE_REGEX.test(c)&&c.length>3&&/[a-zA-ZăâîșțĂÂÎȘȚ]{3,}/.test(c));
      if (priceCell && nameCell) add(nameCell, priceCell,'html_table','table row',88);
    }
  });

  // List items (85%)
  [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].forEach(m => {
    const text = m[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    const pm = text.match(PRICE_REGEX);
    if (pm) add(text.replace(pm[0],'').replace(/[-–:.\s]+$/,'').trim(), pm[0],'html_list','li with price',85);
  });

  // Dash/tilde pattern (82%)
  const lines = html.replace(/<[^>]+>/g,'\n').split('\n').map(l=>l.trim()).filter(l=>l.length>2);
  lines.forEach(line => {
    const m = line.match(/^([A-ZĂÂÎȘȚa-zăâîșț][^–~\-]{3,80}?)\s*[–~-]\s*(\d{1,5}(?:[.,]\d{2})?)\s*(?:lei|ron|€)/i);
    if (m) add(m[1].replace(/[-–]+$/,'').trim(), m[2]+' LEI','text_lines','name – price',82);
    const m2 = line.match(/^([A-ZĂÂÎȘȚa-zăâîșț][^~]{3,80}?)\s*~\s*(\d{1,5})\s*lei/i);
    if (m2) add(m2[1].trim(), m2[2]+' LEI','text_lines','name ~ price',80);
  });

  // Consecutive lines (78%)
  if (services.length < 5) {
    for (let i = 0; i < lines.length-1; i++) {
      const pm = lines[i+1].match(/^(\d{1,5}(?:[.,]\d{2})?)\s*(?:Lei|RON|€)/i);
      if (pm && isValidName(lines[i])) add(lines[i].replace(/[:\-–]+$/,'').trim(), pm[1]+' LEI','consecutive','consecutive lines',78);
    }
  }

  return {
    type: 'services',
    items: services.slice(0,60),
    confidence: services.length>10?90:services.length>3?70:services.length>0?50:0,
    source: ['json_ld','html_table','html_list','text_lines'],
    warnings: [], durationMs: 0,
  };
}

module.exports = { extractServices };
