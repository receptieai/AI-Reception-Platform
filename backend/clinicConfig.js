/**
 * RecepAI Clinic Configuration Engine v1.0
 * Single source of truth for all clinic settings
 * All modules read from here: AI, Scheduler, Dashboard, Widget
 */

'use strict';

const storage = require('./storage');

const DEFAULTS = {
  // GENERAL
  name: '',
  brand: '',
  description: '',
  industry: 'dental',
  timezone: 'Europe/Bucharest',
  language: 'ro',
  currency: 'RON',

  // CONTACT
  phone: null,
  phone_urgente: null,
  email: null,
  email_programari: null,
  address: null,
  city: null,
  website: null,
  facebook: null,
  instagram: null,

  // CLINIC HOURS
  clinicHours: {
    luni:     { active: true,  open: '08:00', close: '20:00' },
    marti:    { active: true,  open: '08:00', close: '20:00' },
    miercuri: { active: true,  open: '08:00', close: '20:00' },
    joi:      { active: true,  open: '08:00', close: '20:00' },
    vineri:   { active: true,  open: '08:00', close: '20:00' },
    sambata:  { active: true,  open: '09:00', close: '15:00' },
    duminica: { active: false, open: '',      close: ''      },
    urgente:  { active: true,  note: '24/7 la numarul de urgente' },
  },

  // CABINETS
  cabinets: [
    { id: 'cab1', name: 'Cabinet 1 — General', active: true },
    { id: 'cab2', name: 'Cabinet 2 — Chirurgie', active: true },
    { id: 'cab3', name: 'Cabinet 3 — Ortodonție', active: true },
  ],

  // BOOKING SETTINGS
  booking: {
    onlineEnabled: true,
    minNotice: 60,        // minute înainte de programare
    maxAdvance: 60,       // zile în avans
    slotDuration: 30,     // minute per slot
    bufferBetween: 10,    // minute buffer între programări
    lastSlotBefore: 60,   // minute înainte de închidere
    confirmationRequired: true,
    autoConfirm: false,
    cancellationHours: 24,
  },

  // PAYMENT
  payment: {
    cash: true,
    card: true,
    transfer: false,
    financing: null,
    insurance: [],
    advancePercent: 0,
  },

  // FACILITIES
  facilities: {
    parking: null,
    accessibility: false,
    wifi: false,
    children: true,
    languages: ['română'],
  },

  // NOTIFICATIONS
  notifications: {
    smsEnabled: false,
    emailEnabled: true,
    reminderHours: 24,
    confirmationSms: false,
    noShowAlert: true,
  },

  // AI RULES
  aiRules: {
    enabled: true,
    tone: 'prietenos',
    collectName: true,
    collectPhone: true,
    collectService: true,
    noInventPrices: true,
    noMedicalAdvice: true,
    customRules: [],
  },

  // WIDGET
  widget: {
    color: '#00D4AA',
    position: 'dreapta-jos',
    avatar: '🦷',
    greeting: null,
    delay: 4,
  },

  // FEATURE FLAGS
  features: {
    onlineBooking: true,
    aiChat: true,
    sms: false,
    whatsapp: false,
    analytics: true,
    multiClinic: false,
    files: false,
    payments: false,
    loyalty: false,
  },
};

const clinicConfig = {

  // ── GET CONFIG ──
  get(clientId) {
    const settings = storage.getSettings(clientId);
    return this._merge(DEFAULTS, settings);
  },

  // ── SAVE FULL CONFIG ──
  save(clientId, config) {
    storage.saveSettings(clientId, config);
    return this.get(clientId);
  },

  // ── PATCH (partial update) ──
  patch(clientId, partial) {
    const current = storage.getSettings(clientId);
    const updated = this._deepMerge(current, partial);
    storage.saveSettings(clientId, updated);
    return this.get(clientId);
  },

  // ── SECTION GETTERS ──
  getHours(clientId) { return this.get(clientId).clinicHours; },
  getBooking(clientId) { return this.get(clientId).booking; },
  getAiRules(clientId) { return this.get(clientId).aiRules; },
  getCabinets(clientId) { return this.get(clientId).cabinets.filter(c => c.active); },
  getWidget(clientId) { return this.get(clientId).widget; },
  getFeatures(clientId) { return this.get(clientId).features; },
  getNotifications(clientId) { return this.get(clientId).notifications; },

  // ── SECTION PATCHERS ──
  saveHours(clientId, hours) { return this.patch(clientId, { clinicHours: hours }); },
  saveBooking(clientId, booking) { return this.patch(clientId, { booking }); },
  saveAiRules(clientId, aiRules) { return this.patch(clientId, { aiRules }); },
  saveCabinets(clientId, cabinets) { return this.patch(clientId, { cabinets }); },
  saveWidget(clientId, widget) { return this.patch(clientId, { widget }); },
  saveFeatures(clientId, features) { return this.patch(clientId, { features }); },
  saveNotifications(clientId, notifications) { return this.patch(clientId, { notifications }); },

  // ── IS OPEN NOW ──
  isOpenNow(clientId) {
    const hours = this.getHours(clientId);
    const now = new Date();
    const dayNames = ['duminica','luni','marti','miercuri','joi','vineri','sambata'];
    const day = dayNames[now.getDay()];
    const dayHours = hours[day];
    if (!dayHours?.active) return false;
    const [oh, om] = dayHours.open.split(':').map(Number);
    const [ch, cm] = dayHours.close.split(':').map(Number);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const openMin = oh * 60 + om;
    const closeMin = ch * 60 + cm;
    return nowMin >= openMin && nowMin < closeMin;
  },

  // ── GET TODAY HOURS ──
  getTodayHours(clientId) {
    const hours = this.getHours(clientId);
    const dayNames = ['duminica','luni','marti','miercuri','joi','vineri','sambata'];
    const day = dayNames[new Date().getDay()];
    return hours[day] || { active: false };
  },

  // ── IMPORT FROM BRAIN ──
  importFromBrain(clientId, brain) {
    const partial = {};
    if (brain.name) partial.name = brain.name;
    if (brain.phone) partial.phone = brain.phone;
    if (brain.phone_urgente) partial.phone_urgente = brain.phone_urgente;
    if (brain.email) partial.email = brain.email;
    if (brain.city) partial.city = brain.city;
    if (brain.address) partial.address = brain.address;
    if (brain.facebook) partial.facebook = brain.facebook;
    if (brain.instagram) partial.instagram = brain.instagram;
    if (brain.parking) partial.facilities = { parking: brain.parking };
    if (brain.insurance?.length) partial.payment = { insurance: brain.insurance };
    if (brain.financing) partial.payment = { ...partial.payment, financing: brain.financing };
    if (brain.hours) {
      // Parse hours string into structured format
      partial.hoursRaw = brain.hours;
    }
    if (brain.faq?.length) partial.faq = brain.faq;
    if (brain.emergency) partial.emergencyNote = brain.emergency;
    return this.patch(clientId, partial);
  },

  // ── BUILD AI CONTEXT (for chat prompt) ──
  buildAIContext(clientId, brain) {
    const config = this.get(clientId);
    const b = brain || {};
    const isOpen = this.isOpenNow(clientId);
    const todayH = this.getTodayHours(clientId);

    const services = (b.services || [])
      .filter(s => s.name)
      .map(s => `• ${s.name}${s.price ? ': ' + s.price : ''}${s.duration ? ' (' + s.duration + ')' : ''}`)
      .join('\n');

    const faq = (b.faq || config.faq || [])
      .map(f => `Î: ${f.question}\nR: ${f.answer}`)
      .join('\n\n');

    const insurance = (b.insurance || config.payment?.insurance || []).join(', ');

    return `CLINICA: ${config.name || b.name || 'Clinica'}
ORAȘ: ${config.city || b.city || 'România'}
TELEFON RECEPȚIE: ${config.phone || b.phone || 'nedisponibil'}
TELEFON URGENȚE: ${config.phone_urgente || b.phone_urgente || config.phone || 'același număr'}
EMAIL: ${config.email || b.email || 'nedisponibil'}
ADRESĂ: ${config.address || b.address || 'nedisponibilă'}
PARCARE: ${config.facilities?.parking || b.parking || 'verificați la recepție'}
ASIGURĂRI: ${insurance || 'verificați la recepție'}
FINANȚARE: ${b.financing || config.payment?.financing || 'verificați la recepție'}
URGENȚE: ${b.emergency || config.emergencyNote || 'sunați la numărul de urgențe'}
GARANȚII: ${b.guarantees || 'verificați la recepție'}

PROGRAM AZI: ${todayH.active ? todayH.open + ' - ' + todayH.close : 'Închis'}
STATUS: ${isOpen ? 'DESCHIS ACUM' : 'ÎNCHIS ACUM'}
PROGRAM COMPLET: ${config.hoursRaw || b.hours || 'Luni-Vineri 08:00-20:00'}

SERVICII ȘI PREȚURI:
${services || 'Contactați recepția pentru lista completă'}

${faq ? 'ÎNTREBĂRI FRECVENTE:\n' + faq : ''}

REGULI AI:
- Ton: ${config.aiRules?.tone || 'prietenos'}
- NU inventa prețuri sau servicii inexistente
- NU da sfaturi medicale
- Dacă nu știi → "Vă rog sunați la ${config.phone || b.phone || 'recepție'}"
${(config.aiRules?.customRules || []).map(r => '- ' + r).join('\n')}`;
  },

  // ── HELPERS ──
  _merge(defaults, overrides) {
    return this._deepMerge(JSON.parse(JSON.stringify(defaults)), overrides || {});
  },

  _deepMerge(target, source) {
    for (const key of Object.keys(source || {})) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        target[key] = target[key] || {};
        this._deepMerge(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
    return target;
  },
};

module.exports = clinicConfig;
