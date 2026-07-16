'use strict';
const { field, bestField, extractJsonLd, normalizePhone, isValidEmail, RO_CITIES } = require('./utils');

function extractPhone(html, page='homepage') {
  const candidates = [];
  const jsonLd = extractJsonLd(html);
  jsonLd.forEach(item => {
    if (item.telephone) { const p = normalizePhone(item.telephone); if (p) candidates.push(field(p,'json_ld',100,'JSON-LD telephone',page)); }
  });
  const telLinks = [...html.matchAll(/href=["']tel:([+\d\s\-.()\u00A0]{9,20})["']/gi)];
  telLinks.forEach(m => { const p = normalizePhone(m[1]); if (p) candidates.push(field(p,'tel_link',99,'tel: link',page)); });
  const textOnly = html.replace(/<[^>]+>/g,' ');
  const roPatterns = [/\b(07\d{2}[\s.\-]?\d{3}[\s.\-]?\d{3})\b/g, /\b(0[23]\d{2}[\s.\-]?\d{3}[\s.\-]?\d{3})\b/g, /\b(\+40[\s.\-]?\d{3}[\s.\-]?\d{3}[\s.\-]?\d{3})\b/g];
  for (const pat of roPatterns) { const ms = [...textOnly.matchAll(pat)]; if (ms.length > 0) { const p = normalizePhone(ms[0][1]); if (p) { candidates.push(field(p,'regex',75,'phone regex',page)); break; } } }
  return bestField(...candidates);
}

function extractEmail(html, page='homepage') {
  const candidates = [];
  const jsonLd = extractJsonLd(html);
  jsonLd.forEach(item => { if (item.email && isValidEmail(item.email)) candidates.push(field(item.email.toLowerCase(),'json_ld',100,'JSON-LD email',page)); });
  const mailtoLinks = [...html.matchAll(/href=["']mailto:([^"'\s?&]+)["']/gi)];
  mailtoLinks.forEach(m => { if (isValidEmail(m[1])) candidates.push(field(m[1].toLowerCase(),'mailto_link',99,'mailto: link',page)); });
  const labelMatch = html.match(/(?:Email|E-mail)\s*:?\s*<?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>?/i);
  if (labelMatch && isValidEmail(labelMatch[1])) candidates.push(field(labelMatch[1].toLowerCase(),'label_text',85,'Email: label',page));
  const textOnly = html.replace(/<[^>]+>/g,' ');
  const emails = [...textOnly.matchAll(/\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g)].map(m=>m[1].toLowerCase()).filter(e=>isValidEmail(e)&&!e.includes('example'));
  if (emails[0]) candidates.push(field(emails[0],'regex',70,'email regex',page));
  return bestField(...candidates);
}

function extractName(html, page='homepage') {
  const candidates = [];
  const jsonLd = extractJsonLd(html);
  jsonLd.forEach(item => {
    const types = [item['@type']].flat().filter(Boolean);
    const isLocal = types.some(t => ['LocalBusiness','MedicalBusiness','Dentist','Physician','VeterinaryCare','BeautySalon','Organization'].includes(t));
    if ((isLocal||item.telephone) && item.name && item.name.length > 2) candidates.push(field(item.name,'json_ld',100,'JSON-LD name',page));
  });
  const ogName = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  if (ogName) candidates.push(field(ogName[1].trim(),'og_site_name',85,'og:site_name',page));
  const titleMatch = html.match(/<title[^>]*>([^<|–\-]{3,80})/i);
  if (titleMatch) candidates.push(field(titleMatch[1].trim(),'title_tag',70,'title tag',page));
  return bestField(...candidates);
}

function extractCity(html, page='homepage') {
  const candidates = [];
  const jsonLd = extractJsonLd(html);
  jsonLd.forEach(item => { const city = item.address?.addressLocality||item.addressLocality; if (city) candidates.push(field(city,'json_ld',95,'addressLocality',page)); });
  const textOnly = html.replace(/<[^>]+>/g,' ');
  for (const city of RO_CITIES) { if (textOnly.includes(city)) { candidates.push(field(city,'city_list',60,'city in text',page)); break; } }
  return bestField(...candidates);
}

function extractAddress(html, page='homepage') {
  const candidates = [];
  const jsonLd = extractJsonLd(html);
  jsonLd.forEach(item => { const s = item.address?.streetAddress; if (s) { const c = item.address?.addressLocality; candidates.push(field(c?`${s}, ${c}`:s,'json_ld',95,'streetAddress',page)); } });
  const textOnly = html.replace(/<[^>]+>/g,' ');
  const addrMatch = textOnly.match(/(?:Str(?:ada)?|Bd(?:ul)?|Calea|Șos(?:eaua)?|Aleea)\s+[A-ZĂÂÎȘȚa-zăâîșț0-9\s\-\.]+(?:nr\.?\s*\d+[A-Za-z]?)/i) || textOnly.match(/(?:STR|BD|CAL|SOS)\.?\s+[A-ZĂÂÎȘȚ\s]+,?\s*NR\.?\s*\d+[A-Za-z]?/i);
  if (addrMatch) candidates.push(field(addrMatch[0].trim(),'regex',75,'address regex',page));
  const labelMatch = textOnly.match(/Adres[aă]\s*:?\s*([A-ZĂÂÎȘȚa-zăâîșț0-9\s\-\.,]+\d+[A-Za-z]?)/i);
  if (labelMatch) candidates.push(field(labelMatch[1].trim().substring(0,150),'label_text',70,'Adresa: label',page));
  return bestField(...candidates);
}

function extractContact(html, page='homepage') {
  return { phone: extractPhone(html,page), email: extractEmail(html,page), name: extractName(html,page), city: extractCity(html,page), address: extractAddress(html,page), _sources:['json_ld','regex','label'] };
}

module.exports = { extractContact, extractPhone, extractEmail, extractName, extractCity, extractAddress };
