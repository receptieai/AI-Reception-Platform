'use strict';

/**
 * RecepAI Conversation State Manager
 * ----------------------------------
 * The layer that turns a chatbot into an AI receptionist. It keeps a
 * per-conversation state so the AI NEVER asks for information the patient
 * already gave, asks exactly ONE thing at a time, answers info questions
 * inline while a booking is in progress, and creates a PENDING appointment
 * the moment the required fields are collected.
 *
 * This is backend code (not prompt logic) by design — the Business Brain is
 * the source of truth and the state is authoritative between turns.
 */

const { norm, infoAnswer, matchService } = require('./receptionEngine');

// In-memory store. V1 is single-instance; can be moved to Supabase later
// without changing the API (the plan explicitly keeps state swappable).
const CONVERSATIONS = new Map();

const REQUIRED = ['service', 'name', 'phone'];
const OPTIONAL = ['date', 'time'];

// ── ENTITY EXTRACTION (this message only) ─────────────────────────
const RO_DAYS = {
  'azi': 0, 'maine': 1, 'poimaine': 2, 'poimâine': 2,
  'luni': 1, 'marti': 2, 'miercuri': 3, 'joi': 4, 'vineri': 5, 'vinert': 5,
  'sambata': 6, 'sambata': 6,
};

function extractEntities(msg, opts = {}) {
  const raw = msg || '';
  const t = norm(raw);
  const out = {};

  // Phone — RO mobile variants, separators allowed.
  const phoneMatch = raw.match(/(\+?40|0040|0)?\s?7\d(?:[\s.\-]?\d){7,8}/);
  if (phoneMatch) out.phone = phoneMatch[0].replace(/[^\d+]/g, '');

  // Name — explicit trigger phrase ("mă numesc", "numele meu este", "im nume").
  const trigger = raw.match(/(?:m[ăa] numesc|numele (?:meu )?(?:e|este)|im? nume|numele meu)\s+([A-Za-zĂÂÎȘțăâîș]{1,}(?:[ ]+[A-Za-zĂÂÎȘțăâîș]{1,})?)/i);
  if (trigger) out.name = titleName(trigger[1].trim());

  // Name glued right before a phone — case-insensitive, so "ion maria
  // 0722345678" and "Ion Popescu 0721234567" are both captured. This is the
  // most common way patients reply to "cum vă numiți + telefon".
  if (out.phone && !out.name && phoneMatch && phoneMatch.index != null) {
    const before = raw.slice(0, phoneMatch.index);
    const name = nameFromBefore(before);
    if (name) out.name = titleName(name);
  }

  // Bare-name fallback: the AI just asked "Cum vă numiți?" and the patient
  // replied with only their name ("Ion Popescu"). Capture 1-2 capitalized
  // words with no digits, when a name is expected and no phone/name found.
  if (!out.name && !out.phone && opts.expectName) {
    const bare = bareName(raw);
    if (bare) out.name = titleName(bare);
  }

  // Relative date.
  for (const [word, offset] of Object.entries(RO_DAYS)) {
    if (t.includes(word)) { out.date = offset; break; }
  }

  // Time — "orei 15", "la ora 15:30", "pe la 15", "in jur de 15:00", "la 15".
  const timeM = raw.match(/\b(?:la (?:ora |orei )?|pe (?:la )?|in jur de|dup[ae] ora|ora)\s*(\d{1,2}(?::\d{2})?)\b/i);
  if (timeM) out.time = timeM[1];
  else if (opts.expectTime && /^\d{1,2}(:\d{2})?$/.test(raw.trim())) out.time = raw.trim();

  return out;
}

// Words that are never part of a person's name (prepositions / booking words),
// so "da vreau maine la ion maria 0722..." does not swallow "la" / "vreau".
// Only true prepositions/booking words — NOT doctor names, so "la Elena
// Popescu 0722" still yields the name "Elena Popescu".
const NAME_STOP = new Set([
  'buna', 'bună', 'salut', 'hei', 'hello', 'da', 'nu', 'ok', 'da', 'vreau',
  'as', 'as', 'a', 'sa', 'sa', 'im', 'imi', 'im', 'maine', 'azi', 'poimaine',
  'luni', 'marti', 'marti', 'miercuri', 'joi', 'vineri', 'sambata', 'sambata',
  'la', 'pe', 'ora', 'orei', 'in', 'jur', 'de', 'dupa', 'după', 'si', 'si',
  'am', 'am', 'eu', 'imi', 'imi', 'ma', 'ma', 'vreau', 'programez', 'programare',
  'programa', 'programari', 'implant', 'implanturi', 'albire', 'detartraj',
  'consultat', 'consultație', 'serviciu', 'servicii', 'dre', 'dr', 'doctor',
  'medic',
]);

// "vreau programare la Elena Popescu" — capture the doctor the patient names.
// The AI records this so the appointment note can carry it, and the answer
// can reflect it ("programarea la Dr. Elena Popescu"). Best-effort: only in
// a booking context, and only when there is no phone number in the message
// (a glued name+phone means the patient is giving their OWN name).
function extractDoctor(raw, profile, booking) {
  if (!booking) return null;
  if (/\d{10}/.test(raw)) return null; // glued name+phone = the patient's name
  const docs = (profile.doctors || []).map(d => d && d.name).filter(Boolean);
  for (const dn of docs) {
    if (norm(raw).includes(norm(dn).split(' ').slice(-1)[0])) return dn; // by last name
  }
  const m = raw.match(/\bla\s+((?:dr\.?\s+)?[A-ZĂÂÎȘȚ][a-zăâîșț]{2,}(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț]{2,})?)/);
  if (m) return m[1].trim();
  return null;
}

// Take the last 1-2 name-like words immediately preceding the phone number,
// skipping over stop-words (prepositions, days, booking words) and bare time
// tokens ("3", "15", "15:30"). So "maria ion ora 3 maine 0723456678" yields
// "maria ion" — the "ora 3" clock and "maine" no longer block the name — while
// "da vreau maine la 15" (no name) still yields nothing.
function nameFromBefore(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const cand = [];
  for (let i = words.length - 1; i >= 0 && cand.length < 2; i--) {
    const w = words[i];
    // Bare time tokens ("3", "15", "15:30") — skip, do not break.
    if (/^[0-9:]{1,5}$/.test(w)) continue;
    // Stop-words (la / pe / maine / programare / etc.) — skip, do not break.
    if (NAME_STOP.has(w.toLowerCase())) continue;
    // A name-like word (letters only) — keep it.
    if (/^[A-Za-zĂÂÎȘțăâîș]{2,20}$/.test(w)) { cand.unshift(w); continue; }
    // Anything else (stray punctuation token) — stop.
    break;
  }
  return cand.length ? cand.join(' ') : null;
}

// Title-case a captured name: "ion maria" -> "Ion Maria".
function titleName(s) {
  return String(s || '').split(/\s+/).map(w =>
    w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w
  ).join(' ');
}

// A "bare name" is 1-2 words, each starting with an uppercase Latin letter,
// 2+ chars, no digits — e.g. "Ion Popescu" or "Ana". Rejected: "buna",
// "mâine", "15", "implant".
function bareName(raw) {
  const s = String(raw || '').trim();
  if (!s || /\d/.test(s)) return null;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 2) return null;
  const ok = words.every(w => /^[A-ZĂÂÎȘȚ][a-zăâîșț]{1,20}$/.test(w));
  if (!ok) return null;
  if (words.every(w => NAME_STOP.has(w.toLowerCase()))) return null;
  return s;
}

function humanDate(offsetOrDate) {
  if (typeof offsetOrDate === 'number') {
    const names = ['azi', 'mâine', 'poimâine', 'luni', 'marți', 'miercuri', 'joi', 'vineri', 'sâmbătă'];
    return names[offsetOrDate] || String(offsetOrDate);
  }
  return String(offsetOrDate);
}

// ── STATE MACHINE ─────────────────────────────────────────────────
function getOrCreate(conversationId) {
  if (!CONVERSATIONS.has(conversationId)) {
    CONVERSATIONS.set(conversationId, {
      conversationId,
      intent: null,
      service: null,
      serviceId: null,
      duration_minutes: null,
      date: null,
      time: null,
      name: null,
      phone: null,
      provided: {},
      lead_status: null,
      created_at: new Date().toISOString(),
    });
  }
  return CONVERSATIONS.get(conversationId);
}

function isBookingIntent(t) {
  const explicit = /\b(program|programare|programat|programaza|programez|programam|programeaz|rezerv|rezervare|apoi la|dorim|a(v|s) vrea|inregistrat|apointment|book)\b/.test(t);
  const wantsSlot = /\b(aveti (loc|liber)|aveti liber|e liber|este liber|loc (liber|liber)|slot|disponibil|aveti timp|putem)\b/.test(t);
  // "vreau maine la 15" — wants something at a time, even without "program".
  const wantsAtTime = /\bvreau\b/.test(t) && /\b(azi|maine|poimaine|luni|marti|miercuri|joi|vineri|sambata|sambata|ora|orei|pe la|la \d)\b/.test(t);
  return explicit || wantsSlot || wantsAtTime;
}

// Has a booking intent been established in THIS conversation (current message
// or earlier state)? Used to gate the bare-name/time extraction fallbacks.
function bookingIntentEver(t, state) {
  return isBookingIntent(t) || state.intent === 'booking';
}

// Ask for the NEXT required field that is still missing, one at a time.
function nextQuestion(state) {
  if (!state.service) {
    return 'Sigur, cu plăcere! Pentru ce serviciu doriți programarea?';
  }
  if (!state.name) {
    return `Perfect — ${state.service}. Cum vă numiți?`;
  }
  if (!state.phone) {
    return 'Mulțumesc, ' + state.name + '! Care este numărul dvs. de telefon?';
  }
  return null;
}

function describeBooking(state) {
  let s = state.service || 'programare';
  if (state.date != null) s += ' ' + humanDate(state.date);
  if (state.time) s += ' la ' + state.time;
  return s;
}

/**
 * processMessage(conversationId, message, profile, ctx)
 *  - ctx: { createLead }  optional callback the server injects to persist
 *    the lead/appointment (keeps this module transport-agnostic).
 * Returns { reply, state, appointment? , answeredInfo? }
 */
function processMessage(conversationId, message, profile, ctx = {}) {
  const t = norm(message);
  const state = getOrCreate(conversationId);
  if (state.doctor === undefined) state.doctor = null; // doctor preference (V1)

  // If the booking is ALREADY DONE (lead_status='done') and the patient is
  // asking a follow-up question (price, duration, "la ce doctor am
  // programarea"), fall through to the normal info engine — do NOT trap
  // them in booking mode. Only re-enter booking logic if the message itself
  // contains a NEW phone number (a different patient starting a new booking).
  if (state.lead_status === 'done' && !/\d{10}/.test(message || '')) {
    // Answer info questions normally (price, duration, doctors, etc.)
    const info = infoAnswer(message, profile);
    if (info) return { reply: info, state };
    // "la ce doctor am programarea?" — answer from state
    if (/la ce doctor|care doctor|ce doctor|doctor/.test(t) && state.service) {
      return { reply: 'Programarea dumneavoastră este pentru ' + (state.service || 'serviciu nespecificat') + (state.date != null ? ' ' + humanDate(state.date) : '') + (state.time ? ' la ' + state.time : '') + '. Clinica vă va contacta pentru a confirma doctorul.', state };
    }
    // Nothing recognized — fall through to the LLM.
    return { reply: null, state, handled: false };
  }

  // 1) Pull any entities the patient just gave (service/date/time/name/phone).
  // expectName/expectTime let the bare-name / bare-time fallbacks fire only
  // when the patient is answering that exact question.
  const ent = extractEntities(message, {
    expectName: bookingIntentEver(t, state) && !state.name,
    expectTime: bookingIntentEver(t, state) && !state.time,
  });

  // Map free-form service wording onto the profile (gets price + duration).
  // Only auto-detect the service when we're actually in a booking context, so
  // a plain info question ("ce firme de implanturi aveti?") does not leak a
  // service into the booking state.
  if (ent.service === undefined && (isBookingIntent(t) || state.intent === 'booking')) {
    const svc = matchService(message, profile);
    if (svc) {
      state.service = svc.name;
      state.serviceId = svc.id || null;
      state.duration_minutes = svc.duration_minutes || state.duration_minutes || 30;
      state.provided.service = true;
    }
  }

  if (ent.name && !state.name) { state.name = ent.name; state.provided.name = true; }
  if (ent.phone && !state.phone) { state.phone = ent.phone; state.provided.phone = true; }
  if (ent.date !== undefined && state.date == null) { state.date = ent.date; state.provided.date = true; }
  if (ent.time !== undefined && state.time == null) { state.time = ent.time; state.provided.time = true; }

  // Doctor preference ("vreau programare la Dr. Elena ...") — recorded so the
  // booking note carries it and the confirmation can reference it.
  const doc = extractDoctor(message, profile, isBookingIntent(t) || state.intent === 'booking');
  if (doc && !state.doctor) state.doctor = doc;

  // 2) Is there a booking intent now (ever) in this conversation?
  const booking = isBookingIntent(t) || state.intent === 'booking';
  if (booking) state.intent = 'booking';

  // 3) Answer any info question inline (price/hours/location/etc), even while
  //    a booking is in progress.
  const info = infoAnswer(message, profile);

  if (booking) {
    // Required collected? -> create the PENDING appointment + confirm.
    const hasAll = state.service && state.name && state.phone;
    if (hasAll && state.lead_status !== 'done') {
      state.lead_status = 'done';
      const appointment = {
        clientId: profile?.clientId || null,
        status: 'pending',
        source: 'chat',
        service: { name: state.service, duration_minutes: state.duration_minutes || 30 },
        patient: { name: state.name, phone: state.phone },
        date: state.date != null ? (typeof state.date === 'number' ? humanDate(state.date) : state.date) : null,
        slot: state.time || null,
        duration_minutes: state.duration_minutes || 30,
        createdAt: new Date().toISOString(),
      };
      if (ctx.createLead) { try { ctx.createLead(appointment, state); } catch (e) { } }
      const bits = [];
      if (info) bits.push(info);
      const docTxt = state.doctor ? ' la ' + state.doctor : '';
      bits.push(`✅ Mulțumesc, ${state.name}! Am înregistrat solicitarea pentru ${describeBooking(state)}${docTxt}.` +
        (state.duration_minutes ? ` (durează ~${state.duration_minutes} min)` : '') +
        '\nClinica vă va contacta în curând pentru a confirma ora exactă. O zi frumoasă! 😊');
      return { reply: bits.join('\n\n'), state, appointment };
    }

    // Not complete yet -> answer info (if any) + ask the ONE next thing.
    const q = nextQuestion(state);
    const bits = [];
    if (info) bits.push(info);
    if (q) bits.push(q);
    if (!bits.length) bits.push('Pentru a continua programarea, spuneți-mi serviciul, numele și numărul de telefon 😊');
    return { reply: bits.join('\n\n'), state };
  }

  // 4) No booking intent — just an info question (or small talk).
  if (info) {
    return { reply: info, state };
  }

  // 5) Nothing recognized — let the caller fall through to the LLM.
  return { reply: null, state, handled: false };
}

function getState(conversationId) {
  return CONVERSATIONS.get(conversationId) || null;
}

// Basic cleanup to avoid unbounded growth on long-lived single instances.
const MAX_CONVERSATIONS = 5000;
function maybePrune() {
  if (CONVERSATIONS.size > MAX_CONVERSATIONS) {
    const it = CONVERSATIONS.keys();
    for (let i = 0; i < CONVERSATIONS.size - MAX_CONVERSATIONS; i++) CONVERSATIONS.delete(it.next().value);
  }
}

module.exports = { processMessage, getState, getOrCreate, extractEntities, _internals: { REQUIRED, CONVERSATIONS, maybePrune } };
