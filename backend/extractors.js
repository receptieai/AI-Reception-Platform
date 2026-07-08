/**
 * RecepAI — Deterministic Extractors
 * 
 * Aceste extractoare NU folosesc AI. Sunt 100% regex/parsing.
 * Claude primește doar ce NU poate fi extras determinist
 * (descrieri, FAQ, categorii de servicii).
 * 
 * Principiu: Claude structurează. Extractoarele găsesc.
 */

'use strict';

// ══════════════════════════════════════════════
// SOCIAL MEDIA EXTRACTOR — toate variantele
// ══════════════════════════════════════════════
function extractSocialMedia(html) {
  const result = {
    facebook: null, instagram: null, tiktok: null,
    youtube: null, whatsapp: null, linkedin: null,
    twitter: null, telegram: null,
  };

  // Facebook — toate domeniile posibile
  const fbPatterns = [
    /href=["'](https?:\/\/(?:www\.|m\.|l\.)?facebook\.com\/[^"'\s?#]+)["']/i,
    /href=["'](https?:\/\/fb\.me\/[^"'\s?#]+)["']/i,
    /href=["'](https?:\/\/fb\.watch\/[^"'\s?#]+)["']/i,
  ];
  for (const p of fbPatterns) {
    const m = html.match(p);
    if (m && !m[1].includes('sharer') && !m[1].includes('share.php') && !m[1].includes('/plugins/')) {
      result.facebook = cleanUrl(m[1]);
      break;
    }
  }

  // Instagram — toate variantele
  const igPatterns = [
    /href=["'](https?:\/\/(?:www\.)?instagram\.com\/[^"'\s?#/][^"'\s?#]*)["']/i,
    /href=["'](https?:\/\/instagr\.am\/[^"'\s?#]+)["']/i,
  ];
  for (const p of igPatterns) {
    const m = html.match(p);
    if (m) { result.instagram = cleanUrl(m[1]); break; }
  }

  // TikTok
  const ttMatch = html.match(/href=["'](https?:\/\/(?:www\.|vm\.)?tiktok\.com\/[^"'\s?#]+)["']/i);
  if (ttMatch) result.tiktok = cleanUrl(ttMatch[1]);

  // YouTube — channel, c, @, watch
  const ytPatterns = [
    /href=["'](https?:\/\/(?:www\.)?youtube\.com\/(?:channel|c|@|user)\/[^"'\s?#]+)["']/i,
    /href=["'](https?:\/\/youtu\.be\/[^"'\s?#]+)["']/i,
  ];
  for (const p of ytPatterns) {
    const m = html.match(p);
    if (m) { result.youtube = cleanUrl(m[1]); break; }
  }

  // WhatsApp — wa.me sau api.whatsapp.com
  const waPatterns = [
    /href=["'](https?:\/\/wa\.me\/[^"'\s?#]+)["']/i,
    /href=["'](https?:\/\/api\.whatsapp\.com\/send[^"'\s]*)["']/i,
  ];
  for (const p of waPatterns) {
    const m = html.match(p);
    if (m) { result.whatsapp = cleanUrl(m[1]); break; }
  }

  // LinkedIn
  const liMatch = html.match(/href=["'](https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[^"'\s?#]+)["']/i);
  if (liMatch) result.linkedin = cleanUrl(liMatch[1]);

  // Twitter/X
  const twPatterns = [
    /href=["'](https?:\/\/(?:www\.)?twitter\.com\/[^"'\s?#/][^"'\s?#]*)["']/i,
    /href=["'](https?:\/\/x\.com\/[^"'\s?#/][^"'\s?#]*)["']/i,
  ];
  for (const p of twPatterns) {
    const m = html.match(p);
    if (m && !m[1].includes('intent') && !m[1].includes('share')) { result.twitter = cleanUrl(m[1]); break; }
  }

  // Telegram
  const tgMatch = html.match(/href=["'](https?:\/\/t\.me\/[^"'\s?#]+)["']/i);
  if (tgMatch) result.telegram = cleanUrl(tgMatch[1]);

  return result;
}

function cleanUrl(url) {
  return url.replace(/&amp;/g, '&').split('?')[0].split('#')[0].replace(/\/$/, '');
}

// ══════════════════════════════════════════════
// CONTACT EXTRACTOR — telefon, email, adresă
// ══════════════════════════════════════════════
function extractContact(html) {
  const result = { phone: null, email: null, address: null, phoneAll: [], emailAll: [] };

  // Telefon — tel: link e cel mai sigur
  const telMatches = [...html.matchAll(/href=["']tel:([+\d\s\-().]+)["']/gi)];
  telMatches.forEach(m => {
    const phone = normalizePhone(m[1]);
    if (phone && !result.phoneAll.includes(phone)) result.phoneAll.push(phone);
  });

  // Fallback: telefon din text (pattern românesc complet)
  if (result.phoneAll.length === 0) {
    const textOnly = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ');
    const phonePatterns = [
      /\b(07\d{2}[\s.\-]?\d{3}[\s.\-]?\d{3})\b/g,
      /\b(0[23]\d{2}[\s.\-]?\d{3}[\s.\-]?\d{3})\b/g,
      /\b(\+40[\s.\-]?7\d{2}[\s.\-]?\d{3}[\s.\-]?\d{3})\b/g,
      /\b(\+40[\s.\-]?[23]\d{2}[\s.\-]?\d{3}[\s.\-]?\d{3})\b/g,
    ];
    for (const p of phonePatterns) {
      const matches = [...textOnly.matchAll(p)];
      matches.forEach(m => {
        const phone = normalizePhone(m[1]);
        if (phone && !result.phoneAll.includes(phone)) result.phoneAll.push(phone);
      });
      if (result.phoneAll.length > 0) break;
    }
  }
  result.phone = result.phoneAll[0] || null;

  // Email — mailto: e cel mai sigur
  const mailtoMatches = [...html.matchAll(/href=["']mailto:([^"'\s?]+)["']/gi)];
  mailtoMatches.forEach(m => {
    const email = m[1].toLowerCase().trim();
    if (isValidEmail(email) && !result.emailAll.includes(email)) result.emailAll.push(email);
  });

  // Fallback: email din text
  if (result.emailAll.length === 0) {
    const emailMatches = [...html.matchAll(/\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g)];
    emailMatches.forEach(m => {
      const email = m[1].toLowerCase();
      if (isValidEmail(email) && !email.includes('example') && !email.includes('your@') &&
          !email.includes('.png') && !email.includes('.jpg') && !result.emailAll.includes(email)) {
        result.emailAll.push(email);
      }
    });
  }
  result.email = result.emailAll[0] || null;

  // Adresă — pattern românesc: Str./Strada/Bd./Bulevardul + nume + nr.
  const addressPatterns = [
    /(?:Str\.|Strada|Bd\.|Bulevardul|Calea|Șos\.|Șoseaua)\s+[A-ZĂÂÎȘȚa-zăâîșț\s.]+(?:nr\.?\s*\d+[A-Za-z]?)/i,
  ];
  const textOnly = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const p of addressPatterns) {
    const m = textOnly.match(p);
    if (m) { result.address = m[0].trim(); break; }
  }

  return result;
}

function normalizePhone(phone) {
  const cleaned = phone.replace(/[\s.\-()]/g, '');
  if (cleaned.length < 9 || cleaned.length > 13) return null;
  // Format frumos: 0721 234 567
  if (cleaned.startsWith('+40')) {
    const digits = cleaned.substring(3);
    return '+40 ' + digits.substring(0, 3) + ' ' + digits.substring(3, 6) + ' ' + digits.substring(6);
  }
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    return cleaned.substring(0, 4) + ' ' + cleaned.substring(4, 7) + ' ' + cleaned.substring(7);
  }
  return cleaned;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

// ══════════════════════════════════════════════
// HOURS EXTRACTOR — program de lucru
// ══════════════════════════════════════════════
function extractHours(html) {
  const textOnly = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const days = 'Luni|Marți|Miercuri|Joi|Vineri|Sâmbătă|Duminică|Mon|Tue|Wed|Thu|Fri|Sat|Sun';
  
  // Pattern: "Luni-Vineri: 09:00-18:00" sau "Luni - Vineri 9:00 - 18:00"
  const rangePattern = new RegExp(`((?:${days})\\s*[-–]\\s*(?:${days})?\\s*:?\\s*\\d{1,2}[:.]\\d{2}\\s*[-–]\\s*\\d{1,2}[:.]\\d{2})`, 'gi');
  const singlePattern = new RegExp(`((?:${days})\\s*:?\\s*\\d{1,2}[:.]\\d{2}\\s*[-–]\\s*\\d{1,2}[:.]\\d{2})`, 'gi');

  const ranges = [...textOnly.matchAll(rangePattern)].map(m => m[1].trim());
  const singles = [...textOnly.matchAll(singlePattern)].map(m => m[1].trim());

  const allMatches = [...new Set([...ranges, ...singles])].slice(0, 4);

  if (allMatches.length > 0) {
    return allMatches.join(', ');
  }

  // JSON-LD openingHours ca fallback
  const jsonLdMatch = html.match(/"openingHours"\s*:\s*"([^"]+)"/i)
    || html.match(/"openingHoursSpecification"/i);
  if (jsonLdMatch && jsonLdMatch[1]) return jsonLdMatch[1];

  return null;
}

// ══════════════════════════════════════════════
// PRICE EXTRACTOR — găsește servicii + prețuri fără AI
// ══════════════════════════════════════════════
function extractServicesWithPrices(html) {
  const services = [];
  const seen = new Set();

  // Pattern 1: "Nume serviciu ... 250 Lei" sau "250 RON" sau "250€"
  // Caută în structuri de listă și tabele mai întâi
  const listItemRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  const tableRowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const priceCardRegex = /<div[^>]*class=["'][^"']*(?:price|tarif|service)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;

  const priceRegex = /(\d{1,5}(?:[.,]\d{2})?)\s*(?:lei|ron|€|eur|\$)/i;
  const priceRegexReverse = /(?:lei|ron|€|eur|\$)\s*(\d{1,5}(?:[.,]\d{2})?)/i;

  function extractFromBlock(block) {
    const text = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 3 || text.length > 200) return null;

    let priceMatch = text.match(priceRegex) || text.match(priceRegexReverse);
    if (!priceMatch) return null;

    const price = priceMatch[1];
    const currency = /lei|ron/i.test(priceMatch[0]) ? 'LEI' : /€|eur/i.test(priceMatch[0]) ? 'EUR' : '$';
    
    // Numele serviciului = tot textul minus prețul
    let name = text.replace(priceMatch[0], '').trim();
    name = name.replace(/^[-–:.\s]+|[-–:.\s]+$/g, '').trim();
    
    // Extrage și durata dacă există (ex: "30 min", "1h")
    const durationMatch = text.match(/(\d{1,3}\s*(?:min|minute|h|ore|oră))/i);
    const duration = durationMatch ? durationMatch[1] : null;
    
    if (name.length < 3 || name.length > 100) return null;
    // Validare: numele trebuie sa contina cel putin 2 litere si sa nu fie doar numere/simboluri
    if (!/[a-zA-ZăâîșțĂÂÎȘȚ]{3,}/.test(name)) return null;
    // Exclude fragmente evidente (doar numere, doar simboluri)
    if (/^[\/\d\s\-\+\.]+$/.test(name.trim())) return null;

    return { name, price: `${price} ${currency}`, duration };
  }

  // Try list items
  let matches = [...html.matchAll(listItemRegex)];
  matches.forEach(m => {
    const result = extractFromBlock(m[1]);
    if (result && !seen.has(result.name.toLowerCase())) {
      seen.add(result.name.toLowerCase());
      services.push(result);
    }
  });

  // Try table rows
  if (services.length < 3) {
    matches = [...html.matchAll(tableRowRegex)];
    matches.forEach(m => {
      const result = extractFromBlock(m[1]);
      if (result && !seen.has(result.name.toLowerCase())) {
        seen.add(result.name.toLowerCase());
        services.push(result);
      }
    });
  }

  // Try price cards
  if (services.length < 3) {
    matches = [...html.matchAll(priceCardRegex)];
    matches.forEach(m => {
      const result = extractFromBlock(m[1]);
      if (result && !seen.has(result.name.toLowerCase())) {
        seen.add(result.name.toLowerCase());
        services.push(result);
      }
    });
  }

  // Pattern nou: nume pe un rand, pret pe randul urmator (h3/h4 + span/div separat)
  if (services.length < 5) {
    const headingPriceRegex = /<(h[2-6]|strong|b)[^>]*>([^<]{3,100})<\/\1>\s*(?:<[^>]+>)*\s*(\d{2,5})\s*(?:ron|lei|€|eur)/gi;
    let hm;
    while ((hm = headingPriceRegex.exec(html)) !== null) {
      const name = hm[2].trim();
      const price = hm[3];
      if (name.length >= 3 && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        services.push({ name, price: price + ' RON', duration: null });
      }
    }
  }

  // Pattern: text urmat de numar RON in urmatoarele 200 caractere (mai permisiv)
  if (services.length < 5) {
    const textOnly2 = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    const chunks = textOnly2.split(/<(?:h[2-6]|p|div)[^>]*>/i);
    chunks.forEach(chunk => {
      const clean = chunk.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const m = clean.match(/^([A-ZĂÂÎȘȚ][a-zA-ZăâîșțĂÂÎȘȚ\s\-,]{3,80}?)\s+(\d{2,5})\s*(?:RON|LEI|lei|ron)\b/);
      if (m) {
        const name = m[1].trim();
        const price = m[2];
        if (name.length >= 3 && name.length <= 80 && !seen.has(name.toLowerCase()) && services.length < 60) {
          seen.add(name.toLowerCase());
          services.push({ name, price: price + ' RON', duration: null });
        }
      }
    });
  }

  // Fallback: linie cu linie din text simplu (paragrafe cu preț)
  if (services.length === 0) {
    const textOnly = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    const lines = textOnly.replace(/<[^>]+>/g, '\n').split('\n').map(l => l.trim()).filter(l => l.length > 3);
    lines.forEach(line => {
      const result = extractFromBlock(line);
      if (result && !seen.has(result.name.toLowerCase()) && services.length < 50) {
        seen.add(result.name.toLowerCase());
        services.push(result);
      }
    });
  }

  return services.slice(0, 60);
}

// ══════════════════════════════════════════════
// SERVICE NAMES EXTRACTOR — fără prețuri, doar nume
// (pentru clinici care nu publică prețuri)
// ══════════════════════════════════════════════
function extractServiceNames(html) {
  const services = [];
  const seen = new Set();

  // Din liste în secțiuni "servicii"
  const serviceSection = html.match(/<(?:section|div)[^>]*(?:id|class)=["'][^"']*servic[^"']*["'][^>]*>([\s\S]*?)<\/(?:section|div)>/i);
  const searchHtml = serviceSection ? serviceSection[1] : html;

  const listItems = [...searchHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)];
  listItems.forEach(m => {
    const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length >= 4 && text.length <= 80 && !seen.has(text.toLowerCase())) {
      // Exclude non-services (nav links, etc.)
      if (!/^(acasă|home|contact|despre|blog|program|login)$/i.test(text)) {
        seen.add(text.toLowerCase());
        services.push({ name: text, price: null, duration: null });
      }
    }
  });

  return services.slice(0, 40);
}

// ══════════════════════════════════════════════
// JSON-LD EXTRACTOR — date structurate 100% sigure
// ══════════════════════════════════════════════
function extractJsonLd(html) {
  const result = {
    name: null, phone: null, email: null, address: null,
    city: null, hours: null, socialLinks: [], description: null,
    priceRange: null, rating: null, reviewCount: null,
  };

  const jsonLdRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = jsonLdRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const items = parsed['@graph'] || (Array.isArray(parsed) ? parsed : [parsed]);

      items.forEach(item => {
        if (!item) return;
        const types = [item['@type']].flat().filter(Boolean);
        const isBusinessType = types.some(t => [
          'LocalBusiness', 'MedicalBusiness', 'Dentist', 'Physician',
          'VeterinaryCare', 'BeautySalon', 'HealthAndBeautyBusiness',
          'AutoRepair', 'MedicalClinic', 'Hospital', 'Organization', 'Store'
        ].includes(t));

        if (isBusinessType || item.telephone || item.address) {
          if (item.name && !result.name) result.name = item.name;
          if (item.telephone && !result.phone) result.phone = item.telephone;
          if (item.email && !result.email) result.email = item.email;
          if (item.description && !result.description) result.description = item.description;
          if (item.priceRange && !result.priceRange) result.priceRange = item.priceRange;

          if (item.address) {
            if (typeof item.address === 'string') result.address = item.address;
            else {
              if (item.address.streetAddress) result.address = item.address.streetAddress;
              if (item.address.addressLocality) result.city = item.address.addressLocality;
            }
          }

          if (item.openingHours) {
            result.hours = Array.isArray(item.openingHours) ? item.openingHours.join(', ') : item.openingHours;
          }
          if (item.openingHoursSpecification) {
            const specs = Array.isArray(item.openingHoursSpecification) ? item.openingHoursSpecification : [item.openingHoursSpecification];
            result.hours = specs.map(s => `${(s.dayOfWeek||[]).toString()}: ${s.opens}-${s.closes}`).join(', ');
          }

          if (item.sameAs) {
            const links = Array.isArray(item.sameAs) ? item.sameAs : [item.sameAs];
            result.socialLinks.push(...links);
          }

          if (item.aggregateRating) {
            result.rating = item.aggregateRating.ratingValue;
            result.reviewCount = item.aggregateRating.reviewCount;
          }
        }
      });
    } catch (e) { /* Invalid JSON-LD, skip */ }
  }

  return result;
}

// ══════════════════════════════════════════════
// META EXTRACTOR — OpenGraph, meta tags
// ══════════════════════════════════════════════
function extractMeta(html) {
  const result = { title: null, description: null, ogImage: null, siteName: null };

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) result.title = titleMatch[1].trim();

  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  if (descMatch) result.description = descMatch[1].trim();

  const ogImageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (ogImageMatch) result.ogImage = ogImageMatch[1];

  const siteNameMatch = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  if (siteNameMatch) result.siteName = siteNameMatch[1];

  return result;
}

// ══════════════════════════════════════════════
// MASTER EXTRACTOR — combină tot, cu prioritate
// ══════════════════════════════════════════════
function extractAll(html, url) {
  const jsonLd = extractJsonLd(html);
  const social = extractSocialMedia(html);
  const contact = extractContact(html);
  const hours = extractHours(html);
  const meta = extractMeta(html);
  let services = extractServicesWithPrices(html);
  if (services.length === 0) services = extractServiceNames(html);

  // Prioritate: JSON-LD > tel/mailto links > text regex
  const finalPhone = jsonLd.phone || contact.phone;
  const finalEmail = jsonLd.email || contact.email;
  const finalHours = jsonLd.hours || hours;
  const finalCity = jsonLd.city;
  const finalAddress = jsonLd.address || contact.address;
  const finalName = jsonLd.name || meta.siteName || meta.title;

  // Social din JSON-LD sameAs are prioritate
  let finalFacebook = social.facebook;
  let finalInstagram = social.instagram;
  jsonLd.socialLinks.forEach(link => {
    if (/facebook\.com/i.test(link) && !finalFacebook) finalFacebook = link;
    if (/instagram\.com/i.test(link) && !finalInstagram) finalInstagram = link;
    if (/tiktok\.com/i.test(link) && !social.tiktok) social.tiktok = link;
    if (/youtube\.com/i.test(link) && !social.youtube) social.youtube = link;
  });

  // Calculate confidence per field — determinist, nu ghicit
  const confidence = {
    phone: contact.phoneAll.length > 0 ? 100 : (jsonLd.phone ? 100 : 0),
    email: contact.emailAll.length > 0 ? (contact.email?.includes('mailto') ? 100 : 90) : (jsonLd.email ? 100 : 0),
    facebook: finalFacebook ? 100 : 0,
    instagram: finalInstagram ? 100 : 0,
    hours: jsonLd.hours ? 95 : (hours ? 75 : 0),
    address: jsonLd.address ? 95 : (contact.address ? 70 : 0),
    city: jsonLd.city ? 95 : 0,
    name: jsonLd.name ? 100 : (meta.siteName ? 80 : (meta.title ? 60 : 0)),
    services: services.length > 10 ? 90 : services.length > 3 ? 70 : services.length > 0 ? 50 : 0,
    prices: services.filter(s => s.price).length > 5 ? 90 : services.filter(s => s.price).length > 0 ? 60 : 0,
  };

  return {
    // Date finale (best-of din toate sursele)
    name: finalName,
    phone: finalPhone,
    email: finalEmail,
    hours: finalHours,
    city: finalCity,
    address: finalAddress,
    description: jsonLd.description || meta.description,
    priceRange: jsonLd.priceRange,
    rating: jsonLd.rating,
    reviewCount: jsonLd.reviewCount,
    facebook: finalFacebook,
    instagram: finalInstagram,
    tiktok: social.tiktok,
    youtube: social.youtube,
    whatsapp: social.whatsapp,
    linkedin: social.linkedin,
    services,

    // Metadata pentru debugging/learning engine
    _sources: {
      hasJsonLd: !!(jsonLd.name || jsonLd.phone),
      phoneSource: jsonLd.phone ? 'json_ld' : contact.phoneAll.length > 0 ? 'tel_link_or_regex' : 'none',
      emailSource: jsonLd.email ? 'json_ld' : contact.emailAll.length > 0 ? 'mailto_or_regex' : 'none',
      servicesMethod: services.length > 0 ? (services[0].price ? 'price_extractor' : 'name_extractor') : 'none',
      allPhonesFound: contact.phoneAll,
      allEmailsFound: contact.emailAll,
    },
    _confidence: confidence,
  };
}

module.exports = {
  extractSocialMedia,
  extractContact,
  extractHours,
  extractServicesWithPrices,
  extractServiceNames,
  extractJsonLd,
  extractMeta,
  extractAll,
};
