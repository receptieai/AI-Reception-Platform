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

// Small synonym table so natural patient phrasing matches service names:
// "sa o scot" → extractie, "sparg o placa" → obturație, etc.
const SYNS = {
  'scot': 'extractie', 'scoti': 'extractie', 'scotea': 'extractie', 'extrag': 'extractie',
  'extract': 'extractie', 'placa': 'obturatie', 'placare': 'obturatie',
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
  const svcs = (profile.services || []).filter(s => s && s.name);
  const q = expandSynonyms(msgNorm);
  // exact-ish match: service name appears in the message
  let best = null, bestLen = 0;
  for (const s of svcs) {
    const n = norm(s.name);
    if (n.length >= 4 && q.includes(n)) { if (n.length > bestLen) { best = s; bestLen = n.length; } }
  }
  if (best) return best;
  // key-word match: 3+ char words of the service name, stemmed
  best = null; bestLen = 0;
  for (const s of svcs) {
    const words = norm(s.name).split(' ').filter(w => w.length > 3);
    let hit = 0, total = 0;
    for (const w of words) {
      total += w.length;
      if (wordMatches(w, q)) hit += w.length;
    }
    if (hit >= 4 && hit >= total * 0.4) { if (hit > bestLen) { best = s; bestLen = hit; } }
  }
  return best;
}

function priceText(s) {
  if (!s || !s.price) return null;
  return String(s.price).replace(/RON/i, 'RON').replace(/lei/gi, 'RON');
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
  return /\b(pret|preț|costa|costă|cat costa|cât cost|prețuri|tarif|tarife|preturi|cat e|cât e|costa? (un|o|cu))\b/.test(t) || /\bcat (costa|e|primesti)\b/.test(t);
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
  // Strong emergency signals only. "doare/durere" alone was removed: most
  // price questions contain it ("ma doare maseaua, cat costa sa o scot")
  // and the urgent reply was hijacking real price questions. A genuine
  // emergency is signaled by urgent/sange/infectie/imediat/molar inclus.
  return /\b(urgent|urgen|sanger|sânge|sange|imediat|infectie|înfectie|molar (de )?minte (inclus|includ)|inclus|extrae? (urgent|imediat))\b/.test(t);
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
  return /\b(contact|telefon|suna|sună|sunati|sunăți|num[ră]r|email|whatsapp|mesaj|contacta)\b/.test(t);
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

function resolvePrice(t, p, phone) {
  if (!isPriceIntent(t)) return null;
  const svc = pickService(p, t);
  if (svc && svc.price) {
    return `${svc.name}: ${priceText(svc)}${svc.duration ? ' · durează ' + svc.duration : ''}.\nDoriți să vă programăm? Scrieți-mi numele și telefonul 😊`;
  }
  const withPrice = (p.services || []).filter(s => s && s.price).slice(0, 6);
  if (withPrice.length) {
    const lines = withPrice.map(s => `• ${s.name} — ${priceText(s)}`).join('\n');
    return `Câteva dintre prețurile noastre:\n${lines}`;
  }
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
  const bits = [phone ? '📞 ' + phone : null, p.email ? '✉️ ' + p.email : null,
    p.facebook ? '📘 ' + p.facebook : null, p.instagram ? '📸 ' + p.instagram : null].filter(Boolean);
  return bits.length ? bits.join('\n') : null;
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

module.exports = { answer, norm };
