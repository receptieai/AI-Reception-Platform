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
// Day-of-week words. POIMINE must be checked BEFORE MAINE because the
// Romanian word "poimâine" contains "mâine" — a plain substring scan would
// wrongly report "mâine" for "poimâine".
const RO_DAYS = [
  ['poimaine', 2], ['poimâine', 2], ['poimane', 2], ['poimaine', 2],
  ['luni', 1], ['marti', 2], ['marți', 2], ['miercuri', 3], ['joi', 4],
  ['vineri', 5], ['sambata', 6], ['sâmbătă', 6], ['duminica', 0],
  ['azi', 0], ['maine', 1], ['mâine', 1],
];

// Pick the day word the patient means. When several day words appear (e.g.
// "anuleaza maine la 3 vreau poimaine la 16"), the LAST one wins — it is the
// new requested day. Returns the offset, or null.
function extractDay(t) {
  const msg = String(t || '');
  let best = { offset: null, index: -1 };
  for (const [word, offset] of RO_DAYS) {
    const idx = msg.lastIndexOf(word);
    if (idx >= 0 && idx > best.index) best = { offset, index: idx };
  }
  return best.offset;
}

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
  // replied with their name. Two strategies:
  //   1. Strict: whole message is 1-2 uppercase words ("Ion Popescu", "Ana").
  //   2. Loose: message is name + date/time words, no booking verbs
  //      ("ion maria ora 3 maine"). Only runs when the message does NOT
  //      contain booking-intent words (so "vreau programare pt extractie"
  //      is never mistaken for a name).
  if (!out.name && !out.phone && opts.expectName) {
    const bare = bareName(raw);
    if (bare) {
      out.name = titleName(bare);
    } else if (!opts.isBookingMessage) {
      const loose = extractNameLoose(raw);
      if (loose) out.name = titleName(loose);
    }
  }

  // Relative date — via extractDay() so "poimâine" is not misread as "mâine".
  const day = extractDay(t);
  if (day !== null) out.date = day;

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

// A looser name finder for the case where the patient answers "Cum vă numiți?"
// with their name mixed in with date/time/other words and NO phone number —
// e.g. "ion maria ora 3 maine". We collect up to 2 consecutive letters-only,
// non-stop, non-digit words (skipping digits and stop-words). "da vreau maine
// la 15" (no real name) still yields nothing because every word is a stop-word.
function extractNameLoose(raw) {
  const words = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const found = [];
  for (const w of words) {
    if (/^[0-9:]{1,5}$/.test(w)) continue; // digits / time — skip, don't break
    if (NAME_STOP.has(w.toLowerCase())) continue; // la / maine / programare / etc.
    if (/^[A-Za-zĂÂÎȘțăâîș]{2,20}$/.test(w)) {
      found.push(w);
      if (found.length === 2) break;
    }
  }
  return found.length ? found.join(' ') : null;
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

// "poimaine la 16" — find the time anchored AFTER a specific position in the
// message. Used by the reschedule handler to distinguish "anulează maine la 3
// vreau poimâine la 16" (take 16, not 3).
function timeAfter(msg, pos) {
  const rest = String(msg || '').slice(pos || 0);
  const m = rest.match(/\b(?:la|ora|orei|pe la|in jur de|dup[ae] ora)?\s*(\d{1,2})(?::\d{2})?\b/i);
  if (m) return m[1];
  // Unanchored fallback: any "la N" in the whole message.
  const m2 = String(msg || '').match(/\b(?:la|ora|orei)\s*(\d{1,2}(?::\d{2})?)\b/i);
  return m2 ? m2[1] : null;
}

// Find the LAST occurrence of any day-word in the message. The message is
// diacritic-normalized first so "poimâine"/"poimaine"/"poimâne" all match.
// Returns { word, offset, index } — so "anuleaza maine la 3 vreau poimaine
// la 16" yields the LAST day word (poimaine) and its char position, letting
// us anchor the new time AFTER that word (16, not the old 3).
function lastDayWord(msg) {
  const lower = norm(String(msg || '')).toLowerCase();
  let best = { word: null, offset: null, index: -1 };
  for (const [word, offset] of RO_DAYS) {
    const idx = lower.lastIndexOf(word);
    if (idx >= 0 && idx > best.index) {
      best = { word, offset, index: idx };
    }
  }
  return best;
}

// Does the message ask to cancel ("anulează", "anulez", "nu mai pot")?
function isCancelIntent(t) {
  return /anul|nu mai pot|renunt|renunț/.test(t);
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
  if (state.lead_status === 'done') {
    // ── RESCHEDULE / CANCEL ─────────────────────────────────────────
    // "anulează maine la 3, vreau poimâine la 16" — patient wants to change
    // the booking. The NEW day+time are anchored to the LAST day word in the
    // message (poimâine), so the time taken is the one AFTER that word (16),
    // not the old one (3). We keep service/name/phone and create a NEW
    // pending appointment the clinic can confirm.
    //
    // Everything here is done in diacritic-normalized space so index
    // positions stay consistent between the day-word lookup and the
    // time-after lookup.
    const cancelIntent = isCancelIntent(t);
    const normMsg = t; // already norm(message)
    const day = lastDayWord(normMsg);
    const newDate = day.offset;                       // offset or null
    const newTime = timeAfter(normMsg, day.index >= 0 ? day.index : 0);

    if (cancelIntent && (newDate !== null || newTime)) {
      if (newDate !== null) state.date = newDate;
      if (newTime) state.time = newTime;
      const appointment = {
        id: 'appt_' + Date.now() + '_resched',
        clientId: profile?.clientId || null,
        status: 'pending',
        source: 'chat',
        service: { name: state.service, duration_minutes: state.duration_minutes || 30 },
        patient: { name: state.name, phone: state.phone },
        doctor: state.doctor || null,
        date: state.date != null ? humanDate(state.date) : null,
        slot: state.time || null,
        duration_minutes: state.duration_minutes || 30,
        createdAt: new Date().toISOString(),
        rescheduleOf: state.lastApptId || null,
      };
      if (ctx.createLead) { try { ctx.createLead(appointment, state); } catch (e) { } }
      state.lead_status = 'done';
      state.lastApptId = appointment.id;
      state.lastShownDate = appointment.date;
      state.lastShownTime = appointment.slot;
      const when = (state.date != null ? humanDate(state.date) : '') + (state.time ? ' la ' + state.time : '');
      return {
        reply: `✅ Mulțumesc, ${state.name}! Am mutat programarea pentru ${state.service} ${when}.` +
          (state.duration_minutes ? ` (durează ~${state.duration_minutes} min)` : '') +
          '\nClinica vă va contacta pentru a confirma ora nouă. O zi frumoasă! 😊',
        state, appointment,
      };
    }

    // Normal follow-up (info question, doctor, etc.)
    const info = infoAnswer(message, profile);
    if (info) return { reply: info, state };
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
    isBookingMessage: isBookingIntent(t),
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
      const apptId = 'appt_' + Date.now();
      const appointment = {
        id: apptId,
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
      // Remember this appointment so a later "anulează / vreau altă zi" can
      // reference it (reschedule) and so "la ce doctor am programarea" works.
      state.lastApptId = appointment.id;
      state.lastShownDate = appointment.date;
      state.lastShownTime = appointment.slot;
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
