/**
 * RecepAI — Deterministic Extractors v2.0
 * 
 * Fiecare câmp returnează:
 * {
 *   value: "datele găsite",
 *   source: "json_ld | tel_link | mailto | regex | html_direct | not_found",
 *   confidence: 0-100,
 *   method: "descriere metodă",
 *   page: "pagina unde s-a găsit"
 * }
 * 
 * Principiu: multiple strategii per câmp, cea mai sigură câștigă.
 * Claude nu caută date — Claude structurează și completează.
 */

'use strict';

// ── HELPER: Field Result ──────────────────────
function field(value, source, confidence, method, page = 'unknown') {
  return { value: value || null, source, confidence: value ? confidence : 0, method, page };
}

function bestField(...candidates) {
  return candidates
    .filter(c => c.value)
    .sort((a, b) => b.confidence - a.confidence)[0]
    || field(null, 'not_found', 0, 'no strategy succeeded');
}

// ══════════════════════════════════════════════
// PHONE EXTRACTOR — 5 strategii
// ══════════════════════════════════════════════
function extractPhone(html, page = 'homepage') {
  const candidates = [];

  // Strategie 1: JSON-LD telephone (100% sigur)
  const jsonLdPhone = html.match(/"telephone"\s*:\s*"([+\d\s\-().]{9,20})"/i);
  if (jsonLdPhone) {
    candidates.push(field(normalizePhone(jsonLdPhone[1]), 'json_ld', 100, 'JSON-LD @telephone', page));
  }

  // Strategie 2: tel: link (99% sigur)
  const telLinks = [...html.matchAll(/href=["']tel:([+\d\s\-().]{9,20})["']/gi)];
  telLinks.forEach(m => {
    const phone = normalizePhone(m[1]);
    if (phone) candidates.push(field(phone, 'tel_link', 99, 'href="tel:" link', page));
  });

  // Strategie 3: schema.org contactPoint
  const schemaPhone = html.match(/"contactPoint"[\s\S]{0,200}"telephone"\s*:\s*"([+\d\s\-().]{9,20})"/i);
  if (schemaPhone) {
    candidates.push(field(normalizePhone(schemaPhone[1]), 'schema_org', 95, 'schema.org contactPoint', page));
  }

  // Strategie 4: regex pattern românesc din text
  const textOnly = html.replace(/<[^>]+>/g, ' ');
  const roPhonePatterns = [
    /\b(07\d{2}[\s.\-]?\d{3}[\s.\-]?\d{3})\b/g,
    /\b(0[23]\d{2}[\s.\-]?\d{3}[\s.\-]?\d{3})\b/g,
    /\b(\+40[\s.\-]?\d{3}[\s.\-]?\d{3}[\s.\-]?\d{3})\b/g,
  ];
  roPhonePatterns.forEach(p => {
    const m = textOnly.match(p);
    if (m) candidates.push(field(normalizePhone(m[0]), 'regex', 75, 'Romanian phone pattern in text', page));
  });

  // Strategie 5: OpenGraph / meta tags
  const metaPhone = html.match(/<meta[^>]+(?:phone|telephone)[^>]+content=["']([+\d\s\-().]{9,20})["']/i);
  if (metaPhone) {
    candidates.push(field(normalizePhone(metaPhone[1]), 'meta_tag', 85, 'meta phone tag', page));
  }

  return bestField(...candidates);
}

// ══════════════════════════════════════════════
// EMAIL EXTRACTOR — 4 strategii
// ══════════════════════════════════════════════
function extractEmail(html, page = 'homepage') {
  const candidates = [];

  // Strategie 1: JSON-LD email (100%)
  const jsonLdEmail = html.match(/"email"\s*:\s*"([^"@\s]+@[^"@\s]+\.[^"@\s]{2,})"/i);
  if (jsonLdEmail && isValidEmail(jsonLdEmail[1])) {
    candidates.push(field(jsonLdEmail[1].toLowerCase(), 'json_ld', 100, 'JSON-LD @email', page));
  }

  // Strategie 2: mailto: link (99%)
  const mailtoLinks = [...html.matchAll(/href=["']mailto:([^"'\s?]+)["']/gi)];
  mailtoLinks.forEach(m => {
    if (isValidEmail(m[1])) {
      candidates.push(field(m[1].toLowerCase(), 'mailto_link', 99, 'href="mailto:" link', page));
    }
  });

  // Strategie 3: "Email:" label urmat de adresă (85%)
  const labelEmail = html.match(/(?:Email|E-mail|Contact)\s*:?\s*<?([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})>?/i);
  if (labelEmail && isValidEmail(labelEmail[1])) {
    candidates.push(field(labelEmail[1].toLowerCase(), 'label_text', 85, 'Email: label in text', page));
  }

  // Strategie 4: regex email în text (70%)
  const textOnly = html.replace(/<[^>]+>/g, ' ');
  const emailRegex = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;
  const emails = [...textOnly.matchAll(emailRegex)]
    .map(m => m[1].toLowerCase())
    .filter(e => isValidEmail(e) && !e.includes('example') && !e.includes('your@') && !e.endsWith('.png') && !e.endsWith('.jpg'));
  if (emails[0]) {
    candidates.push(field(emails[0], 'regex', 70, 'Email regex in text', page));
  }

  return bestField(...candidates);
}

// ══════════════════════════════════════════════
// SOCIAL MEDIA EXTRACTOR — cu surse multiple
// ══════════════════════════════════════════════
function extractSocial(html, page = 'homepage') {
  const result = {
    facebook: field(null, 'not_found', 0, 'no facebook found'),
    instagram: field(null, 'not_found', 0, 'no instagram found'),
    tiktok: field(null, 'not_found', 0, 'no tiktok found'),
    youtube: field(null, 'not_found', 0, 'no youtube found'),
    whatsapp: field(null, 'not_found', 0, 'no whatsapp found'),
    linkedin: field(null, 'not_found', 0, 'no linkedin found'),
  };

  // Strategie 1: JSON-LD sameAs (100%)
  const sameAsMatch = html.match(/"sameAs"\s*:\s*\[([^\]]+)\]/i);
  if (sameAsMatch) {
    const links = sameAsMatch[1].match(/["'](https?:\/\/[^"']+)["']/g) || [];
    links.forEach(l => {
      const url = l.replace(/["']/g, '');
      if (/facebook\.com/i.test(url) && !result.facebook.value) {
        result.facebook = field(cleanUrl(url), 'json_ld_sameAs', 100, 'JSON-LD sameAs Facebook', page);
      }
      if (/instagram\.com/i.test(url) && !result.instagram.value) {
        result.instagram = field(cleanUrl(url), 'json_ld_sameAs', 100, 'JSON-LD sameAs Instagram', page);
      }
      if (/tiktok\.com/i.test(url) && !result.tiktok.value) {
        result.tiktok = field(cleanUrl(url), 'json_ld_sameAs', 100, 'JSON-LD sameAs TikTok', page);
      }
      if (/youtube\.com/i.test(url) && !result.youtube.value) {
        result.youtube = field(cleanUrl(url), 'json_ld_sameAs', 100, 'JSON-LD sameAs YouTube', page);
      }
      if (/linkedin\.com/i.test(url) && !result.linkedin.value) {
        result.linkedin = field(cleanUrl(url), 'json_ld_sameAs', 100, 'JSON-LD sameAs LinkedIn', page);
      }
    });
  }

  // Strategie 2: href direct în HTML (95%)
  const fbMatch = html.match(/href=["'](https?:\/\/(?:www\.|m\.|l\.)?facebook\.com\/[^"'\s?#/][^"'\s?#]*)["']/i);
  if (fbMatch && !fbMatch[1].includes('sharer') && !fbMatch[1].includes('share.php') && !result.facebook.value) {
    result.facebook = field(cleanUrl(fbMatch[1]), 'html_href', 95, 'Facebook href in HTML', page);
  }

  const igMatch = html.match(/href=["'](https?:\/\/(?:www\.)?instagram\.com\/[^"'\s?#/][^"'\s?#]*)["']/i);
  if (igMatch && !result.instagram.value) {
    result.instagram = field(cleanUrl(igMatch[1]), 'html_href', 95, 'Instagram href in HTML', page);
  }

  const ttMatch = html.match(/href=["'](https?:\/\/(?:www\.|vm\.)?tiktok\.com\/[^"'\s?#]+)["']/i);
  if (ttMatch && !result.tiktok.value) {
    result.tiktok = field(cleanUrl(ttMatch[1]), 'html_href', 95, 'TikTok href in HTML', page);
  }

  const ytMatch = html.match(/href=["'](https?:\/\/(?:www\.)?youtube\.com\/(?:channel|c|@|user)\/[^"'\s?#]+)["']/i);
  if (ytMatch && !result.youtube.value) {
    result.youtube = field(cleanUrl(ytMatch[1]), 'html_href', 95, 'YouTube href in HTML', page);
  }

  const waMatch = html.match(/href=["'](https?:\/\/(?:wa\.me|api\.whatsapp\.com\/send)[^"'\s]*)["']/i);
  if (waMatch && !result.whatsapp.value) {
    result.whatsapp = field(cleanUrl(waMatch[1]), 'html_href', 95, 'WhatsApp href in HTML', page);
  }

  const liMatch = html.match(/href=["'](https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[^"'\s?#]+)["']/i);
  if (liMatch && !result.linkedin.value) {
    result.linkedin = field(cleanUrl(liMatch[1]), 'html_href', 95, 'LinkedIn href in HTML', page);
  }

  // Strategie 3: OpenGraph (80%)
  const ogUrl = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
  if (ogUrl) {
    const url = ogUrl[1];
    if (/facebook\.com/i.test(url) && !result.facebook.value) {
      result.facebook = field(cleanUrl(url), 'og_url', 80, 'OpenGraph URL is Facebook', page);
    }
    if (/instagram\.com/i.test(url) && !result.instagram.value) {
      result.instagram = field(cleanUrl(url), 'og_url', 80, 'OpenGraph URL is Instagram', page);
    }
  }

  return result;
}

// ══════════════════════════════════════════════
// HOURS EXTRACTOR — 4 strategii
// ══════════════════════════════════════════════
function extractHours(html, page = 'homepage') {
  const candidates = [];

  // Strategie 1: JSON-LD openingHours (95%)
  const jsonLdHours = html.match(/"openingHours"\s*:\s*"([^"]+)"/i);
  if (jsonLdHours) {
    candidates.push(field(jsonLdHours[1], 'json_ld', 95, 'JSON-LD openingHours', page));
  }

  // Strategie 2: openingHoursSpecification (90%)
  const specMatch = html.match(/"openingHoursSpecification"\s*:\s*\[([^\]]+)\]/i);
  if (specMatch) {
    try {
      const specs = JSON.parse('[' + specMatch[1] + ']');
      const hoursText = specs.map(s => `${[s.dayOfWeek].flat().join(', ')}: ${s.opens}-${s.closes}`).join(', ');
      if (hoursText) candidates.push(field(hoursText, 'json_ld_spec', 90, 'JSON-LD openingHoursSpecification', page));
    } catch (e) { }
  }

  // Strategie 3: pattern text (Luni-Vineri: 09:00-18:00) (75%)
  const textOnly = html.replace(/<[^>]+>/g, ' ');
  const days = 'Luni|Marți|Miercuri|Joi|Vineri|Sâmbătă|Duminică|Mon|Tue|Wed|Thu|Fri|Sat|Sun';
  const rangePattern = new RegExp(`((?:${days})\\s*[-–]\\s*(?:${days})?\\s*:?\\s*\\d{1,2}[:.]\\d{2}\\s*[-–]\\s*\\d{1,2}[:.]\\d{2})`, 'gi');
  const ranges = [...textOnly.matchAll(rangePattern)].map(m => m[1].trim());
  if (ranges.length > 0) {
    candidates.push(field([...new Set(ranges)].slice(0, 4).join(' | '), 'regex', 75, 'Day-hours pattern in text', page));
  }

  // Strategie 4: "Program:" label (70%)
  const programLabel = textOnly.match(/(?:Program|Orar|Schedule)\s*:?\s*((?:Luni|Mon|Lun)[\s\S]{10,100}?(?:\d{2}:\d{2}))/i);
  if (programLabel) {
    candidates.push(field(programLabel[1].trim().substring(0, 200), 'label_text', 70, 'Program: label in text', page));
  }

  return bestField(...candidates);
}

// ══════════════════════════════════════════════
// ADDRESS EXTRACTOR — 4 strategii
// ══════════════════════════════════════════════
function extractAddress(html, page = 'homepage') {
  const candidates = [];

  // Strategie 1: JSON-LD address (95%)
  const jsonLdStreet = html.match(/"streetAddress"\s*:\s*"([^"]+)"/i);
  const jsonLdCity = html.match(/"addressLocality"\s*:\s*"([^"]+)"/i);
  if (jsonLdStreet) {
    const addr = jsonLdCity ? `${jsonLdStreet[1]}, ${jsonLdCity[1]}` : jsonLdStreet[1];
    candidates.push(field(addr, 'json_ld', 95, 'JSON-LD streetAddress', page));
  }

  // Strategie 2: schema.org PostalAddress (90%)
  const postalMatch = html.match(/"PostalAddress"[\s\S]{0,500}"streetAddress"\s*:\s*"([^"]+)"/i);
  if (postalMatch && !jsonLdStreet) {
    candidates.push(field(postalMatch[1], 'schema_org', 90, 'schema.org PostalAddress', page));
  }

  // Strategie 3: regex adresă românească (75%)
  const textOnly = html.replace(/<[^>]+>/g, ' ');
  const addrPatterns = [
    /(?:Str(?:ada)?|Bd(?:ul)?|Bulevardul|Calea|Șos(?:eaua)?|Aleea|Piața)\s+[A-ZĂÂÎȘȚa-zăâîșț0-9\s\-\.]+(?:nr\.?\s*\d+[A-Za-z]?)/i,
    /(?:STR|BD|CAL|SOS|BDUL)\.?\s+[A-ZĂÂÎȘȚ\s]+,?\s*NR\.?\s*\d+[A-Za-z]?/i,
  ];
  for (const p of addrPatterns) {
    const m = textOnly.match(p);
    if (m) { candidates.push(field(m[0].trim(), 'regex', 75, 'Romanian address pattern', page)); break; }
  }

  // Strategie 4: "Adresa:" label (70%)
  const addrLabel = textOnly.match(/(?:Adres[aă]|Address|Locație)\s*:?\s*([A-ZĂÂÎȘȚa-zăâîșț0-9\s\-\.,]+\d+[A-Za-z]?)/i);
  if (addrLabel) {
    candidates.push(field(addrLabel[1].trim().substring(0, 150), 'label_text', 70, 'Adresa: label in text', page));
  }

  return bestField(...candidates);
}

// ══════════════════════════════════════════════
// CITY EXTRACTOR — 3 strategii
// ══════════════════════════════════════════════
function extractCity(html, page = 'homepage') {
  const candidates = [];

  // Strategie 1: JSON-LD addressLocality (95%)
  const jsonLdCity = html.match(/"addressLocality"\s*:\s*"([^"]+)"/i);
  if (jsonLdCity) {
    candidates.push(field(jsonLdCity[1], 'json_ld', 95, 'JSON-LD addressLocality', page));
  }

  // Strategie 2: addressRegion / schema.org (85%)
  const regionMatch = html.match(/"addressRegion"\s*:\s*"([^"]+)"/i);
  if (regionMatch && !jsonLdCity) {
    candidates.push(field(regionMatch[1], 'schema_org', 85, 'schema.org addressRegion', page));
  }

  // Strategie 3: orașe românești mari în text (60%)
  const cities = ['București', 'Cluj-Napoca', 'Timișoara', 'Iași', 'Constanța', 'Craiova', 'Brașov', 'Galați', 'Ploiești', 'Oradea', 'Brăila', 'Bacău', 'Arad', 'Pitești', 'Sibiu', 'Târgu Mureș', 'Baia Mare', 'Buzău', 'Satu Mare', 'Focșani', 'Suceava', 'Drobeta-Turnu Severin', 'Piatra Neamț', 'Deva', 'Alba Iulia'];
  const textOnly = html.replace(/<[^>]+>/g, ' ');
  for (const city of cities) {
    if (textOnly.includes(city)) {
      candidates.push(field(city, 'city_list', 60, 'Romanian city name in text', page));
      break;
    }
  }

  return bestField(...candidates);
}

// ══════════════════════════════════════════════
// NAME EXTRACTOR — 4 strategii
// ══════════════════════════════════════════════
function extractName(html, page = 'homepage') {
  const candidates = [];

  // Strategie 1: JSON-LD name (100%)
  const jsonLdName = html.match(/"name"\s*:\s*"([^"]{3,100})"/i);
  if (jsonLdName && !jsonLdName[1].includes('{') && !jsonLdName[1].includes('@')) {
    candidates.push(field(jsonLdName[1], 'json_ld', 100, 'JSON-LD @name', page));
  }

  // Strategie 2: OpenGraph site_name (85%)
  const ogName = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  if (ogName) {
    candidates.push(field(ogName[1], 'og_site_name', 85, 'OpenGraph og:site_name', page));
  }

  // Strategie 3: title tag (70%)
  const titleMatch = html.match(/<title[^>]*>([^<|–\-]{3,80})/i);
  if (titleMatch) {
    const title = titleMatch[1].trim();
    candidates.push(field(title, 'title_tag', 70, 'HTML title tag', page));
  }

  // Strategie 4: h1 tag (65%)
  const h1Match = html.match(/<h1[^>]*>([^<]{3,80})<\/h1>/i);
  if (h1Match) {
    candidates.push(field(h1Match[1].replace(/<[^>]+>/g, '').trim(), 'h1_tag', 65, 'H1 heading', page));
  }

  return bestField(...candidates);
}

// ══════════════════════════════════════════════
// PRICE EXTRACTOR — servicii cu prețuri
// ══════════════════════════════════════════════
function extractServicesWithPrices(html, page = 'homepage') {
  const services = [];
  const seen = new Set();

  function addService(name, price, source, method, confidence) {
    const cleanName = name.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (cleanName.length < 3 || cleanName.length > 120) return;
    if (!/[a-zA-ZăâîșțĂÂÎȘȚ]{3,}/.test(cleanName)) return;
    if (/^[\\/\d\s\-\+\.]+$/.test(cleanName)) return;
    if (seen.has(cleanName.toLowerCase())) return;
    seen.add(cleanName.toLowerCase());

    const cleanPrice = price ? price.replace(/\s+/g, ' ').trim() : null;
    services.push({
      name: cleanName,
      price: cleanPrice,
      source,
      method,
      confidence,
      page,
    });
  }

  const priceRegex = /(\d{1,5}(?:[.,]\d{2}?)?)\s*(?:lei|ron|€|eur|\$)/i;

  // Strategie 1: JSON-LD hasOfferCatalog (95%)
  const offerMatches = html.matchAll(/"(?:Offer|Service)"\s*[\s\S]{0,300}?"name"\s*:\s*"([^"]+)"[\s\S]{0,200}?"price"\s*:\s*"?(\d+(?:[.,]\d{2})?)"?/gi);
  for (const m of offerMatches) {
    addService(m[1], m[2] + ' LEI', 'json_ld', 'JSON-LD Offer', 95);
  }

  // Strategie 2: list items cu preț (85%)
  const listItems = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)];
  listItems.forEach(m => {
    const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const priceMatch = text.match(priceRegex);
    if (priceMatch) {
      const name = text.replace(priceMatch[0], '').replace(/[-–:.\s]+$/, '').trim();
      addService(name, priceMatch[0].toUpperCase(), 'html_list', 'li element with price', 85);
    }
  });

  // Strategie 3: table rows cu preț (85%)
  const tableRows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  tableRows.forEach(m => {
    const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => c[1].replace(/<[^>]+>/g, '').trim());
    if (cells.length >= 2) {
      const priceCell = cells.find(c => priceRegex.test(c));
      const nameCell = cells.find(c => !priceRegex.test(c) && c.length > 3);
      if (priceCell && nameCell) {
        addService(nameCell, priceCell.toUpperCase(), 'html_table', 'table row', 85);
      }
    }
  });

  // Strategie 4: heading + preț pe rândul următor (80%)
  const headingPriceRegex = /<(h[2-5]|strong|b)[^>]*>([^<]{3,100})<\/\1>\s*(?:<[^>]+>)*\s*(\d{2,5})\s*(?:ron|lei|€)/gi;
  let hm;
  while ((hm = headingPriceRegex.exec(html)) !== null) {
    addService(hm[2], hm[3] + ' LEI', 'html_heading', 'heading followed by price', 80);
  }

  // Strategie 5: div/p cu pattern "Serviciu ... 250 Lei" (70%)
  if (services.length < 5) {
    const chunks = html.replace(/<script[\s\S]*?<\/script>/gi, '').split(/<(?:p|div|br)[^>]*>/i);
    chunks.forEach(chunk => {
      const text = chunk.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const m = text.match(/^([A-ZĂÂÎȘȚa-zăâîșț][a-zA-ZăâîșțĂÂÎȘȚ\s\-,]{3,80}?)\s+(\d{2,5})\s*(?:RON|LEI|lei|ron)\b/);
      if (m) addService(m[1], m[2] + ' LEI', 'regex', 'inline price pattern', 70);
    });
  }

  // Strategie 6: text vizibil Playwright — nume pe rand, pret pe randul urmator
  if (services.length < 5) {
    const textContent = html.replace(/<[^>]+>/g, '\n').replace(/\n{3,}/g, '\n\n');
    const lines = textContent.split('\n').map(l => l.trim()).filter(l => l.length > 1);
    for (let i = 0; i < lines.length - 1; i++) {
      const nextLine = lines[i + 1] || '';
      const priceMatch = nextLine.match(/^(\d{1,5}(?:[.,]\d{2})?)\s*(?:Lei|RON|€|EUR)/i);
      if (priceMatch) {
        const name = lines[i].replace(/[:\-–]+$/, '').trim();
        if (name.length >= 3 && name.length <= 120 && /[a-zA-ZăâîșțĂÂÎȘȚ]{3,}/.test(name)) {
          addService(name, priceMatch[0].toUpperCase(), 'text_lines', 'name+price on consecutive lines', 80);
        }
      }
    }
  }

  // Strategie 7: Format "serviciu\nvariant pret / variant pret" (salon style)
  if (services.length < 5) {
    const textContent = html.replace(/<[^>]+>/g, '\n').replace(/\n{3,}/g, '\n\n');
    const lines = textContent.split('\n').map(l => l.trim()).filter(l => l.length > 1);
    for (let i = 0; i < lines.length - 1; i++) {
      const currentLine = lines[i];
      const nextLine = lines[i + 1] || '';
      // Detectează "scurt 50 / mediu 55 / lung 60" pattern
      if (/\w+\s+\d+\s*\/\s*\w+\s+\d+/.test(nextLine)) {
        const parts = nextLine.split('/').map(p => p.trim());
        parts.forEach(part => {
          const m = part.match(/^([a-zA-ZăâîșțĂÂÎȘȚ\s]+?)\s+(\d{1,5})\s*(?:lei|ron)?$/i);
          if (m) {
            const name = currentLine + ' ' + m[1].trim();
            addService(name, m[2] + ' LEI', 'text_variant', 'service+variant/price pattern', 75);
          }
        });
      }
    }
  }

  return services.slice(0, 60);
}

// ══════════════════════════════════════════════
// JSON-LD FULL EXTRACTOR
// ══════════════════════════════════════════════
function extractJsonLd(html) {
  const result = { raw: [], businessItems: [] };
  const jsonLdRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = jsonLdRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const items = parsed['@graph'] || (Array.isArray(parsed) ? parsed : [parsed]);
      result.raw.push(...items);
      items.forEach(item => {
        const types = [item['@type']].flat().filter(Boolean);
        const isLocal = types.some(t => ['LocalBusiness','MedicalBusiness','Dentist','Physician','VeterinaryCare','BeautySalon','HealthAndBeautyBusiness','AutoRepair','MedicalClinic','Hospital','Organization','Store','Restaurant'].includes(t));
        if (isLocal || item.telephone || item.address) {
          result.businessItems.push(item);
        }
      });
    } catch (e) { }
  }
  return result;
}

// ══════════════════════════════════════════════
// META / OPENGRAPH EXTRACTOR
// ══════════════════════════════════════════════
function extractMeta(html) {
  const result = {};
  const props = ['title', 'description', 'image', 'url', 'type', 'site_name'];
  props.forEach(prop => {
    const m = html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, 'i'));
    if (m) result[prop] = m[1].trim();
  });
  const titleM = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleM) result.htmlTitle = titleM[1].trim();
  const descM = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  if (descM) result.metaDescription = descM[1].trim();
  return result;
}

// ══════════════════════════════════════════════
// MASTER EXTRACTOR — combină toate strategiile
// ══════════════════════════════════════════════
function extractAll(html, url, pageLabel = 'homepage') {
  const jsonLd = extractJsonLd(html);
  const meta = extractMeta(html);

  const phone = extractPhone(html, pageLabel);
  const email = extractEmail(html, pageLabel);
  const social = extractSocial(html, pageLabel);
  const hours = extractHours(html, pageLabel);
  const address = extractAddress(html, pageLabel);
  const city = extractCity(html, pageLabel);
  const name = extractName(html, pageLabel);
  const services = extractServicesWithPrices(html, pageLabel);

  // Confidence per câmp — cu sursă
  const fieldConfidence = {
    phone: phone.confidence,
    email: email.confidence,
    facebook: social.facebook.confidence,
    instagram: social.instagram.confidence,
    hours: hours.confidence,
    address: address.confidence,
    city: city.confidence,
    name: name.confidence,
    services: services.length > 10 ? 90 : services.length > 3 ? 70 : services.length > 0 ? 50 : 0,
    prices: services.filter(s => s.price).length > 5 ? 90 : services.filter(s => s.price).length > 0 ? 60 : 0,
  };

  // Field provenance — pentru Learning Engine și debugging
  const fieldProvenance = {
    phone: { value: phone.value, source: phone.source, confidence: phone.confidence, method: phone.method, page: phone.page },
    email: { value: email.value, source: email.source, confidence: email.confidence, method: email.method, page: email.page },
    facebook: { value: social.facebook.value, source: social.facebook.source, confidence: social.facebook.confidence, method: social.facebook.method },
    instagram: { value: social.instagram.value, source: social.instagram.source, confidence: social.instagram.confidence, method: social.instagram.method },
    hours: { value: hours.value, source: hours.source, confidence: hours.confidence, method: hours.method },
    address: { value: address.value, source: address.source, confidence: address.confidence, method: address.method },
    city: { value: city.value, source: city.source, confidence: city.confidence, method: city.method },
    name: { value: name.value, source: name.source, confidence: name.confidence, method: name.method },
  };

  return {
    // Date finale
    name: name.value,
    phone: phone.value,
    email: email.value,
    hours: hours.value,
    city: city.value,
    address: address.value,
    description: meta.metaDescription || null,
    facebook: social.facebook.value,
    instagram: social.instagram.value,
    tiktok: social.tiktok.value,
    youtube: social.youtube.value,
    whatsapp: social.whatsapp.value,
    linkedin: social.linkedin.value,
    services,

    // Metadata
    _confidence: fieldConfidence,
    _provenance: fieldProvenance,
    _sources: {
      hasJsonLd: jsonLd.businessItems.length > 0,
      jsonLdTypes: jsonLd.businessItems.map(i => i['@type']).flat().filter(Boolean),
      pageScanned: pageLabel,
    },
  };
}

// ── HELPERS ───────────────────────────────────
function normalizePhone(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/[\s.\-()]/g, '');
  if (cleaned.length < 9 || cleaned.length > 14) return null;
  if (cleaned.startsWith('+40') && cleaned.length >= 12) {
    const digits = cleaned.substring(3);
    return '+40 ' + digits.substring(0, 3) + ' ' + digits.substring(3, 6) + ' ' + digits.substring(6);
  }
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    return cleaned.substring(0, 4) + ' ' + cleaned.substring(4, 7) + ' ' + cleaned.substring(7);
  }
  return cleaned;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length < 100;
}

function cleanUrl(url) {
  return url.replace(/&amp;/g, '&').split('?')[0].split('#')[0].replace(/\/$/, '');
}

module.exports = {
  extractPhone,
  extractEmail,
  extractSocial,
  extractHours,
  extractAddress,
  extractCity,
  extractName,
  extractServicesWithPrices,
  extractJsonLd,
  extractMeta,
  extractAll,
  field,
  bestField,
};
