'use strict';
const { field, bestField, extractJsonLd, normalizePhone, isValidEmail, decodeCfEmail, RO_CITIES } = require('./utils');
const { voteFields } = require('./voting');

// ── ALL PHONES with labels (reception / emergency / other) ──────────
// The old extractPhone returned only the single best candidate. Sites
// with a reception number AND an emergency line lose the second number.
// This extracts every distinct phone and associates it with the label
// found nearby ("recepție", "urgențe", "gardi", "whatsapp", etc.).
function extractAllPhones(html, page = 'homepage') {
  const phones = []; // { value, label, source, confidence }
  const seen = new Set();

  const add = (raw, label, source, confidence) => {
    const p = normalizePhone(raw);
    if (!p) return;
    // Canonical key: strip non-digits, then normalise the country/leading 0
    // so +40 722..., 0040722..., 0722... and 722... all collapse to one entry.
    let d = p.replace(/\D/g, '');
    if (d.startsWith('00')) d = d.slice(2);            // 0040722... -> 40722...
    if (d.startsWith('40') && d.length === 11) d = d.slice(2); // 40 + 9-digit national
    if (d.startsWith('0')) d = d.slice(1);             // 0722... -> 722...
    const key = d;
    if (seen.has(key)) {
      // Merge: a REAL label (reception/emergency/whatsapp) always beats a
      // generic one (tel_link/regex), even if it arrives later.
      const existing = phones.find(x => x._key === key);
      if (existing) {
        const isReal = (l) => l === 'reception' || l === 'emergency' || l === 'whatsapp';
        if (isReal(label) && !isReal(existing.label)) existing.label = label;
        existing.confidence = Math.max(existing.confidence || 0, confidence || 0);
      }
      return;
    }
    seen.add(key);
    phones.push({ value: p, label: label || null, source, confidence, _key: key });
  };

  // 1) JSON-LD (structured, highest confidence)
  const jsonLd = extractJsonLd(html);
  jsonLd.forEach(item => {
    if (item.telephone) add(item.telephone, 'json_ld', 'json_ld', 100);
  });

  // 2) tel: links — look for labels near the link
  const telRe = /<a[^>]+href=["']tel:([+\d\s\-.()\u00A0]{9,20})["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = telRe.exec(html)) !== null) {
    const phone = m[1];
    const label = (m[2] || '').toLowerCase();
    const l = /urgen|gard|24\/?7/.test(label) ? 'emergency'
      : /recept|oficiu|office|secretariat/.test(label) ? 'reception'
      : /whatsapp|wa\b/.test(label) ? 'whatsapp'
      : null;
    add(phone, l || 'tel_link', 'tel_link', 99);
  }

  // 3) Text scan with label context (look backwards from each phone for labels)
  const textOnly = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const roPatterns = [
    /\b(03\d{2}[\s.\-]?\d{3}[\s.\-]?\d{3})\b/g,  // landline 03
    /\b(0[2]\d{2}[\s.\-]?\d{3}[\s.\-]?\d{3})\b/g, // landline 02
    /\b(0[7]\d{2}[\s.\-]?\d{3}[\s.\-]?\d{3})\b/g, // mobile 07
    /\b(\+40[\s.\-]?\d{3}[\s.\-]?\d{3}[\s.\-]?\d{3})\b/g, // +40
  ];
  for (const pat of roPatterns) {
    let pm;
    while ((pm = pat.exec(textOnly)) !== null) {
      const phone = pm[1];
      // Look for a label BOTH before and after the number — Romanian sites
      // commonly write "031 234 56 78 (recepție)" (after) or "recepție:
      // 031 234 56 78" (before). A ±60 char window around the number catches
      // both without bleeding into a neighbouring phone's label.
      const start = Math.max(0, pm.index - 60);
      const ctx = textOnly.slice(start, pm.index + phone.length + 60).toLowerCase();
      const label = /urgen|gard|24\/?7|emergency/.test(ctx) ? 'emergency'
        : /recept|oficiu|office|secretariat/.test(ctx) ? 'reception'
        : /whatsapp|wa\b/.test(ctx) ? 'whatsapp'
        : null;
      add(phone, label || 'regex', 'regex', label ? 90 : 75);
    }
  }

  // 4) Sort: emergency > reception > other
  const order = { emergency: 0, reception: 1, whatsapp: 2 };
  phones.sort((a, b) => (order[a.label] ?? 3) - (order[b.label] ?? 3));

  // Derive single-purpose fields for backward compatibility.
  // reception must NOT be the emergency line: prefer an explicit 'reception'
  // label, else the first NON-emergency number (the general/reception line).
  const emergency = phones.find(p => p.label === 'emergency');
  const reception = phones.find(p => p.label === 'reception')
    || phones.find(p => p.label !== 'emergency')
    || phones[0];
  const primary = reception || emergency || phones[0];

  return {
    all: phones,
    reception: reception ? reception.value : null,
    emergency: emergency ? emergency.value : null,
    primary: primary ? primary.value : null,
  };
}

function extractPhone(html, page='homepage') {
  const multi = extractAllPhones(html, page);
  if (multi.primary) {
    return field(multi.primary, 'multi_phone', 95, 'all phones', page);
  }
  // fallback to old single-phone logic
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
  return voteFields(candidates);
}

function extractEmail(html, page='homepage') {
  const candidates = [];
  const jsonLd = extractJsonLd(html);
  jsonLd.forEach(item => { if (item.email && isValidEmail(item.email)) candidates.push(field(item.email.toLowerCase(),'json_ld',100,'JSON-LD email',page)); });
  const mailtoLinks = [...html.matchAll(/href=["']mailto:([^"'\s?&]+)["']/gi)];
  mailtoLinks.forEach(m => { if (isValidEmail(m[1])) candidates.push(field(m[1].toLowerCase(),'mailto_link',99,'mailto: link',page)); });
  const labelMatch = html.match(/(?:Email|E-mail)\s*:?\s*<?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>?/i);
  if (labelMatch && isValidEmail(labelMatch[1])) candidates.push(field(labelMatch[1].toLowerCase(),'label_text',85,'Email: label',page));

  // Cloudflare Email Protection — email is obfuscated in static HTML and
  // only revealed by a browser. Decode every data-cfemail blob; this is the
  // most common reason dental/vet/beauty sites show "email not found".
  const cfMatches = [...html.matchAll(/data-cfemail=["']([0-9a-fA-F]{4,128})["']/gi)];
  for (const m of cfMatches) {
    const decoded = decodeCfEmail(m[1]);
    if (decoded && isValidEmail(decoded)) {
      candidates.push(field(decoded.toLowerCase(), 'cf_email', 92, 'Cloudflare cfemail decode', page));
    }
  }
  const textOnly = html.replace(/<[^>]+>/g,' ');
  const emails = [...textOnly.matchAll(/\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g)].map(m=>m[1].toLowerCase()).filter(e=>isValidEmail(e)&&!e.includes('example'));
  if (emails[0]) candidates.push(field(emails[0],'regex',70,'email regex',page));
  return voteFields(candidates);
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

function isValidAddress(addr) {
  if (!addr || addr.length < 5 || addr.length > 200) return false;
  // Must contain street indicator OR number
  if (!/(?:str|bd|calea|șos|aleea|nr|strada|bulevardul|\d{1,4})/i.test(addr)) return false;
  // Must not be a review/testimonial
  if (/(?:sunat|recomandat|multumesc|excellent|bun[aă]|stăpân|câine|pisic)/i.test(addr)) return false;
  return true;
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
  const best = bestField(...candidates);
  if (best && best.value && !isValidAddress(best.value)) return field(null,'invalid',0,'invalid address',page);
  return best;
}

function extractContact(html, page='homepage') {
  return { phone: extractPhone(html,page), email: extractEmail(html,page), name: extractName(html,page), city: extractCity(html,page), address: extractAddress(html,page), _sources:['json_ld','regex','label'] };
}

module.exports = { extractContact, extractPhone, extractEmail, extractName, extractCity, extractAddress, extractAllPhones };
