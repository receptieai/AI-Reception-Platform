/**
 * RecepAI Storage Engine v1.0
 * Single source of truth for all data persistence
 * API-compatible: swap implementation for PostgreSQL/Supabase without changing callers
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');

// ── ENSURE DATA DIR ──
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── GENERIC FILE OPS ──
function loadFile(filename, defaultVal = {}) {
  const file = path.join(DATA_DIR, filename);
  try {
    if (!fs.existsSync(file)) return defaultVal;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch(e) {
    console.error('[STORAGE] Load error:', filename, e.message);
    return defaultVal;
  }
}

function saveFile(filename, data) {
  const file = path.join(DATA_DIR, filename);
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return true;
  } catch(e) {
    console.error('[STORAGE] Save error:', filename, e.message);
    return false;
  }
}

// ── IN-MEMORY CACHE ──
const cache = {
  users:         null,
  profiles:      null,
  appointments:  null,
  conversations: null,
  audit:         null,
  settings:      null,
  teams:         null,
};

function get(key, defaultVal) {
  if (cache[key] === null) {
    cache[key] = loadFile(key + '.json', defaultVal);
    console.log(`[STORAGE] Loaded ${key}: ${Array.isArray(cache[key]) ? cache[key].length : Object.keys(cache[key]).length} entries`);
  }
  return cache[key];
}

function set(key, data) {
  cache[key] = data;
  return saveFile(key + '.json', data);
}

// ── USERS ──
const storage = {

  // USERS
  getUsers() { return get('users', {}); },
  getUser(email) { return this.getUsers()[email] || null; },
  saveUser(user) {
    const users = this.getUsers();
    users[user.email] = user;
    set('users', users);
    this.audit('user.save', { email: user.email, role: user.role });
    return user;
  },
  deleteUser(email) {
    const users = this.getUsers();
    delete users[email];
    set('users', users);
    this.audit('user.delete', { email });
  },
  getUsersByClientId(clientId) {
    return Object.values(this.getUsers()).filter(u => u.clientId === clientId);
  },

  // PROFILES
  getProfiles() { return get('profiles', {}); },
  getProfile(clientId) { return this.getProfiles()[clientId] || null; },
  saveProfile(profile) {
    const profiles = this.getProfiles();
    profiles[profile.clientId] = { ...profiles[profile.clientId], ...profile, updatedAt: new Date().toISOString() };
    set('profiles', profiles);
    this.audit('profile.save', { clientId: profile.clientId, name: profile.name });
    return profiles[profile.clientId];
  },

  // APPOINTMENTS
  getAppointments(clientId) {
    const all = get('appointments', {});
    return clientId ? (all[clientId] || []) : all;
  },
  saveAppointment(appointment) {
    const all = get('appointments', {});
    const cid = appointment.clientId;
    if (!all[cid]) all[cid] = [];
    const idx = all[cid].findIndex(a => a.id === appointment.id);
    if (idx >= 0) {
      all[cid][idx] = { ...appointment, updatedAt: new Date().toISOString() };
    } else {
      all[cid].push({ ...appointment, createdAt: new Date().toISOString() });
    }
    set('appointments', all);
    this.audit('appointment.save', { id: appointment.id, clientId: cid, patient: appointment.patient?.name });
    return appointment;
  },
  deleteAppointment(clientId, appointmentId) {
    const all = get('appointments', {});
    if (all[clientId]) {
      all[clientId] = all[clientId].filter(a => a.id !== appointmentId);
      set('appointments', all);
      this.audit('appointment.delete', { id: appointmentId, clientId });
    }
  },
  updateAppointmentStatus(clientId, appointmentId, status) {
    const all = get('appointments', {});
    if (all[clientId]) {
      const appt = all[clientId].find(a => a.id === appointmentId);
      if (appt) {
        appt.status = status;
        appt.updatedAt = new Date().toISOString();
        set('appointments', all);
        this.audit('appointment.status', { id: appointmentId, status });
      }
    }
  },

  // CONVERSATIONS
  getConversations(clientId) {
    const all = get('conversations', {});
    return clientId ? (all[clientId] || []) : all;
  },
  saveConversation(conversation) {
    const all = get('conversations', {});
    const cid = conversation.clientId;
    if (!all[cid]) all[cid] = [];
    all[cid].unshift({ ...conversation, savedAt: new Date().toISOString() });
    // Keep last 500 per client
    if (all[cid].length > 500) all[cid] = all[cid].slice(0, 500);
    set('conversations', all);
    return conversation;
  },

  // SETTINGS (per client)
  getSettings(clientId) {
    const all = get('settings', {});
    return all[clientId] || {};
  },
  saveSettings(clientId, settings) {
    const all = get('settings', {});
    all[clientId] = { ...all[clientId], ...settings, updatedAt: new Date().toISOString() };
    set('settings', all);
    this.audit('settings.save', { clientId });
    return all[clientId];
  },

  // TEAMS
  getTeam(clientId) {
    const all = get('teams', {});
    return all[clientId] || [];
  },
  saveTeam(clientId, team) {
    const all = get('teams', {});
    all[clientId] = team;
    set('teams', all);
  },

  // LEADS (keep existing structure)
  getLeads(clientId) {
    const all = loadFile('leads.json', {});
    return clientId ? (all[clientId] || []) : all;
  },
  saveLead(clientId, lead) {
    const all = loadFile('leads.json', {});
    if (!all[clientId]) all[clientId] = [];
    all[clientId].push({ ...lead, id: Date.now().toString(36), savedAt: new Date().toISOString() });
    saveFile('leads.json', all);
    this.audit('lead.save', { clientId, name: lead.nume });
    return all[clientId];
  },

  // AUDIT
  audit(action, data = {}) {
    try {
      const all = get('audit', []);
      all.unshift({
        ts: new Date().toISOString(),
        action,
        ...data
      });
      // Keep last 1000 entries
      if (all.length > 1000) all.splice(1000);
      cache['audit'] = all;
      saveFile('audit.json', all);
    } catch(e) {}
  },

  getAudit(clientId, limit = 50) {
    const all = get('audit', []);
    return all
      .filter(e => !clientId || e.clientId === clientId)
      .slice(0, limit);
  },

  // HEALTH CHECK
  health() {
    const files = ['users','profiles','appointments','conversations','settings','teams','audit'];
    return files.reduce((acc, f) => {
      const file = path.join(DATA_DIR, f + '.json');
      acc[f] = fs.existsSync(file) ? 'ok' : 'missing';
      return acc;
    }, {});
  },

  // MIGRATE from old format
  migrate() {
    console.log('[STORAGE] Running migration...');

    // Migrate old _profiles global
    const oldProfiles = loadFile('profiles.json', null);
    if (oldProfiles && typeof oldProfiles === 'object') {
      cache['profiles'] = oldProfiles;
      console.log('[STORAGE] Migrated profiles:', Object.keys(oldProfiles).length);
    }

    // Migrate old global.users
    console.log('[STORAGE] Migration complete');
  }
};

module.exports = storage;
