const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
let supabase = null;
function getClient() {
  if (!supabase && SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('[SUPABASE] Connected');
  }
  return supabase;
}
const db = {
  async getUser(email) {
    const sb = getClient(); if (!sb) return null;
    const { data } = await sb.from('users').select('*').eq('email', email).single();
    return data;
  },
  async saveUser(user) {
    const sb = getClient(); if (!sb) return;
    await sb.from('users').upsert({ email: user.email, password: user.password, role: user.role, client_id: user.clientId, business_name: user.businessName });
  },
  async getUsersByClientId(clientId) {
    const sb = getClient(); if (!sb) return [];
    const { data } = await sb.from('users').select('*').eq('client_id', clientId);
    return data || [];
  },
  async deleteUser(email) {
    const sb = getClient(); if (!sb) return;
    await sb.from('users').delete().eq('email', email);
  },
  async getProfile(clientId) {
    const sb = getClient(); if (!sb) return null;
    const { data } = await sb.from('profiles').select('*').eq('client_id', clientId).single();
    return data ? data.data : null;
  },
  async saveProfile(clientId, profile) {
    const sb = getClient(); if (!sb) return;
    await sb.from('profiles').upsert({ client_id: clientId, data: profile, updated_at: new Date().toISOString() });
  },
  async getLeads(clientId) {
    const sb = getClient(); if (!sb) return [];
    const { data } = await sb.from('leads').select('*').eq('client_id', clientId).order('created_at', { ascending: false });
    return (data || []).map(r => r.data);
  },
  async saveLead(lead) {
    const sb = getClient(); if (!sb) return;
    await sb.from('leads').upsert({ id: lead.id, client_id: lead.clientId, data: lead, created_at: lead.createdAt });
  },
  async updateLeadStatus(clientId, id, status) {
    const sb = getClient(); if (!sb) return;
    const { data } = await sb.from('leads').select('data').eq('id', id).single();
    if (data) {
      const updated = { ...data.data, status, contactedAt: status === 'contacted' ? new Date().toISOString() : data.data.contactedAt };
      await sb.from('leads').update({ data: updated }).eq('id', id);
    }
  },
  async getConversations(clientId) {
    const sb = getClient(); if (!sb) return [];
    const { data } = await sb.from('conversations').select('*').eq('client_id', clientId).order('created_at', { ascending: false });
    return (data || []).map(r => r.data);
  },
  async saveConversation(conv) {
    const sb = getClient(); if (!sb) return;
    const id = conv.id || 'conv_' + Date.now();
    await sb.from('conversations').upsert({ id, client_id: conv.clientId, data: conv, created_at: conv.savedAt || new Date().toISOString() });
  },
  async getSettings(clientId) {
    const sb = getClient(); if (!sb) return {};
    const { data } = await sb.from('settings').select('*').eq('client_id', clientId).single();
    return data ? data.data : {};
  },
  async saveSettings(clientId, settings) {
    const sb = getClient(); if (!sb) return;
    await sb.from('settings').upsert({ client_id: clientId, data: settings, updated_at: new Date().toISOString() });
  },
  isConnected() { return !!(SUPABASE_URL && SUPABASE_KEY && supabase); }
};
module.exports = db;
