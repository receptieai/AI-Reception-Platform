'use strict';

/**
 * RecepAI Smart Prompt Builder
 * ----------------------------
 * Builds the Claude system+user prompt for the "AI Receptionist" layer.
 * Claude is the primary brain for understanding — it handles ANY phrasing
 * naturally. The Business Brain is the ONLY source of facts. The AI must
 * never invent data; if something is missing it says so and offers a lead.
 *
 * This replaces the old "regex for everything" approach: humans ask the same
 * question 50 different ways, and no keyword list covers them all. Claude
 * understands language; the Brain provides the facts.
 */

const { norm } = require('./receptionEngine');

/**
 * Build the system prompt for Claude.
 * @param {object} brain - the Business Brain (profile)
 * @param {object} state - conversation state (what we already know)
 * @param {string} personality - tone preference
 * @returns {{system: string, user: string}}
 */
function buildPrompt(brain, state, personality, conversationHistory) {
  const tones = {
    prietenos: 'prietenos, cald, folosești emoji-uri cu moderație (1-2 pe răspuns)',
    profesionist: 'profesionist, formal, fără emoji',
    elegant: 'elegant, sofisticat, scurt',
    cald: 'foarte empatic, grijuliu, cald',
    dinamic: 'rapid, direct, fără învrtulituri',
  };
  const tone = tones[personality] || tones.prietenos;

  // ── Build the Business Brain context (concise, structured) ──
  const b = brain || {};
  const lines = [];

  if (b.name) lines.push('## AFACERE: ' + b.name + (b.city ? ' — ' + b.city : ''));

  // Contact
  const contactBits = [];
  if (b.phone) contactBits.push('Telefon recepție: ' + b.phone);
  if (b.emergencyPhone && b.emergencyPhone !== b.phone) contactBits.push('Telefon urgențe 24/7: ' + b.emergencyPhone);
  if (b.email) contactBits.push('Email: ' + b.email);
  if (b.address) contactBits.push('Adresă: ' + b.address);
  if (b.city && !b.address) contactBits.push('Oraș: ' + b.city);
  if (contactBits.length) lines.push('\n## CONTACT\n' + contactBits.join('\n'));

  // Hours
  if (b.hours) lines.push('\n## PROGRAM\n' + (typeof b.hours === 'string' ? b.hours : JSON.stringify(b.hours)));

  // Services (the most important data)
  if (Array.isArray(b.services) && b.services.length) {
    const svcs = b.services.slice(0, 30).map(s => {
      let line = '• ' + s.name;
      if (s.price) line += ' — ' + s.price;
      if (s.duration_minutes) line += ' (~' + s.duration_minutes + ' min)';
      return line;
    }).join('\n');
    lines.push('\n## SERVICII ȘI PREȚURI (SINGURA SURSĂ DE ADEVĂR)\n' + svcs);
  }

  // Doctors
  const docs = Array.isArray(b.doctors) ? b.doctors : (Array.isArray(b.brain && b.brain.doctors) ? b.brain.doctors : []);
  if (docs.length) {
    const docsText = docs.slice(0, 10).map(d => '• ' + (d.name || d) + (d.role ? ' — ' + d.role : '')).join('\n');
    lines.push('\n## DOCTORI / ECHIPĂ\n' + docsText);
  }

  // Facilities — from top-level or brain.inferred
  const facSrc = (b.facilities && typeof b.facilities === 'object') ? b.facilities : {};
  const facEntries = Object.entries(facSrc).filter(([k, v]) => v && v.available !== false);
  const brainFac = (b.brain && Array.isArray(b.brain.facilities)) ? b.brain.facilities : [];
  const facLines = facEntries.map(([k, v]) => '• ' + k + ': ' + (v.details || 'da'));
  brainFac.forEach(f => { if (!facLines.some(l => l.includes(f))) facLines.push('• ' + f); });
  if (facLines.length) lines.push('\n## FACILITĂȚI\n' + facLines.join('\n'));

  // Insurance
  const ins = Array.isArray(b.insurances) ? b.insurances : (Array.isArray(b.brain && b.brain.insurances) ? b.brain.insurances : []);
  if (ins.length) {
    lines.push('\n## ASIGURĂRI ACCEPTATE\n' + ins.slice(0, 10).join(', '));
  }

  // Technologies / brands
  const tech = Array.isArray(b.technologies) ? b.technologies : (Array.isArray(b.brain && b.brain.technologies) ? b.brain.technologies : []);
  if (tech.length) {
    lines.push('\n## TEHNOLOGII / MĂRCI (folosite de clinică)\n' + tech.slice(0, 15).join(', '));
  }

  // FAQ
  if (Array.isArray(b.faq) && b.faq.length) {
    const faqText = b.faq.slice(0, 10).map(f => 'Q: ' + f.question + '\nA: ' + (f.answer || 'N/A')).join('\n');
    lines.push('\n## ÎNTREBĂRI FRECVENTE\n' + faqText);
  }

  // Knowledge gaps (what we DON'T know — the AI must be transparent)
  if (Array.isArray(b.knowledge_gaps) && b.knowledge_gaps.length) {
    lines.push('\n## CE NU ȘTIM (spune transparent că clinica va confirma)\n' + b.knowledge_gaps.join(', '));
  }

  const brainContext = lines.join('\n') || '(Fără date — spune pacientului să sune la recepție)';

  // ── Conversation state (what we already know) ──
  const stateContext = state ? [
    state.service ? 'Serviciu: ' + state.service : null,
    state.duration_minutes ? 'Durată: ~' + state.duration_minutes + ' min' : null,
    state.date != null ? 'Data dorită: ' + (typeof state.date === 'number' ? ['azi', 'mâine', 'poimâine'][state.date] || state.date : state.date) : null,
    state.time ? 'Ora dorită: ' + state.time : null,
    state.name ? 'Nume pacient: ' + state.name : null,
    state.phone ? 'Telefon: ' + state.phone : null,
    state.doctor ? 'Doctor dorit: ' + state.doctor : null,
  ].filter(Boolean).join('\n') : '(Conversație nouă)';

  // ── Missing fields (what to ask for next, ONE at a time) ──
  let missingHint = '';
  if (state && (state.intent === 'booking' || isBookingContext(state))) {
    const missing = [];
    if (!state.service) missing.push('serviciul');
    if (!state.name) missing.push('numele');
    if (!state.phone) missing.push('numărul de telefon');
    if (missing.length) {
      missingHint = '\n\nIMPORTANT: Pacientul dorește o programare. Îți lipsește: ' + missing.join(', ') + '. Cere DOAR următorul element lipsă (o singură întrebare). Dacă pacientul a dat deja informația în mesajul curent, NU o mai cere.';
    }
  }

  // ── Build the system prompt ──
  const system = `Ești recepționistul virtual pentru "${b.name || 'clinica'}". Vorbești DOAR în română.

TON: ${tone}
STIL: 1-3 propoziții max. Scurt, clar, natural. Ca o recepționeră bună.

${brainContext}

${stateContext ? '## CE ȘTIM DEJA DESPRE PACIENT\n' + stateContext : ''}
${missingHint}

REGLI ABSOLUTE:
1. Răspunzi EXCLUSIV din datele de mai sus (Business Brain). NU INVENTA prețuri, servicii, program, disponibilitate, medici, asigurări.
2. Dacă o informație NU e în date → spune transparent "Vă recomand să sunați la ${b.phone || 'recepție'} pentru a confirma" și NU inventa.
3. Dacă pacientul întreabă de un preț/serviciu care NU apare în lista de servicii → "Pentru acest serviciu, vă rog sunați la ${b.phone || 'recepție'} pentru preț exact."
4. O ÎNTREBARE pe rând. Niciodată 3 întrebări simultan.
5. NU folosi: "conform bazei de date", "ca AI", "am verificat în sistem", "prețul este de" (fără sursă).
6. Dacă pacientul dă un număr de telefon → reține-l, NU-l repeta înapoi.
7. Programarea e întotdeauna PENDING. Spune "Clinica vă va contacta pentru confirmare." NU "V-ați programat la..."
8. Urgență medicală (sânge, traumă, durere severă) → "Sunați imediat la ${b.emergencyPhone || b.phone || 'recepție'} sau mergeți la urgențe."

EXEMPLE RĂSPUNSURI CORECTE:
- "Cât costă implantul?" → "Implantul costă 2.500 RON (Straumann: 3.500 RON). Doriți să vă programăm?"
- "Aveți parcare?" → "Da, avem parcare gratuită 🚗"
- "Cât durează albirea?" → "Albirea durează ~60 de minute."
- "Ce tehnologii folosiți?" → "Folosim Straumann, MegaGen și design digital al zâmbetului (DSD)."
- "Aveți loc mâine?" → "Pentru disponibilitate exactă, vă rog sunați la ${b.phone || 'recepție'} sau lăsăm o cerere de programare."
- "Vreau programare" → "Sigur! Pentru ce serviciu doriți programarea?"
- "Ce firme/mărci folosiți?" → "Folosim " + (b.technologies && b.technologies.length ? b.technologies.join(', ') : 'ceea ce avem în fișa de mai sus') + "."
- "Acceptați asigurări?" → (dă lista de asigurări din Brain; dacă e goală → "Pentru asigurări, vă rog sunați la " + b.phone + ".")

Exemplu RĂSPUNS GREȘIT (INTERZIS):
- "Da, aveți programare confirmată pentru mâine la 15." (NU — nu confirmi, doar creezi pending)
- "Prețul implantului este 3000 RON." (NU — dacă în Brain e 2500, răspunzi 2500, nu inventezi)`;

  // ── Build the user message (conversation so far) ──
  const history = (conversationHistory || []).map(m =>
    (m.role === 'user' ? 'Pacient' : 'Tu') + ': ' + m.content
  ).join('\n');

  const user = history || '(prima mesajă)';

  return { system, user };
}

function isBookingContext(state) {
  if (!state) return false;
  if (state.intent === 'booking') return true;
  // If we already have 2+ booking fields, we're in a booking flow
  const fields = [state.service, state.name, state.phone].filter(Boolean).length;
  return fields >= 2;
}

module.exports = { buildPrompt };
