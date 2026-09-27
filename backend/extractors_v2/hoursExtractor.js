'use strict';
const { extractJsonLd, field, bestField } = require('./utils');

// Romanian day names -> canonical key, incl. common abbreviations (L, V, S, D...)
const DAY_MAP = {
  'l': 'Mon', 'lun': 'Mon', 'luni': 'Mon',
  'm': 'Tue', 'mar': 'Tue', 'marti': 'Tue', 'martî': 'Tue',
  'mie': 'Wed', 'mier': 'Wed', 'miercuri': 'Wed',
  'j': 'Thu', 'joi': 'Thu',
  'v': 'Fri', 'vin': 'Fri', 'vineri': 'Fri',
  's': 'Sat', 'samb': 'Sat', 'sâm': 'Sat', 'sambata': 'Sat', 'sâmbătă': 'Sat',
  'd': 'Sun', 'dum': 'Sun', 'dumin': 'Sun', 'duminica': 'Sun', 'duminică': 'Sun',
};

const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_LABEL = { Mon: 'Luni', Tue: 'Marți', Wed: 'Miercuri', Thu: 'Joi', Fri: 'Vineri', Sat: 'Sâmbătă', Sun: 'Duminică' };

function canonicalDay(token) {
  if (!token) return null;
  const t = String(token).toLowerCase().replace(/[^a-zăâîșț]/g, '').trim();
  return DAY_MAP[t] || null;
}

// Parse a day-set from text: ranges ("Luni-Vineri", "L-V", "Mon-Fri") and lists ("Luni, Joi").
function parseDaySet(text) {
  const days = new Set();
  const range = text.match(/([A-Za-zăâîșț]{1,9})\s*(?:-|–|—|până\s+la|la|to|the)\s*([A-Za-zăâîșț]{1,9})/i);
  if (range) {
    const a = canonicalDay(range[1]);
    const b = canonicalDay(range[2]);
    if (a && b) {
      const ia = DAY_ORDER.indexOf(a), ib = DAY_ORDER.indexOf(b);
      if (ia < ib) { for (let i = ia; i <= ib; i++) days.add(DAY_ORDER[i]); }
      else { for (let i = ib; i <= ia; i++) days.add(DAY_ORDER[i]); }
      return days;
    }
  }
  // Token scan: map every letter-run to a day (handles "Luni: 9-18", "L-V", lists).
  const tokens = String(text).match(/[A-Za-zăâîșț]{1,9}/g) || [];
  for (const tok of tokens) {
    const d = canonicalDay(tok);
    if (d) days.add(d);
  }
  return days;
}

function normTime(t) {
  if (!t) return null;
  const m = String(t).match(/\d{1,2}\s*[.:]\s*\d{0,2}/);
  if (!m) return null;
  let [h, min] = m[0].split(/[.:]/);
  h = String(parseInt(h, 10) % 24).padStart(2, '0');
  min = String(parseInt(min || '0', 10) || 0).padStart(2, '0');
  if (min > 59) return null;
  return h + ':' + min;
}

// Pull time ranges from a chunk: 09:00-18:00 | 9-18 | 9.00-18.00 | 09:00 – 21:00
// Guards — what stops prices and dates from becoming "hours":
//  - raw hour must be a real hour (<=23) and minutes <=59, so "100-200"
//    (a price) or "2023-2024" (a date) never masquerades as opening hours.
//  - if NEITHER side has a colon (a real HH:MM marker), BOTH sides must be
//    1–2 digit numbers. "500-2000" (a price range) has 3–4 digits → rejected.
//  - a range whose open part is glued to a preceding digit is rejected:
//    inside "200-350" the "00-35" match has "2" right in front of it.
function parseTimeRanges(text) {
  const out = [];
  const re = /(\d{1,2})\s*[.:]?\s*(\d{2})?\s*[-–—]\s*(\d{1,2})\s*[.:]?\s*(\d{2})?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const openH = parseInt(m[1], 10);
    const openMin = m[2] ? parseInt(m[2], 10) : 0;
    const closeH = parseInt(m[3], 10);
    const closeMin = m[4] ? parseInt(m[4], 10) : 0;
    // Not a real clock value (price/date) → reject.
    if (openH > 23 || closeH > 23 || openMin > 59 || closeMin > 59) continue;
    // Real times carry a colon marker somewhere ("08:30-20:00"), or are bare
    // 1–2 digit hours on both sides ("9-18"). Without a colon, any 3–4 digit
    // side is a price range ("500-2000"), not a time.
    const full = m[0];
    const hasColon = full.includes(':');
    if (!hasColon) {
      const openDigits = m[1].length + (m[2] ? m[2].length : 0);
      const closeDigits = m[3].length + (m[4] ? m[4].length : 0);
      if (openDigits > 2 || closeDigits > 2) continue;      // "500-2000"
      // glued-digit guard: "200-350" yields "00-35" with a digit in front
      const pre = text.slice(Math.max(0, m.index - 1), m.index);
      if (/[0-9]/.test(pre)) continue;
    }
    const open = String(openH % 24).padStart(2, '0') + ':' + String(openMin).padStart(2, '0');
    const close = String(closeH % 24).padStart(2, '0') + ':' + String(closeMin).padStart(2, '0');
    if (open < close) out.push({ open, close });
  }
  return out;
}

// A range is "plausible business hours" only if it opens in a sane window
// and is open for at least an hour. No clinic/salon/vet opens at 03:00; a
// 45-minute window is almost always a mis-parse. JSON-LD hours bypass this
// (they are structured and trusted).
function plausibleRanges(ranges) {
  return (ranges || []).filter(r => {
    const oh = parseInt(r.open, 10), om = parseInt(r.open.slice(3), 10) || 0;
    const ch = parseInt(r.close, 10), cm = parseInt(r.close.slice(3), 10) || 0;
    if (oh < 5 || oh > 22) return false;        // opens 3am / 11pm is not real
    if ((ch * 60 + cm) - (oh * 60 + om) < 60) return false; // <1h window
    return true;
  });
}

function formatDays(days) {
  if (!days || days.size === 0) return '';
  const ord = DAY_ORDER.filter(d => days.has(d));
  if (ord.length === 5 && ord[0] === 'Mon' && ord[4] === 'Fri') return 'Luni-Vineri';
  if (ord.length === 6 && ord[0] === 'Mon' && ord[5] === 'Sat') return 'Luni-Sâmbătă';
  if (ord.length === 7) return 'Luni-Duminică';
  return ord.map(d => DAY_LABEL[d]).join(', ');
}

// A segment "looks like" it has a day mention if any token maps to a day.
function hasDayMention(seg) {
  const tokens = String(seg).match(/[A-Za-zăâîșț]{1,9}/g) || [];
  return tokens.some(t => canonicalDay(t) !== null);
}

function extractHours(html, page = 'homepage') {
  const candidates = [];

  // JSON-LD
  const jsonLd = extractJsonLd(html);
  jsonLd.forEach(item => {
    const oh = [].concat(item.openingHours || []);
    if (oh.length) {
      const lines = oh.map(o => typeof o === 'string'
        ? o
        : (o.daysOfWeek ? o.daysOfWeek.map(canonicalDay).filter(Boolean).map(k => DAY_LABEL[k]).join(',') : '') + ' ' + (o.opens || '') + '-' + (o.closes || ''));
      candidates.push(field(lines.filter(Boolean).join(' | '), 'json_ld', 95, 'openingHours', page));
    }
    const spec = [].concat(item.openingHoursSpecification || []);
    if (spec.length) {
      const grouped = {};
      spec.forEach(s => {
        const days = (s.dayOfWeek ? [].concat(s.dayOfWeek) : []).map(d => canonicalDay(String(d).split('Day')[0])).filter(Boolean);
        const key = days.length ? days.map(k => DAY_LABEL[k]).join(',') : 'Săptămâna';
        grouped[key] = (grouped[key] ? grouped[key] + ', ' : '') + (s.opens || '') + '-' + (s.closes || '');
      });
      candidates.push(field(Object.entries(grouped).map(([k, v]) => k + ' ' + v).join(' | '), 'json_ld', 95, 'openingHoursSpecification', page));
    }
  });

  const textOnly = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  // Strategy A: day label + time range within a segment (split only on | and newlines,
  // so ranges like "L-V: 9-18" are not torn apart).
  const segments = textOnly.split(/[\n|]/).map(s => s.trim()).filter(s => s && s.length <= 240);
  const found = [];
  const segSeen = new Set();
  for (const seg of segments) {
    const ranges = parseTimeRanges(seg);
    if (!ranges.length) continue;
    if (!hasDayMention(seg)) continue;
    const days = parseDaySet(seg);
    if (!days.size) continue;
    const label = formatDays(days);
    const open = ranges[0].open, close = ranges[0].close;
    const key = label + open + close;
    if (segSeen.has(key)) continue;
    segSeen.add(key);
    found.push({ label, open, close });
  }
  if (found.length) {
    const good = plausibleRanges(found);
    // If no range survived the plausibility filter, trust nothing from here.
    if (good.length) {
      candidates.push(field(good.map(f => f.label + ' ' + f.open + '-' + f.close).join(' | '), 'regex', 80, 'day-hours pattern', page));
    }
  }

  // Strategy B: labelled block
  const label = textOnly.match(/(?:Program|Orar|Ore de program|Program de lucru)\s*:?\s{0,20}([^\n]{10,260}?\d{1,2}[:.]\d{0,2})/i);
  if (label) {
    const ranges = parseTimeRanges(label[1]);
    const good = plausibleRanges(ranges);
    if (good.length) candidates.push(field(good.map(r => r.open + '-' + r.close).join(', ').slice(0, 200), 'label_text', 72, 'Program: label', page));
  }

  // Strategy C: bare time range (generic "09:00 – 18:00")
  const bare = parseTimeRanges(textOnly);
  const bareGood = plausibleRanges(bare);
  if (bareGood.length) {
    const first = bareGood[0];
    candidates.push(field('Luni-Vineri ' + first.open + '-' + first.close, 'bare_range', 55, 'bare time range', page));
  }

  return { value: bestField(...candidates), foundDayLines: found };
}

module.exports = { extractHours, parseDaySet, parseTimeRanges, formatDays };
