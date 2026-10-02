'use strict';

/**
 * RecepAI ReceptionEngine — deterministic, Romanian, instant.
 *
 * Answers 90% of reception questions WITHOUT an LLM: price, hours,
 * address, insurance, urgency, doctors, appointment intake. No AI = no
 * hallucination, zero cost, sub-10ms. Claude handles the long tail.
 *
 * answer(message, profile) → { reply, handled, lead?: {name, phone} }
 * handled=false  → caller should fall back to the LLM.
 */

const ACC = { 'ă': 'a', 'â': 'a', 'î': 'i', 'ș': 's', 'ş': 's', 'Ț': 'T', 'ț': 't', 'Ă': 'A', 'Â': 'A', 'Î': 'I', 'Ș': 'S', 'Ș': 'S', 'Ț': 'T' };
function norm(s) {
  return String(s || '').toLowerCase().replace(/[ăâîșşțĂÂÎȘŞȚ]/g, c => ACC[c] || c).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// "masea de minte" → molar de minte; "scot" → extractie; "albire" → albire
const SYNS = {
  'scot': 'extractie', 'scoti': 'extractie', 'scotea': 'extractie', 'extrag': 'extractie',
  'extract': 'extractie', 'masea': 'extractie molar',
  'placa': 'obturatie', 'placare': 'obturatie',
  'plomb': 'obturatie', 'plombare': 'obturatie', 'obtur': 'obturatie',
};

function expandSynonyms(msgNorm) {
  let out = msgNorm;
  for (const [k, v] of Object.entries(SYNS)) {
    if (out.includes(k)) out += ' ' + v;
  }
  return out;
}

// Loose containment: "extractia" contains the 6-char stem of "extractie",
// "placa" matches "placare", diacritics are already normalized by norm().
function wordMatches(word, q) {
  if (q.includes(word)) return true;
  if (word.length >= 4) {
    const stem = word.slice(0, 6);
    if (q.includes(stem)) return true;
  }
  return false;
}

function pickService(profile, msgNorm) {
  const list = pickServices(profile, msgNorm);
  return list[0] || null;
}

// Multi-service picker: returns every service the message plausibly refers to,
// best-scored first. This is what lets "vreau o albire si sa scot o masea de
// minte" return BOTH the albire price AND the molar-de-minte price instead of
// just the single best guess.
function pickServices(profile, msgNorm) {
  const svcs = (profile.services || []).filter(s => s && s.name);
  const q = expandSynonyms(msgNorm);
  const scored = [];
  for (const s of svcs) {
    const nameNorm = norm(s.name);
    // exact-ish full-name match is the strongest signal
    if (nameNorm.length >= 4 && q.includes(nameNorm)) {
      scored.push({ s, score: nameNorm.length, matched: nameNorm.length, total: nameNorm.length });
      continue;
    }
    const words = nameNorm.split(' ').filter(w => w.length > 3);
    let matched = 0, total = 0;
    for (const w of words) {
      total += w.length;
      if (wordMatches(w, q)) matched += w.length;
    }
    // A service is a real candidate when at least one distinctive word
    // (5+ chars) is present — "albire", "extractie", "implant", "coroana".
    // Distinctive-word presence beats the old 40%-of-name threshold, which
    // missed multi-word names like "Albire profesionala in-office".
    const hasDistinctive = words.some(w => w.length >= 5 && wordMatches(w, q));
    if (hasDistinctive && matched >= 4) {
      // more matched length = more specific match; "molar de minte" (3 words
      // matched) beats bare "Extractie simpla" (1 word) for the same message.
      scored.push({ s, score: matched, matched, total });
    }
  }
  // Best score first; on ties, the more specific (longer matched name) wins,
  // then the shorter overall name (more distinctive service).
  scored.sort((a, b) => (b.score - a.score) || (b.matched - a.matched) ||
    (norm(a.s.name).length - norm(b.s.name).length));
  return scored.map(x => x.s);
}

function priceText(s) {
  if (!s || !s.price) return null;
  return String(s.price).replace(/RON/i, 'RON').replace(/lei/gi, 'RON');
}

function durationText(s) {
  // duration_minutes is the canonical field (set by the scanner / merge engine).
  // s.duration may also exist as a human string like "45 min" from Claude.
  let n = s.duration_minutes;
  if (!n && s.duration) {
    const m = String(s.duration).match(/(\d{1,4})/);
    if (m) n = parseInt(m[1], 10);
  }
  if (!n) return null;
  return ' durează ~' + n + ' min';
}

function detectLead(message) {
  // RO mobile: 07XXXXXXXX / 7XXXXXXXX / +407XXXXXXXX / 00407... — allow
  // separators. The old pattern demanded one extra digit, so real 10-digit
  // numbers like "0721234567" were missed.
  const phoneRaw = message.match(/(\+?40|0040|0)?\s?7\d(?:[\s.\-]?\d){7,8}/);
  const phone = phoneRaw ? phoneRaw[0].replace(/[^\d+]/g, '') : null;
  let name = null;
  const m = message.match(/(?:ma numesc|mă numesc|numele meu e|numele meu este|sunt|im nume|im name)\s+([A-ZĂÂÎȘȚÂ][a-zăâîșțâ]{2,}([ ]+[A-ZĂÂÎȘȚÂ][a-zăâîșțâ]{2,})?)/i);
  if (m) name = m[1];
  // "Ion Popescu 0721..." — name glued right before the number
  if (!name && phone) {
    const pm = message.match(/([A-ZĂÂÎȘȚÂ][a-zăâîșțâ]{2,}[ ]+[A-ZĂÂÎȘȚÂ][a-zăâîșțâ]{2,})\s*\+?\d/);
    if (pm) name = pm[1];
  }
  return { phone, name };
}

function isAppointmentIntent(t) {
  return /\b(programare|programat|programaza|programez|programam|programati|rezerv|rezervare|vreau (sa )?(ma )?program|dorim|as vrea|inregistrat|apointment|book)\b/.test(t);
}

function isPriceIntent(t) {
  // Substring on the normalised string (norm() already strips diacritics):
  // "costa", "cat ma costa", "preț", "tarif" are all covered without the
  // fragile word-boundary + contraction gymnastics.
  return /pret|pre[st]ur|costa|tarif|cat e\b/.test(t);
}
function isHoursIntent(t) {
  return /\b(program|orar|deschis|deschis[ae]?|ore|cat (este|e) (programul|orarul)|function[ae]zi|deschideti|deschideți|inchis|închis|noaptea|s[âa]mb[âa]t[âa])\b/.test(t);
}
function isLocationIntent(t) {
  return /\b(adres|adresa|undeva?|und e|und esti|locatie|locație|gasiti|găsiți|găsiti|ajung|parcare|metrou|acces|trajet|aflați|aflati)\b/.test(t);
}
function isInsuranceIntent(t) {
  return /\b(asigurari|asigurări|casmb|biznis|medicover|medlife|allianz|generali|signal iduna|decont|decontare|card (de )?sanatate|sănătate)\b/.test(t);
}
function isUrgencyIntent(t) {
  // A GENUINE emergency (blood / infection / severe pain / "am o urgență").
  // "aveti un numar/telefon pentru urgente" is a CONTACT question, not a live
  // emergency, so it is excluded — otherwise it would hijack the message and
  // drop the price/location answers the patient also asked for.
  const core = /sanger|sânge|sange|infectie|înfectie|ame o urgent[ae]|urgen[țt]e acum|imediat (am|sunt|venit)|durere (intens[ae]|fort[ae]|t[oa]r[ee])|m[ăa] doare (foarte|mult)/.test(t);
  if (!core) return false;
  return !/(numar|număr|telefon|tel |contact)/.test(t);
}
function isDoctorsIntent(t) {
  // Substring root-match so "medicii", "medicești", "medice" all hit,
  // combined with an explicit ask (care / cine / echip / listă / dr).
  const mentionsDoc = /medic|echip|specialist|doctor|ortodont|implantolog/.test(t);
  const asking = /\b(care|cine|list[ae])\b/.test(t) || /\bdr\./.test(t);
  return mentionsDoc && (asking || /medici|echip/.test(t));
}
function isServiceListIntent(t) {
  return /\b(servicii|ce oferiti|ce oferiți|activitati|activități|ce faceti|ce faceți|oferta|ofert[ae])\b/.test(t);
}
function isContactIntent(t) {
  // Substring match on the normalised string (norm() has already stripped
  // diacritics and punctuation), so "număr/numărul/numere" and "urgențe"
  // are all covered without fragile word-boundary logic.
  return /contact|telefon|telefoane|suna|numar|numere|email|whatsapp|mesaj|receptie|oficiu|urgen|urgent/.test(t);
}

// ── MULTI-INTENT: answer EVERY question in one message ──────────────
// A patient often asks several things at once ("aveti parcare, cat costa
// un implant si ce adresa aveti?"). The old engine returned on the FIRST
// intent it found, so the rest were ignored. Each resolver below checks
// whether its intent is present in the message and returns an answer if so;
// we collect ALL active answers and join them, so one message gets every
// answer in one reply.
const facDetails = (p) => {
  const fac = (p.facilities && typeof p.facilities === 'object' && !Array.isArray(p.facilities)) ? p.facilities : {};
  return (k) => fac[k] && fac[k].available !== false ? (fac[k].details ? String(fac[k].details) : 'da') : null;
};

function resolveUrgent(t, p, phone) {
  if (!isUrgencyIntent(t)) return null;
  const em = p.emergencyPhone || p.phone;
  return `Pentru urgențe sunați imediat la ${em ? em : 'recepția'} — avem medic de gardă 24/7 🚨\nDacă nu puteți suna, veniți direct: ${p.address || 'adresa din site'}.`;
}

// Common service keywords so a service the patient names is never silently
// dropped even if the scanned profile does not list it. If the profile has
// the service with a price we use it; otherwise we say "preț la cerere" and
// offer to book — the patient is still answered on every question they asked.
const SERVICE_KEYWORDS = [
  ['albire', 'Albire'], ['whitening', 'Albire'],
  ['detartraj', 'Detartraj'], ['periaj', 'Detartraj'],
  ['implant', 'Implant'], ['coroan', 'Coroană'],
  ['canal', 'Tratament de canal'], ['endodont', 'Tratament de canal'],
  ['extract', 'Extractie'], ['scot', 'Extractie'], ['molar', 'Extractie molar'], ['masea', 'Extractie molar'],
  ['plomb', 'Obturație'], ['obtur', 'Obturație'],
  ['aparat', 'Aparat dentar'], ['ortodon', 'Ortodonție'], ['invis', 'Invisalign'],
  ['protez', 'Proteză'], ['bridge', 'Proteză'],
];

function mentionedServiceLabels(t, p) {
  // Distinct service labels the message refers to, minus ones already covered
  // by a priced profile service (those are reported with their real price).
  const pricedNames = (p.services || [])
    .filter(s => s && s.name && s.price)
    .map(s => norm(s.name));
  const labels = [];
  for (const [kw, label] of SERVICE_KEYWORDS) {
    if (!t.includes(kw)) continue;
    const covered = pricedNames.some(n => n.includes(kw));
    if (!covered && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

function resolvePrice(t, p, phone) {
  if (!isPriceIntent(t)) return null;
  const list = pickServices(p, t).slice(0, 4);
  const priced = list.filter(s => s.price);
  const extra = mentionedServiceLabels(t, p);
  if (priced.length) {
    const lines = priced.map(s => `• ${s.name}: ${priceText(s)}${durationText(s) || ''}`).join('\n');
    const intro = priced.length > 1
      ? 'Cât vă costă (pe ce ați cerut):'
      : 'Preț:';
    const extras = extra.length ? '\n' + extra.map(e => `• ${e}: preț la cerere — vă rog sunați la ${phone || 'recepție'}`).join('\n') : '';
    return `${intro}\n${lines}${extras}\nDoriți să vă programăm? Scrieți-mi numele și telefonul 😊`;
  }
  const withPrice = (p.services || []).filter(s => s && s.price).slice(0, 6);
  if (withPrice.length) {
    const lines = withPrice.map(s => `• ${s.name} — ${priceText(s)}${durationText(s) || ''}`).join('\n');
    const extras = extra.length ? '\n' + extra.map(e => `• ${e}: preț la cerere`).join('\n') : '';
    return `Câteva dintre prețurile noastre:\n${lines}${extras}`;
  }
  const onlyExtra = extra.length ? extra.map(e => '• ' + e).join('\n') : '';
  if (onlyExtra) return `Pentru ${extra.join(' și ')} prețul e la cerere — vă rog sunați la ${phone || 'recepție'}.`;
  return `Pentru prețuri exacte, vă rog sunați la ${phone || 'recepție'}.`;
}

function resolveHours(t, p, phone) {
  if (!isHoursIntent(t) || !p.hours) return null;
  return `🕐 Programul nostru: ${p.hours}${phone ? '\nPentru urgențe: ' + phone + ' (24/7).' : ''}`;
}

function resolveLocation(t, p, phone) {
  if (!isLocationIntent(t)) return null;
  const det = facDetails(p);
  const bits = [];
  if (/parc/.test(t)) {
    const d = det('parking');
    bits.push(d ? '🚗 Da, avem parcare: ' + d : 'Pentru parcare, vă rog sunați la ' + (phone || 'recepție') + '.');
  }
  if (/metr|ajung|trajet/.test(t)) {
    const d = det('metro');
    if (d) bits.push('🚇 Metrou: ' + d);
  }
  if (/dizab|ramp|invalid/.test(t)) {
    const d = det('disability');
    if (d) bits.push('♿ Acces pentru persoane cu dizabilități: ' + d + '.');
  }
  // Address question (or a bare location intent with no specific keyword)
  if (/adres|locatie|locație|und|gasit|gasiti|afla|aflati|trajet/.test(t) || (!/parc|metr|dizab|ramp|invalid/.test(t))) {
    if (p.address) bits.push('📍 ' + p.address + (p.city ? ', ' + p.city : ''));
  }
  if (bits.length) return bits.join('\n');
  return 'Ne găsiți la ' + (p.address || 'adresa din secțiunea Contact a site-ului') + (phone ? '. Pentru traseu, sunați la ' + phone + ' 📍' : '.');
}

function resolvePayment(t, p) {
  const pay = (p.payments && typeof p.payments === 'object') ? p.payments : {};
  if (/\b(card|cardul|visa|mastercard|pos)\b/.test(t) && pay.card && pay.card.available) {
    return 'Da, acceptăm plata cu card (Visa/Mastercard), numerar și transfer bancar.';
  }
  if (/rate/.test(t) && pay.rates && pay.rates.available) {
    return 'Da, oferim plata în rate' + (pay.rates.provider ? ' prin ' + pay.rates.provider : '') + '.';
  }
  return null;
}

function resolveInsurance(t, p, phone) {
  if (!isInsuranceIntent(t)) return null;
  const ins = (p.insurances || p.brain && p.brain.insurances || []).filter(Boolean);
  if (!ins.length) return null;
  return 'Acceptăm: ' + ins.slice(0, 8).join(', ') + '.\nPentru decontare, factura se emite cu datele complete — cu orice întrebare, sunați la ' + (phone || 'recepție') + ' 📞';
}

function resolveDoctors(t, p) {
  if (!isDoctorsIntent(t)) return null;
  const docs = (p.doctors || []).filter(d => d && d.name).slice(0, 6);
  if (!docs.length) return null;
  const lines = docs.map(d => `• ${d.name}${d.role ? ' — ' + d.role : ''}`).join('\n');
  return `Echipa noastră:\n${lines}`;
}

function resolveServiceList(t, p, phone) {
  if (!isServiceListIntent(t) || !(p.services || []).length) return null;
  const svcs = p.services.slice(0, 8).map(s => '• ' + s.name).join('\n');
  return `Ce oferim:\n${svcs}${phone ? '\nPentru detalii și programare: ' + phone + ' 📞' : ''}`;
}

function resolveContact(t, p, phone) {
  if (!isContactIntent(t)) return null;
  const bits = [];
  // "care e numarul pentru urgente / receptie" → give the right line, not just
  // one number. emergencyPhone is the dedicated 24/7 line the scanner captured.
  const em = p.emergencyPhone;
  if (/urgen/.test(t)) {
    bits.push('🚨 Pentru urgențe: ' + (em || phone || 'recepția') + ' (24/7)');
  } else if (/recept|oficiu|secretariat/.test(t)) {
    bits.push('📞 Recepție: ' + (phone || ''));
  }
  // Generic contact ask → list the distinct lines we know about
  if (!/urgen|recept|oficiu|secretariat/.test(t)) {
    if (phone) bits.push('📞 ' + phone + ' (recepție)');
    if (em && em !== phone) bits.push('🚨 ' + em + ' (urgențe 24/7)');
    if (p.email) bits.push('✉️ ' + p.email);
    if (p.facebook) bits.push('📘 ' + p.facebook);
    if (p.instagram) bits.push('📸 ' + p.instagram);
  }
  return bits.length ? bits.join('\n') : null;
}

// ── Helpers exported for the Conversation State Manager ────────────
// infoAnswer returns ONLY the informational parts of a message (price,
// hours, location, payment, insurance, doctors, service list, contact, FAQ)
// WITHOUT the booking/lead logic. The state manager uses this to answer a
// price/hours question inline while a booking is in progress.
function infoAnswer(message, profile) {
  const t = norm(message);
  const p = profile || {};
  const phone = p.phone ? String(p.phone).replace(/[\s.\-]/g, ' ').trim() : null;
  const parts = [];
  const urg = resolveUrgent(t, p, phone);
  if (urg) parts.push(urg);
  const resolvers = [resolvePrice, resolveHours, resolveLocation, resolvePayment,
    resolveInsurance, resolveDoctors, resolveServiceList, resolveContact];
  for (const r of resolvers) {
    const out = r(t, p, phone);
    if (out) parts.push(out);
  }
  if (!parts.length) {
    const faq = resolveFaq(t, p);
    if (faq) parts.push(faq);
  }
  return parts.length ? parts.join('\n\n') : null;
}

// Best single-service match for a message (reused by the state manager so a
// patient's free-form wording maps to the profile's service with its duration).
function matchService(message, profile) {
  return pickService(profile, message ? norm(message) : '');
}

function resolveFaq(t, p) {
  if (!Array.isArray(p.faq)) return null;
  for (const f of p.faq) {
    if (!f || !f.question) continue;
    const qn = norm(f.question);
    const words = qn.split(' ').filter(w => w.length > 4);
    let hit = 0;
    for (const w of words) if (t.includes(w)) hit++;
    const need = words.length <= 3 ? 1 : 2;
    if (words.length && hit >= need && hit / words.length >= 0.35) return f.answer;
  }
  return null;
}

/**
 * @param {string} message   raw user message (Romanian)
 * @param {object} profile   business profile
 * @returns {{reply:string|null, handled:boolean, lead?:{name,phone}}}
 */
function answer(message, profile) {
  const t = norm(message);
  const p = profile || {};
  const bizName = p.name || 'clinica';
  const phone = p.phone ? String(p.phone).replace(/[\s.\-]/g, ' ').trim() : null;

  const parts = [];
  let lead = null;

  // 1) URGENT — always included (safety first)
  const urg = resolveUrgent(t, p, phone);
  if (urg) parts.push(urg);

  // 2) APPOINTMENT — if the person wants to book, ask for / confirm
  //    name+phone. Still answer the other info questions in the same message.
  if (isAppointmentIntent(t)) {
    const leadDet = detectLead(message);
    const svc = pickService(p, t);
    if (leadDet.phone && leadDet.name) {
      lead = leadDet;
      parts.push(`✅ Mulțumesc, ${leadDet.name}! Solicitarea a fost înregistrată${svc ? ' pentru ' + svc.name : ''}.\nVă vom contacta în maximum 2 ore (în program) pentru a stabili ora exactă. O zi frumoasă! 😊`);
    } else {
      parts.push(`Bine! Cu plăcere. ${svc ? 'Vă rezervăm: ' + svc.name + '.' : ''}\nPentru a înregistra programarea, scrieți-mi numele și numărul de telefon într-un singur mesaj — de exemplu: \"Ion Popescu 0721234567\" 😊`);
    }
  }

  // 3) INFO intents — collect every one present in the message
  const resolvers = [
    resolvePrice, resolveHours, resolveLocation, resolvePayment,
    resolveInsurance, resolveDoctors, resolveServiceList, resolveContact,
  ];
  for (const r of resolvers) {
    const out = r(t, p, phone);
    if (out) parts.push(out);
  }

  // 4) FAQ — only if nothing else answered, to avoid duplication
  if (!parts.length) {
    const faq = resolveFaq(t, p);
    if (faq) parts.push(faq);
  }

  if (parts.length) {
    return { reply: parts.join('\n\n'), handled: true, ...(lead ? { lead } : {}) };
  }

  // 5) Generic greeting / thanks
  if (t.length < 25 && /^(salut|buna|bună|salut|hei|hello|hi|mul[țt]umesc|thanks|ok|da|nu)\b/.test(t)) {
    const svcs = (p.services || []).slice(0, 3).map(s => s.name).join(', ');
    return { reply: `Bună! 👋 Sunt recepționistul virtual al ${bizName}.\nCu ce vă pot ajuta — ${svcs || 'programări, prețuri, program'}?`, handled: true };
  }

  return { reply: null, handled: false };
}

module.exports = { answer, norm, infoAnswer, matchService };
