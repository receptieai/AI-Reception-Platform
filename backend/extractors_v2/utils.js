'use strict';

function field(value, source, confidence, method, page = 'unknown') {
  return { value: value || null, source, confidence: value ? confidence : 0, method, page };
}

function bestField(...candidates) {
  return candidates.filter(c => c && c.value).sort((a, b) => b.confidence - a.confidence)[0]
    || field(null, 'not_found', 0, 'no strategy succeeded');
}

function extractJsonLd(html) {
  const items = [];
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const arr = parsed['@graph'] || (Array.isArray(parsed) ? parsed : [parsed]);
      items.push(...arr);
    } catch (e) {}
  }
  return items;
}

function normalizePhone(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/[\s.\-()\u00A0]/g, '');
  if (cleaned.length < 9 || cleaned.length > 15) return null;
  if (cleaned.startsWith('+40') && cleaned.length >= 12) {
    const d = cleaned.substring(3);
    return '+40 ' + d.substring(0,3) + ' ' + d.substring(3,6) + ' ' + d.substring(6);
  }
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    return cleaned.substring(0,4) + ' ' + cleaned.substring(4,7) + ' ' + cleaned.substring(7);
  }
  return cleaned;
}

function isValidEmail(email) {
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length < 100
    && !email.endsWith('.png') && !email.endsWith('.jpg');
}

function cleanUrl(url) {
  return url.replace(/&amp;/g, '&').split('?')[0].split('#')[0].replace(/\/$/, '');
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function deduplicateAndScore(doctors) {
  const seen = new Map();
  doctors.forEach(doc => {
    const key = doc.name.toLowerCase().replace(/dr\.?\s*/i,'').replace(/\s+/g,' ').trim();
    if (!seen.has(key) || seen.get(key).confidence < doc.confidence) {
      seen.set(key, doc);
    } else {
      const ex = seen.get(key);
      ex.source = [...new Set([...ex.source, ...doc.source])];
      ex.specialties = [...new Set([...ex.specialties, ...doc.specialties])];
      ex.confidence = Math.min(99, ex.confidence + 5);
    }
  });
  return Array.from(seen.values()).sort((a,b) => b.confidence - a.confidence);
}

const RO_CITIES = [
  'București','Cluj-Napoca','Timișoara','Iași','Constanța','Craiova',
  'Brașov','Galați','Ploiești','Oradea','Brăila','Bacău','Arad',
  'Pitești','Sibiu','Târgu Mureș','Baia Mare','Buzău','Satu Mare',
  'Focșani','Suceava','Piatra Neamț','Deva','Alba Iulia','Reșița',
  'Zalău','Sfântu Gheorghe','Bistrița','Râmnicu Vâlcea','Târgoviște',
  'Giurgiu','Alexandria','Slobozia','Tulcea','Vaslui','Câmpina',
];

module.exports = { field, bestField, extractJsonLd, normalizePhone, isValidEmail, cleanUrl, stripHtml, deduplicateAndScore, RO_CITIES };
