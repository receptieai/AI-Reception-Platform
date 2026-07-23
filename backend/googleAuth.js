/**
 * RecepAI Google OAuth v1.0
 * Gmail + Google Calendar connect
 * Tokens salvate per clientId în storage
 */

'use strict';

const https = require('https');
const storage = require('./storage');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8080/auth/google/callback';

// ── SCOPES ──
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

// ── BUILD AUTH URL ──
function getAuthUrl(clientId, scope = 'gmail') {
  const scopes = scope === 'calendar' ? CALENDAR_SCOPES : GMAIL_SCOPES;
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: scopes,
    access_type: 'offline',
    prompt: 'consent',
    state: JSON.stringify({ clientId, scope }),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// ── EXCHANGE CODE FOR TOKENS ──
async function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }).toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('Invalid token response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── GET USER INFO ──
async function getUserInfo(accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.googleapis.com',
      path: '/oauth2/v2/userinfo',
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + accessToken },
      timeout: 8000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('Invalid userinfo response')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── REFRESH TOKEN ──
async function refreshToken(clientId, scope) {
  const settings = storage.getSettings(clientId);
  const integration = settings[scope];
  if (!integration?.refreshToken) throw new Error('No refresh token');

  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: integration.refreshToken,
      grant_type: 'refresh_token',
    }).toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const tokens = JSON.parse(d);
          // Update stored token
          storage.saveSettings(clientId, {
            ...settings,
            [scope]: { ...integration, accessToken: tokens.access_token }
          });
          resolve(tokens.access_token);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── SEND EMAIL VIA GMAIL API ──
async function sendGmail(clientId, to, subject, body, toName = '') {
  const settings = storage.getSettings(clientId);
  if (!settings.gmail?.connected) throw new Error('Gmail neconectat');

  let accessToken = settings.gmail.accessToken;

  const emailContent = [
    `From: ${settings.gmail.name || 'Clinica'} <${settings.gmail.email}>`,
    `To: ${toName ? toName + ' <' + to + '>' : to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  const encoded = Buffer.from(emailContent).toString('base64url');

  const result = await makeGmailRequest(accessToken, 'POST', '/gmail/v1/users/me/messages/send', { raw: encoded });

  if (result.error?.code === 401) {
    // Refresh token and retry
    accessToken = await refreshToken(clientId, 'gmail');
    return await makeGmailRequest(accessToken, 'POST', '/gmail/v1/users/me/messages/send', { raw: encoded });
  }

  console.log('[GMAIL] Email sent to', to, '- ID:', result.id);
  return result;
}

// ── GMAIL API REQUEST ──
function makeGmailRequest(accessToken, method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'gmail.googleapis.com',
      path,
      method,
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
      timeout: 10000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve({}); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── DISCONNECT ──
function disconnect(clientId, scope) {
  const settings = storage.getSettings(clientId);
  delete settings[scope];
  storage.saveSettings(clientId, settings);
  storage.audit('integration.disconnect', { clientId, scope });
  console.log('[GOOGLE] Disconnected', scope, 'for', clientId);
}

module.exports = { getAuthUrl, exchangeCode, getUserInfo, sendGmail, refreshToken, disconnect };
