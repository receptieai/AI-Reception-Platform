'use strict';

// ── Multi-Location Extractor ────────────────────────────────────────
// For chain businesses (Mobile Vet, Life Dental, etc.) each branch is a
// block: title + street + hours + phone.
//
// Strategy:
//   1. Flatten HTML → text.
//   2. Find every street address (with position).
//   3. Find every RO phone (with position).
//   4. For each address: take the NEXT phone AFTER the address (within
//      500 chars) — this is the branch's own line "Telefon: 07xx ...".
//      If none, fall back to the previous phone.
//   5. Dedupe by phone (normalized digits) — same phone = same branch,
//      regardless of how many times the address text appears (title +
//      Adresă field).
//   6. JSON-LD LocalBusiness entries are added on top.
//   7. Returns [] unless 2+ distinct locations.
// ────────────────────────────────────────────────────────────────────

const { stripHtml } = require('./utils');

// RO phone numbers with any separator between digits.
const PHONE_RE = /(\+40[\s.\-]?\d{2,3}(?:[ .\-]?\d){6,9}|0[2-3]\d(?:[ .\-]?\d){6,9}|07\d(?:[ .\-]?\d){7,8})/g;

// "Strada X nr. 5", "Str. X 5", "Bd. X", "Calea X", "Șos. X", "Sat X nr. 451"
const STREET_RE = /(?:Str(?:ada)?\.?|Bd\.?|Bulevard\.?|Calea|Șos\.?|Aleea|Sat)\s+[A-ZĂÂÎȘȚ][A-Za-zăâîșț0-9\-\.]+(?:\s+[A-ZĂÂÎȘȚa-zăâîșț0-9\-\.]+)*(?:\s*(?:nr\.?|nr)\s*\.?\s*(\d+[A-Z]?|\d+\s*[-–]\s*\d+))?\b/gi;

// Hours: day name + time range
const HOURS_RE = /((?:Luni|Mar[țt]i|Miercuri|Joi|Vineri|S[âa]mb[âa]t[âa]|Duminic[ăa]|Non[- ]?Stop)[^\n]{3,150}?(?:\d{1,2}[:\-]\d{2}){1,4}[^\n]{0,40})/gi;

// Branch title: "Clinică …", "Cabinet …", "Locație …", "Farmacie …", "Salon …"
const TITLE_RE = /((?:Clinic[ăa]|Cabinet|Loca[țt]ie|Farmacie|Salon)\s+[^\n]{4,90})/g;

const CITIES = [
  'București','Cluj','Timișoara','Iași','Constanța','Craiova','Brașov','Bacău',
  'Arad','Sibiu','Pitești','Oradea','Vâlcea','Râmnicu Vâlcea','Rm. Vâlcea',
  'Galicea','Horezu','Vlădești',
  'Sector 1','Sector 2','Sector 3','Sector 4','Sector 5','Sector 6',
];

function detectCity(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  for (const c of CITIES) {
    if (t.includes(c.toLowerCase().replace('.', ''))) return c;
  }
  return null;
}

function normPhone(p) { return (p || '').replace(/\D/g, ''); }
function normAddr(a) { return (a || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 30); }

function extractLocations(html, page = 'contact') {
  if (!html || html.length < 200) return [];

  const flat = stripHtml(html).replace(/\s+/g, ' ');

  // ── All street addresses (with position) ──
  const streets = [...flat.matchAll(STREET_RE)]
    .map(m => ({ addr: m[0].trim(), pos: m.index }))
    .filter(s => s.addr.length > 8);

  // ── All phones (with position) ──
  const phones = [...flat.matchAll(PHONE_RE)].map(m => ({
    phone: m[1].trim(),
    pos: m.index,
  }));

  // For each address: find the NEXT phone AFTER (within 500 chars).
  // That's the branch's own "Telefon: 07xx ..." line. Fallback: the
  // nearest phone in either direction if no forward match.
  const byPhone = new Map(); // normPhone → { name, address, city, phone, hours }

  for (const s of streets) {
    // Next phone after the address, within 500 chars
    let target = null;
    for (const p of phones) {
      if (p.pos > s.pos && p.pos - s.pos <= 500) { target = p; break; }
    }
    if (!target) {
      // Fallback: nearest phone in either direction (within 500)
      let bestDist = Infinity;
      for (const p of phones) {
        const d = Math.abs(p.pos - s.pos);
        if (d < bestDist && d <= 500) { bestDist = d; target = p; }
      }
    }
    if (!target) continue;

    const pk = normPhone(target.phone);
    if (byPhone.has(pk)) continue; // same phone = same branch (dedupe)

    // Hours: search within 400 chars after the address
    const afterText = flat.slice(s.pos, s.pos + 400);
    const hoursMatch = [...afterText.matchAll(HOURS_RE)][0];
    const hours = hoursMatch ? hoursMatch[1].trim().slice(0, 160) : null;

    // Title: the last "Clinic/Cabinet/Locație" phrase BEFORE the address
    const beforeText = flat.slice(Math.max(0, s.pos - 300), s.pos);
    const titleMatches = [...beforeText.matchAll(TITLE_RE)];
    const name = titleMatches.length ? titleMatches[titleMatches.length - 1][1].trim() : null;

    byPhone.set(pk, {
      name,
      address: s.addr,
      city: detectCity(flat.slice(s.pos, s.pos + 100)),
      phone: target.phone,
      hours,
    });
  }

  // ── JSON-LD: add any structured locations ──
  const jsonLdBlocks = html.match(/<script\s+type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonLdBlocks) {
    try {
      const json = JSON.parse(block.replace(/<script[^>]*>|<\/script>/g, ''));
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        const t = item['@type'];
        if (typeof t === 'string' && /Dentist|Veterinary|Medical|LocalBusiness|Business|Salon|Clinic/i.test(t)) {
          const addr = item.address && typeof item.address === 'object'
            ? item.address.streetAddress
            : (typeof item.address === 'string' ? item.address : null);
          if (addr && addr.length > 4) {
            const pk = item.telephone ? normPhone(item.telephone) : ('addr:' + normAddr(addr));
            if (byPhone.has(pk)) continue;
            byPhone.set(pk, {
              name: item.name || null,
              address: addr,
              city: item.address?.addressLocality || detectCity(addr) || null,
              phone: item.telephone || null,
              hours: item.openingHours
                ? (typeof item.openingHours === 'string' ? item.openingHours : JSON.stringify(item.openingHours).slice(0, 160))
                : null,
            });
          }
        }
      }
    } catch (e) { /* ignore */ }
  }

  const locations = [...byPhone.values()];

  // Only "multi-location" when 2+ distinct
  if (locations.length < 2) return [];

  locations.forEach((l, i) => {
    if (!l.name) l.name = l.city ? 'Locație ' + l.city : 'Locația ' + (i + 1);
    if (!l.city) l.city = detectCity(l.address || l.name || '') || null;
  });

  return locations;
}

module.exports = { extractLocations };
