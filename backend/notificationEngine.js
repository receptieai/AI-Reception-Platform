/**
 * RecepAI Notification Engine v1.0
 * SMS via Brevo (deja configurat), Email via Brevo
 * Reminder 24h, confirmare programare, anulare, no-show alert
 */

'use strict';

const https = require('https');
const storage = require('./storage');
const clinicConfig = require('./clinicConfig');

const BREVO_KEY = process.env.BREVO_API_KEY || '';

// ── SEND SMS via Brevo ──
async function sendSMS(to, message) {
  if (!BREVO_KEY) { console.log('[SMS] No Brevo key, skipping'); return false; }
  
  return new Promise((resolve) => {
    const body = JSON.stringify({
      sender: 'RecepAI',
      recipient: to.replace(/\s/g, '').replace(/^0/, '+40'),
      content: message,
    });
    const req = https.request({
      hostname: 'api.brevo.com',
      path: '/v3/transactionalSMS/sms',
      method: 'POST',
      headers: {
        'api-key': BREVO_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        console.log('[SMS] Sent to', to, '- Status:', res.statusCode);
        resolve(res.statusCode < 300);
      });
    });
    req.on('error', (e) => { console.error('[SMS] Error:', e.message); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ── SEND EMAIL via Brevo ──
async function sendEmail(to, subject, html, toName = '') {
  if (!BREVO_KEY) { console.log('[EMAIL] No Brevo key, skipping'); return false; }

  return new Promise((resolve) => {
    const body = JSON.stringify({
      sender: { name: 'RecepAI', email: 'noreply@receptieai.ro' },
      to: [{ email: to, name: toName }],
      subject,
      htmlContent: html,
    });
    const req = https.request({
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      method: 'POST',
      headers: {
        'api-key': BREVO_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        console.log('[EMAIL] Sent to', to, '- Status:', res.statusCode);
        resolve(res.statusCode < 300);
      });
    });
    req.on('error', (e) => { console.error('[EMAIL] Error:', e.message); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ── NOTIFICATION TEMPLATES ──
const templates = {

  // Confirmare programare
  appointmentConfirmed(appt, clinic) {
    const date = new Date(appt.date);
    const dateStr = date.toLocaleDateString('ro-RO', { weekday: 'long', day: 'numeric', month: 'long' });
    return {
      sms: `${clinic.name}: Programarea ta pentru ${appt.service?.name} pe ${dateStr} la ${appt.slot} cu ${appt.doctor?.name} a fost confirmata. Info: ${clinic.phone}`,
      email: {
        subject: `Programare confirmată — ${clinic.name}`,
        html: `<div style="font-family:Inter,sans-serif;max-width:500px;margin:0 auto;padding:24px">
          <h2 style="color:#00D4AA">✅ Programare confirmată</h2>
          <p>Bună ${appt.patient?.name},</p>
          <p>Programarea ta a fost confirmată:</p>
          <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin:16px 0">
            <b>Serviciu:</b> ${appt.service?.name}<br>
            <b>Data:</b> ${dateStr} la ${appt.slot}<br>
            <b>Doctor:</b> ${appt.doctor?.name}<br>
            <b>Clinică:</b> ${clinic.name}
          </div>
          <p>Adresă: ${clinic.address || 'verificați site-ul'}</p>
          <p>📞 ${clinic.phone}</p>
          <p style="color:#999;font-size:12px">Pentru anulare sau reprogramare contactați-ne cu cel puțin 24h înainte.</p>
        </div>`
      }
    };
  },

  // Reminder 24h
  appointmentReminder(appt, clinic) {
    const date = new Date(appt.date);
    const dateStr = date.toLocaleDateString('ro-RO', { weekday: 'long', day: 'numeric', month: 'long' });
    return {
      sms: `Reminder ${clinic.name}: Maine ${dateStr} la ${appt.slot} - ${appt.service?.name} cu ${appt.doctor?.name}. Anulare: ${clinic.phone}`,
      email: {
        subject: `Reminder programare mâine — ${clinic.name}`,
        html: `<div style="font-family:Inter,sans-serif;max-width:500px;margin:0 auto;padding:24px">
          <h2 style="color:#FFB800">⏰ Reminder programare</h2>
          <p>Bună ${appt.patient?.name},</p>
          <p>Îți amintim că mâine ai o programare:</p>
          <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin:16px 0">
            <b>Serviciu:</b> ${appt.service?.name}<br>
            <b>Data:</b> ${dateStr} la ${appt.slot}<br>
            <b>Doctor:</b> ${appt.doctor?.name}
          </div>
          <p>📍 ${clinic.address || clinic.name}</p>
          <p>📞 ${clinic.phone}</p>
        </div>`
      }
    };
  },

  // Anulare
  appointmentCancelled(appt, clinic) {
    return {
      sms: `${clinic.name}: Programarea ta din ${appt.slot} a fost anulata. Pentru reprogramare: ${clinic.phone}`,
      email: {
        subject: `Programare anulată — ${clinic.name}`,
        html: `<div style="font-family:Inter,sans-serif;max-width:500px;margin:0 auto;padding:24px">
          <h2 style="color:#FF4455">❌ Programare anulată</h2>
          <p>Bună ${appt.patient?.name}, programarea ta a fost anulată.</p>
          <p>Pentru reprogramare: <b>${clinic.phone}</b></p>
        </div>`
      }
    };
  },
};

// ── SEND NOTIFICATION ──
async function notify(type, appt, clientId) {
  const config = clinicConfig.get(clientId);
  const notifSettings = config.notifications || {};

  if (!notifSettings.smsEnabled && !notifSettings.emailEnabled) {
    console.log('[NOTIFY] Notifications disabled for', clientId);
    return { sent: false, reason: 'disabled' };
  }

  const tmpl = templates[type]?.(appt, config);
  if (!tmpl) { console.error('[NOTIFY] Unknown template:', type); return { sent: false }; }

  const results = {};

  // SMS
  if (notifSettings.smsEnabled && appt.patient?.phone) {
    results.sms = await sendSMS(appt.patient.phone, tmpl.sms);
  }

  // Email
  if (notifSettings.emailEnabled && appt.patient?.email) {
    results.email = await sendEmail(
      appt.patient.email,
      tmpl.email.subject,
      tmpl.email.html,
      appt.patient.name
    );
  }

  // Log
  storage.audit('notification.' + type, {
    clientId,
    patient: appt.patient?.name,
    phone: appt.patient?.phone,
    ...results
  });

  console.log('[NOTIFY]', type, 'for', appt.patient?.name, results);
  return { sent: true, ...results };
}

// ── SCHEDULED REMINDERS (run every hour) ──
async function checkAndSendReminders() {
  console.log('[NOTIFY] Checking reminders...');
  const allAppts = storage.getAppointments();

  for (const [clientId, appts] of Object.entries(allAppts)) {
    const config = clinicConfig.get(clientId);
    if (!config.notifications?.smsEnabled && !config.notifications?.emailEnabled) continue;

    const reminderHours = config.notifications?.reminderHours || 24;
    const now = new Date();

    for (const appt of appts) {
      if (appt.status !== 'confirmed') continue;
      if (appt.reminderSent) continue;

      const apptDate = new Date(appt.date);
      const [h, m] = (appt.slot || '00:00').split(':');
      apptDate.setHours(parseInt(h), parseInt(m), 0, 0);

      const hoursUntil = (apptDate - now) / (1000 * 60 * 60);

      if (hoursUntil > 0 && hoursUntil <= reminderHours) {
        await notify('appointmentReminder', appt, clientId);
        // Mark as sent
        storage.updateAppointmentStatus(clientId, appt.id, appt.status);
        appt.reminderSent = true;
      }
    }
  }
}

module.exports = { notify, sendSMS, sendEmail, checkAndSendReminders, templates };
