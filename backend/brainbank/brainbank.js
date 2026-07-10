// ============================================================
// BrainBank v3 — RecepAI Knowledge System
//
// 11 componente:
//   1.  Industry Brain        — cunoștințe per industrie
//   2.  Company Brain         — date specifice clientului
//   3.  Scanner Brain         — wrapping date scanner
//   4.  Knowledge Sources     — proveniență + updatedBy + reason
//   5.  Confidence Brain      — încredere + motiv → ton AI
//   6.  Retrieval Layer       — trimite doar ce e relevant
//   7.  Conversation Brain    — context conversație curentă
//   8.  Business Rules Engine — logică separată de AI (NOU)
//   9.  Appointment Brain     — reguli programări (configurabil)
//   10. Feedback Brain        — analiză post-conversație
//   11. Learning Brain        — recomandări (nu auto-modify)
// ============================================================

const industries = require('./industries');


// ════════════════════════════════════════════════════════════
// 1. INDUSTRY BRAIN
// ════════════════════════════════════════════════════════════

function getIndustryBrain(industryKey) {
  const key = (industryKey || '').toLowerCase().trim();
  if (!key) return { industryKey: 'generic', ...industries.generic };

  const aliases = {
    dental:  ['dental','dentist','stomatolog','stomatologie','cabinet dentar','clinica dentara','ortodontie'],
    vet:     ['vet','veterinar','clinica veterinara','cabinet veterinar','veterinary'],
    beauty:  ['beauty','salon','coafor','frizerie','cosmetica','infrumusetare','spa','manichiura','nail','hair'],
    physio:  ['physio','fizioterapie','kinetoterapie','recuperare','rehab','masaj','physiotherapy'],
    medical: ['medical','clinica','cabinet medical','medic','doctor','policlinica','laborator'],
    fitness: ['fitness','sala','gym','crossfit','yoga','pilates','antrenament'],
    horeca:  ['restaurant','cafenea','bar','pizzerie','fast food','catering','horeca','bistro'],
  };

  let matched = null;
  for (const [ind, kws] of Object.entries(aliases)) {
    if (kws.some(kw => kw === key)) { matched = ind; break; }
  }
  if (!matched) {
    for (const [ind, kws] of Object.entries(aliases)) {
      if (kws.some(kw => key.includes(kw) || (key.length >= 3 && kw.includes(key)))) {
        matched = ind; break;
      }
    }
  }
  if (!matched) matched = 'generic';
  return { industryKey: matched, ...(industries[matched] || industries.generic) };
}


// ════════════════════════════════════════════════════════════
// 2. COMPANY BRAIN
// ════════════════════════════════════════════════════════════

function buildCompanyBrain(companyData) {
  if (!companyData) return '';
  const s = [];

  // resolveValue extrage valoarea din KnowledgeEntry sau din valoare simplă
  const rv = (v) => (v && typeof v === 'object' && 'value' in v) ? v.value : v;

  const name    = rv(companyData.name);
  const city    = rv(companyData.city);
  const address = rv(companyData.address);
  const phone   = rv(companyData.phone);
  const email   = rv(companyData.email);
  const hours   = rv(companyData.hours);

  if (name)    s.push(`Numele afacerii: ${name}`);
  if (city)    s.push(`Orașul: ${city}`);
  if (address) s.push(`Adresa: ${address}`);
  if (phone)   s.push(`Telefon: ${phone}`);
  if (email)   s.push(`Email: ${email}`);

  if (hours) {
    if (typeof hours === 'string') {
      s.push(`Program: ${hours}`);
    } else if (typeof hours === 'object') {
      s.push(`Program:\n${Object.entries(hours).map(([d,h]) => `  ${d}: ${h}`).join('\n')}`);
    }
  }

  const services = rv(companyData.services);
  if (services && services.length > 0) {
    s.push('Servicii:\n' + services.map(sv => {
      let l = `- ${sv.name || sv.service}`;
      if (sv.price) l += ` — ${sv.price}`;
      if (sv.duration) l += ` (${sv.duration})`;
      if (sv.category) l += ` [${sv.category}]`;
      return l;
    }).join('\n'));
  }

  const staff = rv(companyData.staff);
  if (staff && staff.length > 0) {
    s.push('Echipa:\n' + staff.map(st => {
      let l = `- ${st.name}`;
      if (st.role) l += ` — ${st.role}`;
      if (st.specialization) l += ` (${st.specialization})`;
      return l;
    }).join('\n'));
  }

  const faq = rv(companyData.faq);
  if (faq && faq.length > 0) {
    s.push('Întrebări frecvente:\n' + faq.map(f => `Î: ${f.question||f.q}\nR: ${f.answer||f.a}`).join('\n\n'));
  }

  const pol = rv(companyData.policies);
  if (pol) {
    const pl = [];
    if (pol.cancellation) pl.push(`Anulare: ${pol.cancellation}`);
    if (pol.payment)      pl.push(`Plată: ${pol.payment}`);
    if (pol.parking)      pl.push(`Parcare: ${pol.parking}`);
    if (pol.insurance)    pl.push(`Asigurare: ${pol.insurance}`);
    if (pol.other)        pl.push(pol.other);
    if (pl.length) s.push(`Politici:\n${pl.join('\n')}`);
  }

  const soc = [];
  if (companyData.facebook)  soc.push(`Facebook: ${rv(companyData.facebook)}`);
  if (companyData.instagram) soc.push(`Instagram: ${rv(companyData.instagram)}`);
  if (companyData.website)   soc.push(`Website: ${rv(companyData.website)}`);
  if (soc.length) s.push(soc.join('\n'));

  const locs = rv(companyData.locations);
  if (locs && locs.length > 1) {
    s.push('Locații:\n' + locs.map((loc,i) => {
      let l = `${i+1}. ${loc.name||loc.address}`;
      if (loc.phone) l += ` — Tel: ${loc.phone}`;
      if (loc.hours) l += ` — Program: ${loc.hours}`;
      return l;
    }).join('\n'));
  }

  return s.join('\n\n');
}


// ════════════════════════════════════════════════════════════
// 3. SCANNER BRAIN
// ════════════════════════════════════════════════════════════

function wrapScannerData(scanResult) {
  const wrapped = {};
  const fields = ['phone','email','name','city','address','hours','facebook','instagram','services'];

  for (const field of fields) {
    if (scanResult[field] != null && scanResult[field] !== '') {
      const source = scanResult[`${field}_source`] || 'scanner';
      const conf   = scanResult[`${field}_confidence`] || scanResult.fieldConfidence?.[field] || 75;
      const reason = scanResult[`${field}_reason`] || null;
      wrapped[field] = createKnowledge(scanResult[field], source, conf, 'scanner', reason);
    }
  }
  return wrapped;
}


// ════════════════════════════════════════════════════════════
// 4. KNOWLEDGE SOURCES — cu updatedBy și reason
// ════════════════════════════════════════════════════════════

/**
 * @param {*}      value     — valoarea
 * @param {string} source    — 'scanner'|'manual'|'import'|'learning'|'api'|'claude'
 * @param {number} confidence — 0-100
 * @param {string} updatedBy — 'user'|'scanner'|'admin'|'system'
 * @param {string|null} reason — motivul confidence-ului
 */
function createKnowledge(value, source, confidence = 75, updatedBy = 'system', reason = null) {
  return {
    value,
    source,
    confidence: clamp(confidence, 0, 100),
    updatedAt: new Date().toISOString(),
    updatedBy,
    reason,
    version: 1,
    history: [],
  };
}

function updateKnowledge(existing, newValue, source, confidence, updatedBy = 'user', reason = null) {
  if (!existing) return createKnowledge(newValue, source, confidence, updatedBy, reason);

  const history = [...(existing.history || [])];
  history.push({
    value: existing.value,
    source: existing.source,
    confidence: existing.confidence,
    updatedAt: existing.updatedAt,
    updatedBy: existing.updatedBy,
    reason: existing.reason,
    version: existing.version,
  });

  // Limită: ultimele 20 versiuni
  while (history.length > 20) history.shift();

  return {
    value: newValue,
    source,
    confidence: clamp(confidence, 0, 100),
    updatedAt: new Date().toISOString(),
    updatedBy,
    reason,
    version: (existing.version || 1) + 1,
    history,
  };
}

function resolveValue(entry) {
  return (entry && typeof entry === 'object' && 'value' in entry) ? entry.value : entry;
}

function resolveConfidence(entry) {
  return (entry && typeof entry === 'object' && 'confidence' in entry) ? entry.confidence : null;
}

function resolveReason(entry) {
  return (entry && typeof entry === 'object' && 'reason' in entry) ? entry.reason : null;
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }


// ════════════════════════════════════════════════════════════
// 5. CONFIDENCE BRAIN — cu motiv
// ════════════════════════════════════════════════════════════

function calculateGlobalConfidence(companyData) {
  const weights = {
    phone:15, email:10, name:15, city:5,
    hours:10, services:25, prices:15,
    facebook:3, instagram:2,
  };
  let totalW = 0, wSum = 0;
  for (const [field, w] of Object.entries(weights)) {
    const c = resolveConfidence(companyData[field]);
    if (c !== null) { wSum += c * w; totalW += w; }
  }
  return totalW > 0 ? Math.round(wSum / totalW) : 50;
}

/**
 * Generează instrucțiuni de ton + motiv pentru AI
 */
function buildConfidenceInstructions(companyData) {
  const fieldLabels = {
    phone:'telefon', email:'email', hours:'program', services:'servicii',
    address:'adresă', faq:'FAQ', staff:'echipă', policies:'politici',
  };

  const highConf = [], medConf = [], lowConf = [], missing = [];

  for (const [field, label] of Object.entries(fieldLabels)) {
    const data = companyData[field];
    if (!data && data !== 0) { missing.push(label); continue; }

    const conf   = resolveConfidence(data);
    const reason = resolveReason(data);
    const entry  = reason ? `${label} (${reason})` : label;

    if (conf === null)  medConf.push(label);
    else if (conf >= 85) highConf.push(label);
    else if (conf >= 50) medConf.push(entry);
    else                 lowConf.push(entry);
  }

  const lines = [];
  if (highConf.length) lines.push(`Informații confirmate (afirmă cu încredere): ${highConf.join(', ')}.`);
  if (medConf.length)  lines.push(`Informații probabile (formulează cu "din informațiile disponibile..."): ${medConf.join(', ')}.`);
  if (lowConf.length)  lines.push(`Informații nesigure (spune "vă recomand să confirmați telefonic"): ${lowConf.join(', ')}.`);
  if (missing.length)  lines.push(`Informații lipsă (redirecționează către contact direct): ${missing.join(', ')}.`);
  return lines.join('\n');
}


// ════════════════════════════════════════════════════════════
// 6. RETRIEVAL LAYER
// ════════════════════════════════════════════════════════════

function detectRelevantSections(userMessage) {
  const text = (userMessage || '').toLowerCase();
  const relevant = new Set(['identity']);

  const rules = [
    [['pret','preț','cost','tarif','cât costă','cat costa','scump','ieftin','lei','euro','reducere','ofert','pachet','abonament'], ['services','prices']],
    [['servici','fac','ofer','procedur','tratament','consultati','detartraj','implant','albire','tuns','vopsit','manichiur','epilar','vaccin','steriliz','revizie','diagnoz','ecografi','masaj','kineto','fizioter'], ['services']],
    [['program','orar','deschis','închis','inchis','lucr','weekend','sambat','sâmbăt','duminic','luni','marti','marți','miercuri','joi','vineri','dimineata','dimineața','seara'], ['hours']],
    [['telefon','suna','sun','email','mail','contact','whatsapp','facebook','instagram','mesaj'], ['contact']],
    [['programare','programez','rezerv','loc liber','disponibil','slot','când pot','cand pot','mâine','maine','poimâine','săptămâna','saptamana'], ['appointment','hours','services']],
    [['unde','adres','locati','locați','ajung','parcare','harta','map','gps','drum','metro','autobuz','transport'], ['location']],
    [['doctor','medic','specialist','cine','echip','stilist','antreno','fizioterapeut','kinetoterapeu','veterinar','mecanic'], ['staff']],
    [['anulez','anulare','ramburs','garanti','asigurar','cas','plat','card','cash','numerar','transfer','rat'], ['policies']],
    [['urgent','durere','sanger','sânger','umflat','febr','accident','lovit'], ['services','contact','hours']],
    [['intrebare','întrebare','cum','de ce','explicat','despre'], ['faq']],
  ];

  for (const [words, sections] of rules) {
    if (words.some(w => text.includes(w))) {
      sections.forEach(s => relevant.add(s));
    }
  }

  if (relevant.size <= 1) {
    ['services','hours','contact','faq'].forEach(s => relevant.add(s));
  }

  return relevant;
}

function filterCompanyData(companyData, relevantSections) {
  if (!companyData) return {};
  const f = {};

  if (companyData.name)     f.name     = companyData.name;
  if (companyData.city)     f.city     = companyData.city;
  if (companyData.industry) f.industry = companyData.industry;

  const map = {
    contact:  ['phone','email','facebook','instagram','website'],
    hours:    ['hours'],
    services: ['services'],
    prices:   ['services'],
    staff:    ['staff'],
    faq:      ['faq'],
    policies: ['policies'],
    location: ['address','locations'],
  };

  for (const [section, fields] of Object.entries(map)) {
    if (relevantSections.has(section)) {
      for (const field of fields) {
        if (companyData[field]) f[field] = companyData[field];
      }
    }
  }

  if (relevantSections.has('location') && companyData.policies?.parking) {
    f.policies = f.policies || {};
    f.policies.parking = companyData.policies.parking;
  }

  // Telefonul mereu prezent (pentru redirecționare)
  if (companyData.phone && !f.phone) f.phone = companyData.phone;

  return f;
}


// ════════════════════════════════════════════════════════════
// 7. CONVERSATION BRAIN
// ════════════════════════════════════════════════════════════

function buildConversationContext(conversationHistory) {
  if (!conversationHistory || conversationHistory.length === 0) return '';

  const ext = { userName:null, userPhone:null, userEmail:null, requestedService:null, preferredDate:null, preferredTime:null };

  for (const msg of conversationHistory) {
    if (msg.role !== 'user') continue;
    const text = msg.content || '';
    const lower = text.toLowerCase();

    const nm = lower.match(/(?:sunt|ma cheama|numele meu e|mă cheamă)\s+([a-zăâîșț]+(?:\s+[a-zăâîșț]+)?)/i);
    if (nm) ext.userName = nm[1];

    const ph = text.match(/(?:07[\d\s]{8,11}|\+40[\d\s]{9,12}|0[2-3]\d{8})/);
    if (ph) ext.userPhone = ph[0];

    const em = text.match(/[\w.-]+@[\w.-]+\.\w+/);
    if (em) ext.userEmail = em[0];

    const serviceKws = [
      ['detartraj','detartraj'],['implant','implant'],['albire','albire'],
      ['consultati','consultație'],['consult','consultație'],
      ['plomba','plombare'],['extracti','extracție'],
      ['tuns','tuns'],['coaf','coafat'],['vopsit','vopsit'],
      ['manichiur','manichiură'],['pedichiur','pedichiură'],
      ['epilar','epilare'],['masaj','masaj'],
      ['vaccin','vaccinare'],['steriliz','sterilizare'],
      ['revizie','revizie'],['itp','ITP'],
    ];
    for (const [kw, svc] of serviceKws) {
      if (lower.includes(kw)) { ext.requestedService = svc; break; }
    }

    const dm = lower.match(/(?:luni|marti|marți|miercuri|joi|vineri|sambata|sâmbătă|duminica|duminică|maine|mâine|poimaine|poimâine|saptamana viitoare|săptămâna viitoare)/);
    if (dm) ext.preferredDate = dm[0];

    const tm = lower.match(/(?:dimineata|dimineața|dupa-amiaza|după-amiază|seara|ora\s+\d{1,2}(?::\d{2})?|\d{1,2}:\d{2})/);
    if (tm) ext.preferredTime = tm[0];
  }

  const lines = [];
  if (ext.userName) lines.push(`Clientul se numește: ${ext.userName}`);
  if (ext.userPhone) lines.push(`Telefonul clientului: ${ext.userPhone}`);
  if (ext.userEmail) lines.push(`Emailul clientului: ${ext.userEmail}`);
  if (ext.requestedService) lines.push(`Serviciul solicitat: ${ext.requestedService}`);
  if (ext.preferredDate) lines.push(`Ziua preferată: ${ext.preferredDate}`);
  if (ext.preferredTime) lines.push(`Ora preferată: ${ext.preferredTime}`);

  if (lines.length === 0) return '';
  return 'CONTEXT CONVERSAȚIE CURENTĂ:\n' + lines.join('\n') + '\n\nNU repeta întrebări la care clientul a răspuns deja.';
}


// ════════════════════════════════════════════════════════════
// 8. BUSINESS RULES ENGINE (NOU)
//    Logică deterministă, separată de AI
// ════════════════════════════════════════════════════════════

/**
 * O regulă de business:
 * {
 *   id: 'no-sunday',
 *   type: 'schedule'|'service'|'staff'|'priority'|'custom',
 *   condition: { field, operator, value },
 *   action: { type, message },
 *   active: true,
 * }
 */

const DEFAULT_RULES = {
  dental: [
    { id: 'urgent-priority', type: 'priority', condition: { field: 'isUrgency', operator: 'eq', value: true }, action: { type: 'prioritize', message: 'Urgențele au prioritate. Vă rugăm să sunați direct.' }, active: true },
    { id: 'implant-morning', type: 'schedule', condition: { field: 'service', operator: 'eq', value: 'implant' }, action: { type: 'restrict_time', message: 'Implanturile se programează doar dimineața (08:00-12:00).', allowedHours: [8,9,10,11] }, active: true },
    { id: 'no-double-implant', type: 'service', condition: { field: 'service', operator: 'eq', value: 'implant' }, action: { type: 'limit_consecutive', message: 'Nu se programează două implanturi consecutive.', maxConsecutive: 1 }, active: true },
  ],
  vet: [
    { id: 'surgery-morning', type: 'schedule', condition: { field: 'category', operator: 'in', value: ['sterilizare','castrare','chirurgie'] }, action: { type: 'restrict_time', message: 'Chirurgiile se programează doar dimineața (animalul trebuie à jeun).', allowedHours: [8,9,10,11] }, active: true },
    { id: 'surgery-confirm', type: 'service', condition: { field: 'category', operator: 'in', value: ['sterilizare','castrare'] }, action: { type: 'require_confirmation', message: 'Sterilizările necesită confirmare cu 24h înainte.' }, active: true },
  ],
  beauty: [
    { id: 'bridal-advance', type: 'schedule', condition: { field: 'service', operator: 'in', value: ['coafură mireasă','make-up mireasă'] }, action: { type: 'min_advance', message: 'Coafurile de mireasă se programează cu minim 2 săptămâni înainte.', minDays: 14 }, active: true },
  ],
};

/**
 * Evaluează regulile de business pentru un request
 * @param {string} industryKey
 * @param {Array} customRules — regulile specifice clientului
 * @param {Object} context — { service, date, time, isUrgency, category, staff }
 * @returns {{ allowed: boolean, messages: string[], appliedRules: string[] }}
 */
function evaluateBusinessRules(industryKey, customRules, context) {
  const allRules = [
    ...(DEFAULT_RULES[industryKey] || []),
    ...(customRules || []),
  ].filter(r => r.active !== false);

  const result = { allowed: true, messages: [], appliedRules: [] };

  for (const rule of allRules) {
    const matched = matchCondition(rule.condition, context);
    if (!matched) continue;

    result.appliedRules.push(rule.id);

    switch (rule.action.type) {
      case 'block':
        result.allowed = false;
        result.messages.push(rule.action.message);
        break;
      case 'restrict_time':
        if (context.hour != null && !rule.action.allowedHours?.includes(context.hour)) {
          result.allowed = false;
          result.messages.push(rule.action.message);
        } else {
          result.messages.push(rule.action.message);
        }
        break;
      case 'prioritize':
      case 'require_confirmation':
      case 'min_advance':
      case 'full_day':
      case 'limit_consecutive':
        result.messages.push(rule.action.message);
        break;
      default:
        if (rule.action.message) result.messages.push(rule.action.message);
    }
  }

  return result;
}

function matchCondition(condition, context) {
  if (!condition || !condition.field) return false;
  const ctxValue = context[condition.field];
  if (ctxValue === undefined) return false;

  switch (condition.operator) {
    case 'eq':  return ctxValue === condition.value || (typeof ctxValue === 'string' && ctxValue.toLowerCase() === String(condition.value).toLowerCase());
    case 'neq': return ctxValue !== condition.value;
    case 'in':  return Array.isArray(condition.value) && condition.value.some(v => typeof ctxValue === 'string' ? ctxValue.toLowerCase() === v.toLowerCase() : ctxValue === v);
    case 'gt':  return ctxValue > condition.value;
    case 'lt':  return ctxValue < condition.value;
    default:    return false;
  }
}

/**
 * Construiește contextul Business Rules pentru prompt
 */
function buildBusinessRulesContext(industryKey, customRules) {
  const allRules = [
    ...(DEFAULT_RULES[industryKey] || []),
    ...(customRules || []),
  ].filter(r => r.active !== false);

  if (allRules.length === 0) return '';

  const lines = ['REGULI DE BUSINESS (respectă obligatoriu):'];
  for (const rule of allRules) {
    lines.push(`- ${rule.action.message}`);
  }
  return lines.join('\n');
}


// ════════════════════════════════════════════════════════════
// 9. APPOINTMENT BRAIN — configurabil
// ════════════════════════════════════════════════════════════

function buildAppointmentContext(industryKey, companyData) {
  const industryRules = industries[industryKey]?.appointmentRules;
  if (!industryRules) return '';

  const sections = ['REGULI PROGRAMĂRI:'];

  // Durate: industry defaults + company overrides
  const durations = { ...(industryRules.defaultDurations || {}) };

  // Company overrides (configurabile de client fără cod)
  if (companyData?.appointmentRules?.durations) {
    Object.assign(durations, companyData.appointmentRules.durations);
  }

  if (Object.keys(durations).length > 0) {
    sections.push('Durate:');
    for (const [svc, dur] of Object.entries(durations)) {
      const isOverride = companyData?.appointmentRules?.durations?.[svc] != null;
      sections.push(`  ${svc}: ${dur} min${isOverride ? ' (setat de client)' : ''}`);
    }
  }

  // Reguli: industry + company
  const rules = [...(industryRules.rules || [])];
  if (companyData?.appointmentRules?.rules) {
    rules.push(...companyData.appointmentRules.rules);
  }
  if (rules.length > 0) {
    sections.push('\nReguli:');
    rules.forEach(r => sections.push(`- ${r}`));
  }

  // Pauză
  const brk = companyData?.appointmentRules?.breakBetween ?? industryRules.breakBetween;
  if (brk) sections.push(`\nPauză între programări: ${brk} min`);

  // Staff-specific rules
  if (companyData?.appointmentRules?.staffRules) {
    sections.push('\nReguli per specialist:');
    for (const [staffName, staffRules] of Object.entries(companyData.appointmentRules.staffRules)) {
      for (const sr of staffRules) {
        sections.push(`- ${staffName}: ${sr}`);
      }
    }
  }

  return sections.join('\n');
}


// ════════════════════════════════════════════════════════════
// 10. FEEDBACK BRAIN
// ════════════════════════════════════════════════════════════

function analyzeConversation(messages) {
  const a = {
    totalMessages: messages.length,
    userMessages: 0,
    aiMessages: 0,
    questionsAsked: [],
    questionsAnswered: [],
    questionsUnanswered: [],
    leadCollected: false,
    appointmentRequested: false,
    sentiment: 'neutral',
    aiSaidDontKnow: false,
    clientGotFrustrated: false,
    redirectedToPhone: false,
    score: 50,
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const text = (msg.content || '').toLowerCase();

    if (msg.role === 'user') {
      a.userMessages++;
      if (text.includes('?') || text.match(/^(cat|cât|unde|când|cand|ce |cum |de ce|care|aveți|aveti|faceti|faceți|pot |putem)/)) {
        a.questionsAsked.push(msg.content);
      }
      if (text.match(/programare|programez|rezerv|vreau sa vin/)) a.appointmentRequested = true;
      if (text.match(/nu (ma |mă )?ajut|nu (ești|esti) util|prostii|inutil|altcineva|om real|persoana reala/)) {
        a.clientGotFrustrated = true; a.sentiment = 'negative';
      }
      if (text.match(/mulțumesc|multumesc|super|perfect|excelent|genial|minunat|mersi/) && a.sentiment !== 'negative') a.sentiment = 'positive';
    }

    if (msg.role === 'assistant') {
      a.aiMessages++;
      if (text.match(/nu dețin|nu detin|nu am informați|nu pot confirma|va trebui să verific|voi verifica|nu dispun/)) {
        a.aiSaidDontKnow = true;
        if (i > 0 && messages[i-1].role === 'user') a.questionsUnanswered.push(messages[i-1].content);
      } else if (i > 0 && messages[i-1].role === 'user' && a.questionsAsked.includes(messages[i-1].content)) {
        a.questionsAnswered.push(messages[i-1].content);
      }
      if (text.match(/sunați|sunati|apelați|apelati|contactați telefonic/)) a.redirectedToPhone = true;
    }
  }

  const allUser = messages.filter(m => m.role === 'user').map(m => m.content).join(' ');
  a.leadCollected = /07[\d\s]{8,11}|\+40[\d\s]{9,12}/.test(allUser) &&
                    /(?:sunt|ma cheama|mă cheamă)\s+[A-Za-zĂÂÎȘȚăâîșț]/i.test(allUser);

  let score = 50;
  if (a.questionsAnswered.length > 0) score += 15;
  if (a.leadCollected) score += 20;
  if (a.appointmentRequested) score += 5;
  if (a.sentiment === 'positive') score += 10;
  if (a.aiSaidDontKnow) score -= 10;
  if (a.clientGotFrustrated) score -= 25;
  if (a.redirectedToPhone) score -= 5;
  if (a.questionsUnanswered.length > a.questionsAnswered.length) score -= 10;
  a.score = clamp(score, 0, 100);

  return a;
}

function updateFeedbackData(current, analysis) {
  const d = current || {
    totalConversations:0, scores:[], averageScore:0,
    leadsCollected:0, appointmentsRequested:0,
    frustrationCount:0, dontKnowCount:0, redirectCount:0,
    sentimentBreakdown: { positive:0, neutral:0, negative:0 },
  };
  d.totalConversations++;
  d.scores.push(analysis.score);
  if (d.scores.length > 100) d.scores.shift();
  d.averageScore = Math.round(d.scores.reduce((a,b)=>a+b,0) / d.scores.length);
  if (analysis.leadCollected) d.leadsCollected++;
  if (analysis.appointmentRequested) d.appointmentsRequested++;
  if (analysis.clientGotFrustrated) d.frustrationCount++;
  if (analysis.aiSaidDontKnow) d.dontKnowCount++;
  if (analysis.redirectedToPhone) d.redirectCount++;
  d.sentimentBreakdown[analysis.sentiment]++;
  return d;
}


// ════════════════════════════════════════════════════════════
// 11. LEARNING BRAIN — recomandări, NU auto-modify
// ════════════════════════════════════════════════════════════

function buildLearningContext(learningData) {
  if (!learningData) return '';
  const s = [];
  if (learningData.topQuestions?.length > 0) {
    s.push('Întrebări frecvente din conversații anterioare:\n' + learningData.topQuestions.slice(0,10).map(q=>`- ${q}`).join('\n'));
  }
  if (learningData.missingFields?.length > 0) {
    s.push('Informații pe care clienții le cer dar nu sunt disponibile:\n' + learningData.missingFields.slice(0,10).map(f=>`- ${f}`).join('\n'));
  }
  return s.join('\n\n');
}

function updateLearningData(current, conversationAnalysis) {
  const d = current || {
    topQuestions:[], missingFields:[], questionFrequency:{},
    stats: { totalConversations:0, leadsCollected:0, appointmentsRequested:0 },
    // NOU: recomandări care așteaptă aprobare
    pendingRecommendations: [],
  };

  d.stats.totalConversations++;
  if (conversationAnalysis.leadCollected) d.stats.leadsCollected++;
  if (conversationAnalysis.appointmentRequested) d.stats.appointmentsRequested++;

  for (const q of conversationAnalysis.questionsAsked) {
    const n = q.toLowerCase().trim().replace(/[?!.]/g, '');
    d.questionFrequency[n] = (d.questionFrequency[n] || 0) + 1;
  }

  d.topQuestions = Object.entries(d.questionFrequency)
    .sort((a,b)=>b[1]-a[1]).slice(0,20).map(([q])=>q);

  for (const q of (conversationAnalysis.questionsUnanswered || [])) {
    const n = q.toLowerCase().trim();
    if (!d.missingFields.includes(n)) d.missingFields.push(n);
  }
  d.missingFields = d.missingFields.slice(-30);

  return d;
}

/**
 * Generează recomandări de îmbunătățire (NU le aplică automat)
 * Adminul le aprobă/respinge din dashboard
 */
function generateRecommendations(learningData, feedbackData) {
  const recs = [];

  // Recomandare: adaugă informații lipsă
  if (learningData?.missingFields?.length > 0) {
    for (const field of learningData.missingFields.slice(0, 5)) {
      recs.push({
        id: `add-info-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        type: 'add_information',
        priority: 'high',
        description: `Clienții întreabă frecvent: "${field}" — adaugă această informație în BrainBank.`,
        source: 'learning',
        status: 'pending', // pending | approved | rejected
        createdAt: new Date().toISOString(),
      });
    }
  }

  // Recomandare: adaugă FAQ-uri din top întrebări
  if (learningData?.topQuestions?.length >= 3) {
    recs.push({
      id: `add-faq-${Date.now()}`,
      type: 'add_faq',
      priority: 'medium',
      description: `Cele mai frecvente întrebări: ${learningData.topQuestions.slice(0,3).join(', ')}. Adaugă răspunsuri în FAQ.`,
      data: learningData.topQuestions.slice(0, 5),
      source: 'learning',
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  }

  // Recomandare: îmbunătățire dacă scorul e scăzut
  if (feedbackData?.averageScore != null && feedbackData.averageScore < 50) {
    recs.push({
      id: `improve-quality-${Date.now()}`,
      type: 'improve_quality',
      priority: 'critical',
      description: `Scorul mediu al conversațiilor este ${feedbackData.averageScore}/100. Verifică informațiile lipsă și actualizează BrainBank.`,
      source: 'feedback',
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  }

  // Recomandare: prea multe redirecționări la telefon
  if (feedbackData && feedbackData.totalConversations >= 5) {
    const redirectRate = feedbackData.redirectCount / feedbackData.totalConversations;
    if (redirectRate > 0.3) {
      recs.push({
        id: `reduce-redirects-${Date.now()}`,
        type: 'reduce_redirects',
        priority: 'high',
        description: `${Math.round(redirectRate*100)}% din conversații sunt redirecționate la telefon. Adaugă mai multe informații pentru a reduce această rată.`,
        source: 'feedback',
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
    }
  }

  // Recomandare: frustrare frecventă
  if (feedbackData && feedbackData.totalConversations >= 5) {
    const frustrationRate = feedbackData.frustrationCount / feedbackData.totalConversations;
    if (frustrationRate > 0.15) {
      recs.push({
        id: `reduce-frustration-${Date.now()}`,
        type: 'reduce_frustration',
        priority: 'critical',
        description: `${Math.round(frustrationRate*100)}% din conversații au clienți frustrați. Revizuiește răspunsurile AI și completează informațiile lipsă.`,
        source: 'feedback',
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
    }
  }

  return recs;
}


// ════════════════════════════════════════════════════════════
// MAIN: generateSystemPrompt
// ════════════════════════════════════════════════════════════

function generateSystemPrompt({
  industry = null,
  companyData = null,
  conversationHistory = [],
  learningData = null,
  includeAppointments = false,
  userMessage = null,
  businessRules = null, // regulile custom ale clientului
} = {}) {

  const industryBrain = getIndustryBrain(industry || companyData?.industry || 'generic');

  // Retrieval Layer
  let filteredCompanyData = companyData;
  if (userMessage && companyData && conversationHistory.length >= 4) {
    const relevant = detectRelevantSections(userMessage);
    filteredCompanyData = filterCompanyData(companyData, relevant);
  }

  const companyContext = buildCompanyBrain(filteredCompanyData);
  const confidenceInstructions = buildConfidenceInstructions(companyData || {});
  const learningContext = buildLearningContext(learningData);
  const conversationContext = buildConversationContext(conversationHistory);
  const businessRulesContext = buildBusinessRulesContext(industryBrain.industryKey, businessRules);
  const appointmentContext = includeAppointments ? buildAppointmentContext(industryBrain.industryKey, companyData) : '';

  // Time awareness
  const now = new Date();
  const hour = now.getHours();
  const timeGreeting = hour >= 6 && hour < 12 ? 'Bună dimineața' : hour < 18 ? 'Bună ziua' : 'Bună seara';
  const dayNames = ['duminică','luni','marți','miercuri','joi','vineri','sâmbătă'];
  const currentDay = dayNames[now.getDay()];
  const currentTime = `${hour}:${String(now.getMinutes()).padStart(2,'0')}`;

  // Asamblare
  const p = [];

  p.push(`Ești recepționistul AI al ${resolveValue(filteredCompanyData?.name) || 'cabinetului'}. Vorbești în limba română, natural și profesional.`);
  p.push(`Salutul potrivit acum: "${timeGreeting}". Este ${currentDay}, ora ${currentTime}.`);

  if (industryBrain.systemContext) {
    p.push('\n--- CUNOȘTINȚE INDUSTRIE ---');
    p.push(industryBrain.systemContext);
  }
  if (industryBrain.tone) p.push(`\nTonul conversației: ${industryBrain.tone}`);
  if (industryBrain.neverSay?.length) {
    p.push('\nNU spune niciodată:');
    industryBrain.neverSay.forEach(n => p.push(`- ${n}`));
  }
  if (industryBrain.alwaysDo?.length) {
    p.push('\nFĂ ÎNTOTDEAUNA:');
    industryBrain.alwaysDo.forEach(a => p.push(`- ${a}`));
  }
  if (industryBrain.triageQuestions?.length) {
    p.push('\nÎntrebări de triaj (când e relevant):');
    industryBrain.triageQuestions.forEach(q => p.push(`- ${q}`));
  }

  if (companyContext) { p.push('\n--- INFORMAȚII AFACERE ---'); p.push(companyContext); }
  if (confidenceInstructions) { p.push('\n--- NIVEL ÎNCREDERE ---'); p.push(confidenceInstructions); }
  if (businessRulesContext) { p.push('\n--- ' + businessRulesContext); }
  if (learningContext) { p.push('\n--- CUNOȘTINȚE ACUMULATE ---'); p.push(learningContext); }
  if (conversationContext) { p.push('\n--- CONTEXT CONVERSAȚIE ---'); p.push(conversationContext); }
  if (appointmentContext) { p.push('\n--- PROGRAMĂRI ---'); p.push(appointmentContext); }

  p.push('\n--- REGULI GENERALE ---');
  p.push('- Răspunde ÎNTÂI la întrebarea clientului, apoi colectează date dacă e necesar.');
  p.push('- Nu inventa informații. Dacă nu știi, spune că vei verifica.');
  p.push('- Fii concis dar complet.');
  p.push('- Dacă clientul dă NUME + TELEFON, ai colectat un lead. Confirmă-l natural.');
  p.push('- Nu folosi markdown excesiv.');
  p.push('- Adaptează-ți tonul la nivelul de încredere al informațiilor.');
  p.push('- Respectă regulile de business obligatoriu (nu le poți ignora).');

  return p.join('\n');
}


// ════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════

module.exports = {
  generateSystemPrompt,
  getIndustryBrain,
  buildCompanyBrain,
  wrapScannerData,
  createKnowledge, updateKnowledge, resolveValue, resolveConfidence, resolveReason,
  calculateGlobalConfidence, buildConfidenceInstructions,
  detectRelevantSections, filterCompanyData,
  buildConversationContext,
  evaluateBusinessRules, buildBusinessRulesContext, DEFAULT_RULES,
  buildAppointmentContext,
  analyzeConversation, updateFeedbackData,
  buildLearningContext, updateLearningData, generateRecommendations,
};
