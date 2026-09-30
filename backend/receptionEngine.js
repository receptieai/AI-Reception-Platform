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

/**
 * @param {string} message   raw user message (Romanian)
 * @param {object} profile   business profile: { name, phone, emergencyPhone, email, city,
 *                           address, hours, services:[{name,price,duration}], faq:[{question,answer}],
 *                           insurances:[], facilities:[], doctors:[{name,role}], locations:[] }
 * @returns {{reply:string, handled:boolean}}
 */
function answer(message, profile) {
  const t = norm(message);
  const p = profile || {};
  const bizName = p.name || 'clinica';
  const phone = p.phone ? String(p.phone).replace(/[\s.\-]/g, ' ').trim() : null;

  // 1) URGENT — highest priority, always wins
  if (isUrgencyIntent(t)) {
    const em = p.emergencyPhone || (p.locations && p.locations.length > 1 ? null : null) || p.phone;
    const r = `Pentru urgențe sunați imediat la ${em ? em : 'recepția'} — avem medic de gardă 24/7 🚨\nDacă nu puteți suna, veniți direct: ${p.address || 'adresa din site'}.\nVă luăm în primire în cel mai scurt timp.`;
    return { reply: r, handled: true };
  }

  // 2) APPOINTMENT — start intake (widget extracts name+phone as they arrive)
  if (isAppointmentIntent(t)) {
    const lead = detectLead(message);
    const svc = pickService(p, t);
    if (lead.phone && lead.name) {
      const r = `✅ Mulțumesc, ${lead.name}! Solicitarea a fost înregistrată${svc ? ' pentru ' + svc.name : ''}.\nVă vom contacta în maximum 2 ore (în program) pentru a stabili ora exactă. O zi frumoasă! 😊`;
      return { reply: r, handled: true, lead };
    }
    const r = `Bine! Cu plăcere. ${svc ? 'Vă rezervăm: ' + svc.name + '.' : ''}\nPentru a înregistra programarea, scrieți-mi numele și numărul de telefon într-un singur mesaj — de exemplu: \"Ion Popescu 0721234567\" 😊`;
    return { reply: r, handled: true };
  }

  // 3) PRICE — exact service or top list
  const svc = pickService(p, t);
  if (svc && svc.price && isPriceIntent(t)) {
    const r = `${svc.name}: ${priceText(svc)}${svc.duration ? ' · durează ' + svc.duration : ''}.\nDoriți să vă programăm? Scrieți-mi numele și telefonul 😊`;
    return { reply: r, handled: true };
  }
  if (isPriceIntent(t)) {
    const withPrice = (p.services || []).filter(s => s && s.price).slice(0, 8);
    if (withPrice.length) {
      const lines = withPrice.map(s => `• ${s.name} — ${priceText(s)}`).join('\n');
      const r = `Câteva dintre prețurile noastre:\n${lines}\nLista completă e pe site. Pentru programare, scrieți-mi numele și telefonul 😊`;
      return { reply: r, handled: true };
    }
  }

  // 4) HOURS
  if (isHoursIntent(t)) {
    if (p.hours) {
      return { reply: `Programul nostru: ${p.hours}\n${phone ? 'Pentru urgențe: ' + phone + ' (24/7).' : ''}`, handled: true };
    }
  }

  // 5) LOCATION / ACCESS — works with facilities as an OBJECT (scanner shape:
  // {parking:{available,details}}) or as a plain array. Always returns a
  // real answer when address/facilities are known — never falls through.
  if (isLocationIntent(t)) {
    const fac = (p.facilities && typeof p.facilities === 'object' && !Array.isArray(p.facilities)) ? p.facilities : {};
    const det = (k) => fac[k] && fac[k].available !== false ? (fac[k].details ? String(fac[k].details) : 'da') : null;

    if (/parc/.test(t)) {
      const d = det('parking');
      if (d) return { reply: '🚗 Da, avem parcare: ' + d + (p.address ? '\nAdresa: ' + p.address : '.'), handled: true };
    }
    if (/metr|ajung|trajet/i.test(t)) {
      const d = det('metro');
      if (d) return { reply: '🚇 Metrou: ' + d + (p.address ? '\nAdresa: ' + p.address : '.'), handled: true };
    }
    if (/dizab|ramp|invalid/.test(t)) {
      const d = det('disability');
      if (d) return { reply: '♿ Acces pentru persoane cu dizabilități: ' + d + '.', handled: true };
    }

    const bits = [p.address ? `📍 ${p.address}` : null, p.city ? p.city : null,
      Array.isArray(p.facilities) ? p.facilities.filter(f => /parc|metr|acces/i.test(String(f))).slice(0, 2) : []
    ].filter(Boolean);
    if (bits.length) return { reply: bits.join('\n') + (phone ? '\nPentru orientare, sunați la ' + phone + '.' : ''), handled: true };
    // Address genuinely unknown → still answer honestly instead of crashing
    return { reply: 'Ne găsiți la ' + (p.address || 'adresa din secțiunea Contact a site-ului') + (phone ? '. Pentru traseu, sunați la ' + phone + ' 📍' : '.'), handled: true };
  }

  // 5b) PAYMENT — card / rates / cash from the payments object
  {
    const pay = (p.payments && typeof p.payments === 'object') ? p.payments : {};
    if (/\b(card|cardul|visa|mastercard|pos)\b/.test(t) && pay.card && pay.card.available) {
      return { reply: 'Da, acceptăm plata cu card (Visa/Mastercard), numerar și transfer bancar.', handled: true };
    }
    if (/rate/.test(t) && pay.rates && pay.rates.available) {
      return { reply: 'Da, oferim plata în rate' + (pay.rates.provider ? ' prin ' + pay.rates.provider : '') + '.', handled: true };
    }
  }

  // 6) INSURANCE
  if (isInsuranceIntent(t)) {
    const ins = (p.insurances || p.brain && p.brain.insurances || []).filter(Boolean);
    if (ins.length) return { reply: 'Acceptăm: ' + ins.slice(0, 8).join(', ') + '.\nPentru decontare, factura se emite cu datele complete — cu orice întrebare, sunați la ' + (phone || 'recepție') + ' 📞', handled: true };
  }

  // 7) DOCTORS
  if (isDoctorsIntent(t)) {
    const docs = (p.doctors || []).filter(d => d && d.name).slice(0, 6);
    if (docs.length) {
      const lines = docs.map(d => `• ${d.name}${d.role ? ' — ' + d.role : ''}`).join('\n');
      return { reply: `Echipa noastră:\n${lines}\nDoriți programare cu unul dintre ei? Scrieți-mi numele și telefonul 😊`, handled: true };
    }
  }

  // 8) SERVICE LIST
  if (isServiceListIntent(t) && (p.services || []).length) {
    const svcs = p.services.slice(0, 8).map(s => '• ' + s.name).join('\n');
    return { reply: `Ce oferim:\n${svcs}\n${phone ? 'Pentru detalii și programare: ' + phone + ' 📞' : ''}`, handled: true };
  }

  // 9) CONTACT
  if (isContactIntent(t)) {
    const bits = [phone ? '📞 ' + phone : null, p.email ? '✉️ ' + p.email : null,
      p.facebook ? '📘 ' + p.facebook : null, p.instagram ? '📸 ' + p.instagram : null].filter(Boolean);
    if (bits.length) return { reply: bits.join('\n'), handled: true };
  }

  // 10) FAQ match (deterministic before AI)
  if (Array.isArray(p.faq)) {
    for (const f of p.faq) {
      if (!f || !f.question) continue;
      const qn = norm(f.question);
      const words = qn.split(' ').filter(w => w.length > 4);
      let hit = 0;
      for (const w of words) if (t.includes(w)) hit++;
      // small question (≤3 content words): one matching word is enough
      const need = words.length <= 3 ? 1 : 2;
      if (words.length && hit >= need && hit / words.length >= 0.35) {
        return { reply: f.answer, handled: true };
      }
    }
  }

  // 11) Generic greeting / thanks
  if (t.length < 25 && /^(salut|buna|bună|salut|hei|hello|hi|mul[țt]umesc|thanks|ok|da|nu)\b/.test(t)) {
    const svcs = (p.services || []).slice(0, 3).map(s => s.name).join(', ');
    return { reply: `Bună! 👋 Sunt recepționistul virtual al ${bizName}.\nCu ce vă pot ajuta — ${svcs || 'programări, prețuri, program'}?`, handled: true };
  }

  return { reply: null, handled: false };
}

module.exports = { answer, norm };
