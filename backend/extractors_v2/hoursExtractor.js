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
function parseTimeRanges(text) {
  const out = [];
  const re = /(\d{1,2})\s*[.:]?\s*(\d{2})?\s*[-–—]\s*(\d{1,2})\s*[.:]?\s*(\d{2})?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const open = normTime(m[1] + ':' + (m[2] || '0'));
    const close = normTime(m[3] + ':' + (m[4] || '0'));
    if (open && close && Number(close.slice(0, 2)) > Number(open.slice(0, 2))) {
      out.push({ open, close });
    }
  }
  return out;
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
    candidates.push(field(found.map(f => f.label + ' ' + f.open + '-' + f.close).join(' | '), 'regex', 80, 'day-hours pattern', page));
  }

  // Strategy B: labelled block
  const label = textOnly.match(/(?:Program|Orar|Ore de program|Program de lucru)\s*:?\s{0,20}([^\n]{10,260}?\d{1,2}[:.]\d{0,2})/i);
  if (label) {
    const ranges = parseTimeRanges(label[1]);
    if (ranges.length) candidates.push(field(label[1].trim().substring(0, 200), 'label_text', 72, 'Program: label', page));
  }

  // Strategy C: bare time range (generic "09:00 – 18:00")
  const bare = parseTimeRanges(textOnly);
  if (bare.length) {
    const first = bare[0];
    candidates.push(field('Luni-Vineri ' + first.open + '-' + first.close, 'bare_range', 55, 'bare time range', page));
  }

  return { value: bestField(...candidates), foundDayLines: found };
}

module.exports = { extractHours, parseDaySet, parseTimeRanges, formatDays };
