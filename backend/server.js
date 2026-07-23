/**
 * RecepAI Server v2.0
 * Scanner îmbunătățit cu multi-page fetch
 * Lecții învățate: fetch pagini cu prețuri + extragere directă linkuri din HTML
 */

// ── LOAD .ENV ──
try {
  require('fs').readFileSync(require('path').join(__dirname, '../.env'), 'utf8')
    .split('\n').forEach(line => {
      const idx = line.indexOf('=');
      if (idx > 0) {
        const k = line.substring(0, idx).trim();
        const v = line.substring(idx + 1).trim();
        if (k && !process.env[k]) process.env[k] = v;
      }
    });
  console.log('[ENV] Loaded .env');
} catch(e) { console.log('[ENV] No .env file'); }

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { extractAll } = require('./extractors');
const storage = require('./storage');
const clinicConfig = require('./clinicConfig');
const availability = require('./availabilityEngine');
const { notify, checkAndSendReminders } = require('./notificationEngine');
const healthMonitor = require('./healthMonitor');
const googleAuth = require('./googleAuth');


const { buildBusinessBrain } = require('./businessBrainScanner');

// ── STORAGE ENGINE ──
storage.migrate();

function saveProfiles() { /* handled by storage */ }

function getBusinessProfile(clientId, incomingProfile) {
  const incoming = incomingProfile || {};
  if (!clientId) {
    console.log('[CHAT] Missing clientId - using request profile only');
    return incoming;
  }
  const stored = storage.getProfile(clientId);
  if (!stored) {
    console.log('[CHAT] Profile', clientId, 'not found');
    return incoming;
  }
  console.log('[CHAT] Loaded profile', clientId, stored.name);
  return { ...stored, ...incoming };
}
const { saveConversation, getAnalytics, addGlobalAnswer, loadGaps } = require('./learning/conversationAnalyzer');
const { createJob, getJob, getAllJobs } = require('./jobs/scanQueue');
const { runScanJob } = require('./jobs/scanWorker');
const { renderWithBrowser, needsBrowser } = require('./browser');

const PORT = process.env.PORT || 8080;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'receptieai@proton.me';
const ROOT = path.join(__dirname, '..');

const MIME = {
  '.html': 'text/html;charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/plain'
};

// ── LEADS ─────────────────────────────────────
const DATA_DIR = path.join(ROOT, 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');

function loadLeads() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(LEADS_FILE)) return {};
    return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
  } catch (e) { return {}; }
}

function saveLead(clientId, lead) {
  const leads = loadLeads();
  if (!leads[clientId]) leads[clientId] = [];
  leads[clientId].push({ ...lead, id: Date.now().toString(36), timestamp: new Date().toISOString() });
  try { fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2)); } catch (e) { }
  return leads[clientId];
}

// ── EMAIL ─────────────────────────────────────
function sendEmail({ to, toName, subject, html }) {
  return new Promise((resolve, reject) => {
    if (!BREVO_API_KEY) { console.log('[EMAIL] No key'); resolve({ skipped: true }); return; }
    if (!to || !to.includes('@')) { resolve({ skipped: true }); return; }
    const body = JSON.stringify({
      sender: { name: 'RecepAI', email: FROM_EMAIL },
      to: [{ email: to, name: toName || to }],
      subject, htmlContent: html
    });
    const req = https.request({
      hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': BREVO_API_KEY, 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('[EMAIL] ✓', subject, '→', to); resolve({ success: true });
        } else {
          console.error('[EMAIL] Error:', res.statusCode); reject(new Error('Email failed'));
        }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function notifyOwner(lead, businessName, ownerEmail) {
  return sendEmail({
    to: ownerEmail, toName: businessName,
    subject: `🔔 Lead nou — ${lead.nume || 'Client'} vrea programare`,
    html: `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
<h2 style="color:#00D4AA">RecepAI — Lead nou!</h2>
<p>Afacere: <b>${businessName}</b></p>
<div style="background:#f8f8f8;border-left:4px solid #00D4AA;padding:16px;border-radius:6px;margin:16px 0">
<p>👤 <b>Nume:</b> ${lead.nume || '—'}</p>
<p>📞 <b>Telefon:</b> <a href="tel:${(lead.telefon || '').replace(/\s/g, '')}">${lead.telefon || '—'}</a></p>
${lead.serviciu ? `<p>🔧 <b>Serviciu:</b> ${lead.serviciu}</p>` : ''}
${lead.data_dorita ? `<p>📅 <b>Data:</b> ${lead.data_dorita}</p>` : ''}
</div>
<a href="tel:${(lead.telefon || '').replace(/\s/g, '')}" style="background:#00D4AA;color:#000;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">📞 Sună acum</a>
<p style="color:#999;font-size:12px;margin-top:16px">Powered by RecepAI · receptieai.ro</p>
</div>`
  });
}

function confirmClient(lead, businessName, businessPhone) {
  if (!lead.email || !lead.email.includes('@')) return Promise.resolve({ skipped: true });
  return sendEmail({
    to: lead.email, toName: lead.nume || 'Client',
    subject: `✅ Solicitarea ta la ${businessName} a fost înregistrată`,
    html: `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px;text-align:center">
<h2 style="color:#00D4AA">✅ Solicitare înregistrată!</h2>
<p>Bună ziua <b>${lead.nume || 'Client'}</b>!<br>${businessName} te va contacta în maximum 2 ore în timpul programului.</p>
${lead.serviciu ? `<p>🔧 Serviciu: <b>${lead.serviciu}</b></p>` : ''}
${businessPhone ? `<a href="tel:${businessPhone.replace(/\s/g, '')}" style="background:#000;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block">📞 ${businessPhone}</a>` : ''}
<p style="color:#999;font-size:12px;margin-top:16px">Powered by RecepAI · receptieai.ro</p>
</div>`
  });
}

// ── FETCH WEBSITE ─────────────────────────────
function fetchUrl(pageUrl) {
  return new Promise((resolve, reject) => {
    let u = pageUrl.trim();
    if (!u.startsWith('http')) u = 'https://' + u;
    
    let parsed;
    try { parsed = new URL(u); } 
    catch (e) { reject(new Error('URL invalid: ' + u)); return; }
    
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      path: parsed.pathname + (parsed.search || ''),
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      },
      timeout: 12000
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (!loc.startsWith('http')) loc = parsed.protocol + '//' + parsed.hostname + loc;
        fetchUrl(loc).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode >= 400) { reject(new Error('HTTP ' + res.statusCode)); return; }
      
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => { d += c; if (d.length > 400000) { req.destroy(); resolve(d); } });
      res.on('end', () => resolve(d));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout: ' + pageUrl)); });
    req.on('error', reject);
    req.end();
  });
}

// ── EXTRAGE LINKURI DIN HTML ──────────────────
function extractSocialLinks(html) {
  const result = { facebook: null, instagram: null, emailFromMailto: null };
  
  const fbMatch = html.match(/href=["'](https?:\/\/(?:www\.)?facebook\.com\/[^"'\s?#]+)["']/i);
  if (fbMatch) result.facebook = fbMatch[1];
  
  const igMatch = html.match(/href=["'](https?:\/\/(?:www\.)?instagram\.com\/[^"'\s?#]+)["']/i);
  if (igMatch) result.instagram = igMatch[1];
  
  const emailMatch = html.match(/href=["']mailto:([^"'\s?]+)["']/i);
  if (emailMatch) result.emailFromMailto = emailMatch[1];
  
  return result;
}

// ── GĂSEȘTE PAGINI CU PREȚURI DIN MENIU ──────
function findPricePageUrls(html, baseUrl) {
  const results = [];
  
  // Extrage origin-ul corect
  let origin = '';
  try {
    const parsed = new URL(baseUrl.startsWith('http') ? baseUrl : 'https://' + baseUrl);
    origin = parsed.protocol + '//' + parsed.hostname;
  } catch (e) { return results; }
  
  // Keywords pentru pagini cu prețuri
  const priceKeywords = /\/tarif|\/pret|\/servicii|\/costuri|\/lista-servicii|\/price|\/services|tarife|preturi/i;
  
  const linkRegex = /href=["']([^"'#?\s]{2,100})["']/gi;
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    const href = m[1];
    if (!priceKeywords.test(href)) continue;
    
    let fullUrl = '';
    if (href.startsWith('http')) fullUrl = href;
    else if (href.startsWith('/')) fullUrl = origin + href;
    else continue;
    
    if (!results.includes(fullUrl)) results.push(fullUrl);
    if (results.length >= 3) break;
  }
  
  return results;
}

// ── STRIP HTML ────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 12000);
}

// ── MAIN ANALYZE FUNCTION ─────────────────────
async function analyzeWebsite(siteUrl) {
  console.log('[ANALYZE] START:', siteUrl);
  
  // Normalizează URL-ul
  let normalUrl = siteUrl.trim();
  if (!normalUrl.startsWith('http')) normalUrl = 'https://' + normalUrl;
  
  let origin = '';
  try {
    origin = new URL(normalUrl).protocol + '//' + new URL(normalUrl).hostname;
  } catch (e) {
    console.log('[ANALYZE] URL invalid:', siteUrl);
    return { success: false, error: 'URL invalid' };
  }

  // PASUL 1: Fetch homepage
  let homepageHtml = '';
  try {
    homepageHtml = await fetchUrl(normalUrl);
    console.log('[ANALYZE] Homepage:', homepageHtml.length, 'chars');
  } catch (e) {
    console.log('[ANALYZE] Homepage fetch failed:', e.message);
  }

  // PASUL 2: Extrage linkuri sociale din homepage
  const socialLinks = homepageHtml ? extractSocialLinks(homepageHtml) : {};

  // PASUL 3: Găsește pagini cu prețuri din meniu
  const priceUrls = homepageHtml ? findPricePageUrls(homepageHtml, normalUrl) : [];
  console.log('[ANALYZE] Price pages found in menu:', priceUrls);

  // PASUL 4: Lista completă de pagini de fetch
  const staticPages = ['/tarife', '/tarife/', '/preturi', '/preturi/', '/servicii', '/servicii/', '/contact', '/contact/'];
  const allPriceUrls = [...new Set([...priceUrls, ...staticPages.map(p => origin + p)])];
  // Paginile din meniu au prioritate — sunt cele mai relevante
  allPriceUrls.sort((a, b) => (priceUrls.includes(a) ? -1 : 1));

  // PASUL 5: Fetch toate paginile cu prețuri
  let extraContent = '';
  let allRawHtml = '';
  for (const pageUrl of allPriceUrls) {
    try {
      let pageHtml = await fetchUrl(pageUrl);
      // Dacă pagina e JS-rendered SAU e o pagina de servicii, folosim Playwright
      // Playwright doar daca pagina e clara JS-rendered si nu avem deja destul continut
      if (needsBrowser(pageHtml) && extraContent.length < 15000) {
        const rendered = await renderWithBrowser(pageUrl, { acceptCookies: false, scrollPage: false, expandAccordions: false, waitAfterLoad: 1000 });
        if (rendered.success && rendered.html.length > pageHtml.length) {
          pageHtml = rendered.html;
          if (rendered.textContent) renderedTextContent += ' ' + rendered.textContent;
          console.log('[BROWSER] Page rendered:', pageUrl, '→', pageHtml.length, 'chars');
        }
      }
      extraContent += ' ' + stripHtml(pageHtml);
      allRawHtml += ' ' + pageHtml;
      console.log('[ANALYZE] Fetched:', pageUrl, '→', pageHtml.length, 'chars');
      if (extraContent.length > 40000) break;
    } catch (e) {
      // Silent — pagina nu există
    }
  }

  // PASUL 6: Combină tot conținutul
  const homepageText = homepageHtml ? stripHtml(homepageHtml) : '';
  const combinedHtmlForExtraction = homepageHtml + (typeof allRawHtml !== 'undefined' ? allRawHtml : '');
  const detExtracted = homepageHtml ? extractAll(combinedHtmlForExtraction, siteUrl) : null;
  if (detExtracted) {
    console.log('[EXTRACTORS] Phone:', detExtracted.phone, '| Email:', detExtracted.email);
    console.log('[EXTRACTORS] FB:', detExtracted.facebook, '| IG:', detExtracted.instagram);
    console.log('[EXTRACTORS] Services (deterministic):', detExtracted.services.length);
  }
  const fullText = (homepageText.substring(0, 1000) + ' ' + extraContent.substring(0, 7000)).substring(0, 8000);

  if (!fullText.trim() && !socialLinks.facebook) {
    console.log('[ANALYZE] No content fetched — using fallback');
    return { success: true, data: makeFallback(new URL(normalUrl).hostname), mock: true };
  }

  // PASUL 7: Claude analizează tot
  const domain = new URL(normalUrl).hostname;
  const prompt = `Analizează acest website românesc și extrage TOATE informațiile disponibile.

URL: ${siteUrl}
Linkuri detectate automat din HTML:
- Facebook: ${socialLinks.facebook || 'negăsit'}
- Instagram: ${socialLinks.instagram || 'negăsit'}  
- Email mailto: ${socialLinks.emailFromMailto || 'negăsit'}

Conținut website (homepage + pagini tarife/servicii/contact):
${fullText}

INSTRUCȚIUNI IMPORTANTE:
1. Extrage TOATE serviciile cu prețurile EXACTE în LEI sau EUR (ex: "100 Lei", "300 Lei/30 min")
2. Dacă găsești email în format "office@" sau "contact@" sau "mailto:" — include-l
3. Folosește linkurile Facebook/Instagram detectate automat de mai sus
4. Extrage programul complet (toate zilele)
5. Confidence: 85+ dacă ai servicii cu prețuri, 70-84 dacă ai servicii fără prețuri, sub 70 dacă lipsesc multe

Returnează DOAR acest JSON valid, fără text suplimentar:
{
  "name": "Numele afacerii",
  "type": "tipul cu emoji (ex: 🦷 Cabinet Dentar)",
  "phone": "numărul de telefon sau null",
  "email": "emailul sau null",
  "city": "orașul sau null",
  "hours": "programul complet sau null",
  "services": [
    {"name": "numele serviciului", "price": "prețul exact în LEI (ex: 100 Lei, 300 Lei/30 min) sau null", "duration": "durata sau null"}
  ],
  "faq": [
    {"question": "întrebare frecventă", "answer": "răspuns"}
  ],
  "facebook": "${socialLinks.facebook || 'null — caută în text'}",
  "instagram": "${socialLinks.instagram || 'null — caută în text'}",
  "confidence": număr_între_0_și_100,
  "missing": ["lista cu ce lipsește"]
}

IMPORTANT: Listează MAXIM 25 servicii, cele mai importante. Nu toate.`;

  try {
    const result = await callClaude('Ești expert în analiza afacerilor locale din România. Returnezi DOAR JSON valid, fără markdown, fără text extra.', prompt);
    let clean = result.replace(/```json|```/g, '').trim();
    clean = clean.replace(/,(\s*[}\]])/g, '$1');
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      console.log('[ANALYZE] JSON repair attempt:', parseErr.message);
      const lastGoodBrace = clean.lastIndexOf('},');
      const lastGoodBracket = clean.lastIndexOf('],');
      const cutPoint = Math.max(lastGoodBrace, lastGoodBracket);
      if (cutPoint > 0) {
        let repaired = clean.substring(0, cutPoint + 1);
        const ob = (repaired.match(/\{/g)||[]).length;
        const cb = (repaired.match(/\}/g)||[]).length;
        const obr = (repaired.match(/\[/g)||[]).length;
        const cbr = (repaired.match(/\]/g)||[]).length;
        if (ob > cb) repaired += '}'.repeat(ob - cb);
        if (obr > cbr) repaired += ']'.repeat(obr - cbr);
        parsed = JSON.parse(repaired);
      } else {
        throw parseErr;
      }
    }
    
    // Override cu linkurile extrase direct din HTML (mai precise)
    // Override cu extractoarele deterministe (prioritate maxima)
    if (detExtracted) {
      if (detExtracted.phone) parsed.phone = detExtracted.phone;
      if (detExtracted.email) parsed.email = detExtracted.email;
      if (detExtracted.facebook) parsed.facebook = detExtracted.facebook;
      if (detExtracted.instagram) parsed.instagram = detExtracted.instagram;
      if (detExtracted.tiktok) parsed.tiktok = detExtracted.tiktok;
      if (detExtracted.youtube) parsed.youtube = detExtracted.youtube;
      if (detExtracted.address) parsed.address = detExtracted.address;
      if (detExtracted.hours) parsed.hours = detExtracted.hours;
      // Daca extractorul determinist a gasit mai multe servicii cu preturi, le folosim
      const detWithPrices = detExtracted.services.filter(s => s.price).length;
      const claudeWithPrices = (parsed.services||[]).filter(s => s.price).length;
      if (detWithPrices > claudeWithPrices) parsed.services = detExtracted.services;
      // Confidence pe baza extractoarelor deterministe
      parsed.fieldConfidence = detExtracted._confidence;
    // Recalculează confidence global din extractoare (nu din Claude)
    const weights = {phone:15,email:10,name:15,city:5,hours:10,services:25,prices:15,facebook:3,instagram:2};
    let wSum=0, wTotal=0;
    Object.entries(weights).forEach(([k,w])=>{
      const val = detExtracted._confidence[k] || 0;
      wSum += val * w; wTotal += w * 100;
    });
    parsed.confidence = Math.round(wSum / wTotal * 100);
    console.log('[EXTRACTORS] Recalculated confidence:', parsed.confidence, '% (was Claude:', parsed.confidence, ')');
    }
    if (socialLinks.facebook) parsed.facebook = socialLinks.facebook;
    if (socialLinks.instagram) parsed.instagram = socialLinks.instagram;
    if (socialLinks.emailFromMailto && !parsed.email) parsed.email = socialLinks.emailFromMailto;
    
    console.log('[ANALYZE] SUCCESS:', parsed.name, '| Conf:', parsed.confidence, '| Services:', parsed.services?.length || 0);
    return { success: true, data: parsed };
  } catch (e) {
    console.error('[ANALYZE] Claude error:', e.message);
    // Dacă Claude a eșuat dar extractoarele au date bune, le folosim direct
    if (detExtracted && (detExtracted.phone || detExtracted.services.length > 0)) {
      console.log('[ANALYZE] Using extractor data as fallback (Claude failed)');
      const extData = {
        name: detExtracted.name || domain.replace(/^www\./, '').split('.')[0].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        type: (function(u){
          const s=u.toLowerCase();
          if(s.includes('dent')||s.includes('stomat')) return '🦷 Cabinet Dentar';
          if(s.includes('vet')||s.includes('animal')) return '🐾 Cabinet Veterinar';
          if(s.includes('fizio')||s.includes('recuper')) return '💆 Fizioterapie';
          if(s.includes('auto')||s.includes('service')) return '🚗 Service Auto';
          if(s.includes('salon')||s.includes('beauty')) return '💇 Salon Beauty';
          return '🏢 Afacere Locală';
        })(siteUrl),
        phone: detExtracted.phone,
        email: detExtracted.email,
        city: detExtracted.city,
        address: detExtracted.address,
        hours: detExtracted.hours,
        services: detExtracted.services,
        faq: [],
        facebook: detExtracted.facebook,
        instagram: detExtracted.instagram,
        tiktok: detExtracted.tiktok,
        youtube: detExtracted.youtube,
        fieldConfidence: detExtracted._confidence,
        confidence: 0,
        missing: Object.entries({phone:extData.phone,email:extData.email,hours:extData.hours,city:extData.city})
          .filter(([k,v])=>!v).map(([k])=>k),
      };
      const weights = {phone:15,email:10,name:15,city:5,hours:10,services:25,prices:15,facebook:3,instagram:2};
      let wSum=0, wTotal=0;
      Object.entries(weights).forEach(([k,w])=>{
        const val = detExtracted._confidence[k] || 0;
        wSum += val * w; wTotal += w * 100;
      });
      extData.confidence = Math.round(wSum / wTotal * 100);
      return { success: true, data: extData, extractorOnly: true };
    }
    return { success: true, data: makeFallback(domain), mock: true };
  }
}

// ── CLAUDE API ────────────────────────────────
function callClaude(system, user) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system,
      messages: [{ role: 'user', content: user }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 45000
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(d);
          resolve(p.content?.[0]?.text || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Claude timeout')); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── FALLBACK ──────────────────────────────────
function makeFallback(domain) {
  const s = domain.toLowerCase();
  let type = '💇 Salon Beauty';
  let services = [{ name: 'Serviciu 1', price: null }, { name: 'Serviciu 2', price: null }];
  
  if (s.includes('dent') || s.includes('stomat') || s.includes('clinic') || s.includes('medic') || s.includes('dental')) {
    type = '🦷 Cabinet Dentar';
    services = [{ name: 'Consultatie', price: null }, { name: 'Detartraj', price: null }, { name: 'Plomba', price: null }];
  } else if (s.includes('vet') || s.includes('animal') || s.includes('biovet') || s.includes('pet')) {
    type = '🐾 Cabinet Veterinar';
    services = [{ name: 'Consultatie', price: null }, { name: 'Vaccinare', price: null }];
  } else if (s.includes('fizio') || s.includes('recuper') || s.includes('kine')) {
    type = '💆 Fizioterapie';
    services = [{ name: 'Sedinta fizioterapie', price: null }, { name: 'Masaj terapeutic', price: null }];
  } else if (s.includes('auto') || s.includes('service') || s.includes('car') || 
             s.includes('landrover') || s.includes('bmw') || s.includes('mercedes') || 
             s.includes('dacia') || s.includes('ford') || s.includes('toyota')) {
    type = '🚗 Service Auto';
    services = [{ name: 'Revizie', price: null }, { name: 'Schimb ulei', price: null }];
  }
  
  const name = domain.replace(/^www\./, '').split('.')[0]
    .replace(/-/g, ' ')
    .replace(/\b\w/g, l => l.toUpperCase());
  
  return {
    name, type, phone: null, email: null, city: null,
    hours: null, services, faq: [], facebook: null, instagram: null,
    confidence: 30, missing: ['toate informațiile — site inaccesibil sau fără conținut text'],
    mock: true
  };
}

// ── CHAT ──────────────────────────────────────
async function chatWithAI(messages, profile, personality) {
  const tones = {
    prietenos: 'prietenos și cald, folosești emoji-uri cu moderație',
    profesionist: 'profesionist și formal, fără emoji-uri',
    elegant: 'elegant și sofisticat',
    cald: 'foarte empatic și grijuliu',
    dinamic: 'rapid și direct la obiect'
  };
  
  const services = (profile.services || [])
    .filter(s => s.name)
    .map(s => `• ${s.name}${s.price ? ': ' + s.price : ''}${s.duration ? ' (' + s.duration + ')' : ''}`)
    .join('\n');
  
  const now = new Date();
  const hour = now.getHours();
  const isWorkingHours = hour >= 9 && hour < 18;
  
  // Build AI context from clinicConfig + brain profile
  const clientIdForConfig = profile.clientId || null;
  const aiContext = clinicConfig.buildAIContext(clientIdForConfig, profile);
  const isOpen = clientIdForConfig ? clinicConfig.isOpenNow(clientIdForConfig) : isWorkingHours;

  const system = `Ești recepționistul virtual. Vorbești DOAR în română. Răspunsuri scurte — maxim 4 propoziții.
Ton: ${tones[personality || 'prietenos'] || tones.prietenos}

${aiContext}

CÂND CLIENTUL VREA PROGRAMARE:
1. Cere numele
2. Cere telefonul
3. Cere serviciul dorit
4. Cere ziua preferată
5. ${isOpen
    ? 'Confirmă: "Veți fi contactat în maximum 2 ore!"'
    : 'Confirmă: "Solicitarea a fost înregistrată! Vă vom contacta în ziua lucrătoare următoare."'}`;

  const userMsg = messages
    .map(m => `${m.role === 'user' ? 'Client' : 'Asistent'}: ${m.content}`)
    .join('\n\n');

  try {
    const reply = await callClaude(system, userMsg);
    return { success: true, message: reply };
  } catch (e) {
    return { success: false, message: 'Îmi pare rău, a apărut o eroare. Vă rog sunați direct.' };
  }
}

// ── HELPERS ───────────────────────────────────
function setCors(res, origin) {
  const allowed = [
    'http://localhost:9090',
    'http://localhost:3000',
    'https://receptieai-frontend.pages.dev',
    'https://receptieai.ro',
    'https://www.receptieai.ro',
    'https://satoshicourt.com',
  ];
  const o = origin || '';
  const allowedOrigin = allowed.find(a => o.startsWith(a)) ? o : allowed[0];
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function setCors_old(res) {

function parseBody(req) {
  return new Promise(r => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } });
  });
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── SERVER ────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCors(res, req.headers.origin);
  const pathname = url.parse(req.url, true).pathname;

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Health
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, {
      status: 'ok', version: '2.0.0',
      timestamp: new Date().toISOString(),
      claude: CLAUDE_API_KEY ? '✓ configured' : '✗ missing',
      brevo: BREVO_API_KEY ? '✓ configured' : '✗ missing'
    });
    return;
  }

  // Analyze
  // ── SCAN JOB ENDPOINTS ──────────────────────
  if (pathname === '/api/scan/start' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.url) { sendJson(res, { error: 'URL lipsa' }, 400); return; }
    const job = createJob(body.url, { version: body.version || 'hybrid' });
    // Start in background
    setImmediate(() => runScanJob(job.id, body.url).catch(e => console.error('[SCAN]', e.message)));
    sendJson(res, { success: true, jobId: job.id, status: 'pending' });
    return;
  }

  if (pathname.startsWith('/api/scan/status/') && req.method === 'GET') {
    const jobId = pathname.replace('/api/scan/status/', '');
    const job = getJob(jobId);
    if (!job) { sendJson(res, { error: 'Job negasit' }, 404); return; }
    sendJson(res, {
      success: true,
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      progressText: job.progressText,
      result: job.status === 'completed' ? job.result : null,
      error: job.error || null,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    });
    return;
  }

  if (pathname === '/api/scan/jobs' && req.method === 'GET') {
    const jobs = getAllJobs().slice(0, 20).map(j => ({
      id: j.id, url: j.url, status: j.status,
      progress: j.progress, progressText: j.progressText,
      createdAt: j.createdAt, completedAt: j.completedAt,
    }));
    sendJson(res, { success: true, jobs });
    return;
  }

  if (pathname === '/api/analyze' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.url) { sendJson(res, { error: 'URL lipsă' }, 400); return; }

    if (!CLAUDE_API_KEY) {
      const domain = body.url.replace(/^https?:\/\//, '').replace(/\/.*/, '');
      sendJson(res, { success: true, data: makeFallback(domain), mock: true });
      return;
    }

    try {
      const result = await analyzeWebsite(body.url);
      sendJson(res, result);
    } catch (e) {
      console.error('[ANALYZE] Fatal error:', e.message);
      const domain = body.url.replace(/^https?:\/\//, '').replace(/\/.*/, '');
      sendJson(res, { success: true, data: makeFallback(domain), mock: true });
    }
    return;
  }

  // Chat
  if (pathname === '/api/chat' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.messages || !body.businessProfile) { sendJson(res, { error: 'Date lipsă' }, 400); return; }
    if (!CLAUDE_API_KEY) {
      sendJson(res, { success: true, message: 'Bună ziua! Vă pot ajuta cu o programare.', mock: true });
      return;
    }
    try {
      const clientId = body.clientId ?? body.businessProfile?.clientId ?? null;
      const businessProfile = getBusinessProfile(clientId, body.businessProfile);
      const result = await chatWithAI(body.messages, businessProfile, body.personality);
      // Save conversation for Learning Engine
      setImmediate(() => {
        try {
          saveConversation(body.messages, body.businessProfile, result.message || '');
        } catch(e) {}
      });
      sendJson(res, result);
    } catch (e) { sendJson(res, { error: 'Chat error' }, 500); }
    return;
  }

  // BrainBank generate
  if (pathname === '/api/brainbank/generate' && req.method === 'POST') {
    const body = await parseBody(req);
    const { serviceName, servicePrice, industry } = body;
    if (!serviceName) { sendJson(res, { error: 'serviceName lipsa' }, 400); return; }
    
    const prompt = `Ești expert în ${industry || 'servicii medicale'}. Generează informații detaliate pentru serviciul "${serviceName}"${servicePrice ? ' cu prețul ' + servicePrice : ''}.

Returnează DOAR JSON valid fără text suplimentar:
{
  "description": "descriere specifică 1-2 propoziții pentru client",
  "duration": "durata estimată (ex: 45 minute)",
  "benefits": ["beneficiu specific 1", "beneficiu specific 2", "beneficiu specific 3"],
  "preparation": "ce trebuie să facă clientul înainte",
  "faq": [
    {"q": "întrebare frecventă specifică", "a": "răspuns detaliat"},
    {"q": "altă întrebare frecventă", "a": "răspuns detaliat"}
  ]
}`;

    try {
      const result = await callClaude('Returnezi DOAR JSON valid, fără markdown, fără text extra.', prompt);
      const clean = result.replace(/\`\`\`json|\`\`\`/g, '').trim();
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        sendJson(res, { success: true, data: parsed });
      } else {
        sendJson(res, { success: false, error: 'JSON invalid' });
      }
    } catch(e) {
      sendJson(res, { success: false, error: e.message });
    }
    return;
  }

  // ── TEAM USERS ──────────────────────────────────
  if (pathname === '/api/team/invite' && req.method === 'POST') {
    const body = await parseBody(req);
    const { email, password, role, clientId, businessName } = body;
    if (!email || !password || !role || !clientId) { sendJson(res, { error: 'Date lipsă' }, 400); return; }
    
    if (storage.getUsers()[email]) { sendJson(res, { error: 'Email deja înregistrat' }, 400); return; }
    const token = 'tok_' + Math.random().toString(36).substring(2) + Date.now();
    storage.saveUser({ email, password, clientId, businessName, token, role, createdAt: new Date().toISOString() });
    console.log('[TEAM] Invited:', email, 'role:', role, 'clientId:', clientId);
    sendJson(res, { success: true, email, role });
    return;
  }

  if (pathname === '/api/team/delete' && req.method === 'POST') {
    const body = await parseBody(req);
    const { email, clientId } = body;
    const userToUp = storage.getUser(email);
    if (!userToUp) { sendJson(res, { error: 'Utilizator negăsit' }, 404); return; }
    if (storage.getUsers()[email].clientId !== clientId) { sendJson(res, { error: 'Acces interzis' }, 403); return; }
    if (storage.getUsers()[email].role === 'owner') { sendJson(res, { error: 'Nu poți șterge proprietarul' }, 400); return; }
    delete storage.getUsers()[email];
    sendJson(res, { success: true });
    return;
  }

  if (pathname === '/api/team/update' && req.method === 'POST') {
    const body = await parseBody(req);
    const { email, role, password, clientId } = body;
    const userToUp = storage.getUser(email);
    if (!userToUp) { sendJson(res, { error: 'Utilizator negăsit' }, 404); return; }
    if (storage.getUsers()[email].clientId !== clientId) { sendJson(res, { error: 'Acces interzis' }, 403); return; }
    if (role) storage.getUsers()[email].role = role;
    if (password) storage.getUsers()[email].password = password;
    // Regenerate token
    storage.getUsers()[email].token = 'tok_' + Math.random().toString(36).substring(2) + Date.now();
    sendJson(res, { success: true });
    return;
  }

  if (pathname === '/api/team/list' && req.method === 'GET') {
    const clientId = new URL('http://x' + req.url).searchParams.get('clientId');
    if (!clientId) { sendJson(res, { success: true, users: [] }); return; }
    const team = storage.getUsersByClientId(clientId)
      .map(u => ({ email: u.email, role: u.role, createdAt: u.createdAt }));
    sendJson(res, { success: true, users: team });
    return;
  }

  // ── CLINIC CONFIG ──────────────────────────────
  if (pathname === '/api/clinic/config' && req.method === 'GET') {
    const clientId = new URL('http://x' + req.url).searchParams.get('clientId');
    if (!clientId) { sendJson(res, { error: 'clientId lipsa' }, 400); return; }
    sendJson(res, { success: true, config: clinicConfig.get(clientId) });
    return;
  }

  if (pathname === '/api/clinic/config' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.clientId) { sendJson(res, { error: 'clientId lipsa' }, 400); return; }
    const config = clinicConfig.patch(body.clientId, body.config || body);
    sendJson(res, { success: true, config });
    return;
  }

  if (pathname === '/api/clinic/config/section' && req.method === 'POST') {
    const body = await parseBody(req);
    const { clientId, section, data } = body;
    if (!clientId || !section) { sendJson(res, { error: 'clientId si section lipsesc' }, 400); return; }
    const sectionMap = {
      hours: 'saveHours', booking: 'saveBooking', aiRules: 'saveAiRules',
      cabinets: 'saveCabinets', widget: 'saveWidget', features: 'saveFeatures',
      notifications: 'saveNotifications',
    };
    if (!sectionMap[section]) { sendJson(res, { error: 'Section necunoscut' }, 400); return; }
    const config = clinicConfig[sectionMap[section]](clientId, data);
    sendJson(res, { success: true, config });
    return;
  }

  if (pathname === '/api/clinic/import-brain' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.clientId) { sendJson(res, { error: 'clientId lipsa' }, 400); return; }
    const profile = storage.getProfile(body.clientId);
    if (!profile) { sendJson(res, { error: 'Profilul nu exista' }, 404); return; }
    const config = clinicConfig.importFromBrain(body.clientId, profile);
    sendJson(res, { success: true, config });
    return;
  }

  // ── GOOGLE OAUTH ──────────────────────────────────
  if (pathname === '/auth/google' && req.method === 'GET') {
    const p = new URL('http://x' + req.url).searchParams;
    const clientId = p.get('clientId');
    const scope = p.get('scope') || 'gmail';
    if (!clientId) { sendJson(res, { error: 'clientId lipsa' }, 400); return; }
    const url = googleAuth.getAuthUrl(clientId, scope);
    res.writeHead(302, { Location: url });
    res.end();
    return;
  }

  if (pathname === '/auth/google/callback' && req.method === 'GET') {
    const p = new URL('http://x' + req.url).searchParams;
    const code = p.get('code');
    const stateStr = p.get('state');
    if (!code) {
      res.writeHead(302, { Location: 'http://localhost:9090/frontend/client-dashboard.html?error=no_code' });
      res.end(); return;
    }
    try {
      const state = JSON.parse(stateStr || '{}');
      const tokens = await googleAuth.exchangeCode(code);
      const userInfo = await googleAuth.getUserInfo(tokens.access_token);
      const scope = state.scope || 'gmail';
      const clientId = state.clientId;

      // Save integration
      const settings = storage.getSettings(clientId);
      settings[scope] = {
        connected: true,
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        connectedAt: new Date().toISOString(),
      };
      storage.saveSettings(clientId, settings);
      storage.audit('integration.connect', { clientId, scope, email: userInfo.email });
      console.log('[GOOGLE] Connected', scope, 'for', clientId, '-', userInfo.email);

      res.writeHead(302, { Location: 'http://localhost:9090/frontend/client-dashboard.html?connected=' + scope });
      res.end();
    } catch(e) {
      console.error('[GOOGLE] OAuth error:', e.message);
      res.writeHead(302, { Location: 'http://localhost:9090/frontend/client-dashboard.html?error=' + encodeURIComponent(e.message) });
      res.end();
    }
    return;
  }

  if (pathname === '/api/integrations/status' && req.method === 'GET') {
    const clientId = new URL('http://x' + req.url).searchParams.get('clientId');
    const settings = storage.getSettings(clientId);
    sendJson(res, {
      success: true,
      integrations: {
        gmail: { connected: !!settings.gmail?.connected, email: settings.gmail?.email || null },
        calendar: { connected: !!settings.calendar?.connected, email: settings.calendar?.email || null },
        whatsapp: { connected: !!settings.whatsapp?.connected },
      }
    });
    return;
  }

  if (pathname === '/api/integrations/disconnect' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.clientId || !body.scope) { sendJson(res, { error: 'Date lipsesc' }, 400); return; }
    googleAuth.disconnect(body.clientId, body.scope);
    sendJson(res, { success: true });
    return;
  }

  if (pathname === '/api/gmail/send' && req.method === 'POST') {
    const body = await parseBody(req);
    const { clientId, to, subject, html, toName } = body;
    if (!clientId || !to || !subject) { sendJson(res, { error: 'Date lipsesc' }, 400); return; }
    try {
      const result = await googleAuth.sendGmail(clientId, to, subject, html || subject, toName);
      sendJson(res, { success: true, messageId: result.id });
    } catch(e) {
      sendJson(res, { success: false, error: e.message }, 500);
    }
    return;
  }

  // ── HEALTH MONITOR ──────────────────────────────
  if (pathname === '/api/health/full' && req.method === 'GET') {
    const clientId = new URL('http://x' + req.url).searchParams.get('clientId');
    const result = await healthMonitor.runAll(clientId);
    sendJson(res, result);
    return;
  }

  // ── NOTIFICATIONS ────────────────────────────────
  if (pathname === '/api/notify/send' && req.method === 'POST') {
    const body = await parseBody(req);
    const { type, appointmentId, clientId } = body;
    if (!type || !clientId) { sendJson(res, { error: 'type si clientId lipsesc' }, 400); return; }
    const appts = storage.getAppointments(clientId);
    const appt = appts.find(a => a.id === appointmentId) || body.appointment;
    if (!appt) { sendJson(res, { error: 'Programarea nu exista' }, 404); return; }
    const result = await notify(type, appt, clientId);
    sendJson(res, { success: true, ...result });
    return;
  }

  if (pathname === '/api/notify/test' && req.method === 'POST') {
    const body = await parseBody(req);
    const { clientId, phone, email } = body;
    const testAppt = {
      patient: { name: 'Test Pacient', phone, email },
      service: { name: 'Consultație test' },
      doctor: { name: 'Dr. Test' },
      date: new Date(Date.now() + 86400000).toISOString(),
      slot: '10:00',
    };
    const result = await notify('appointmentConfirmed', testAppt, clientId);
    sendJson(res, { success: true, ...result });
    return;
  }

  // ── AVAILABILITY ────────────────────────────────
  if (pathname === '/api/availability/slots' && req.method === 'GET') {
    const p = new URL('http://x' + req.url).searchParams;
    const clientId = p.get('clientId');
    const doctorId = p.get('doctorId');
    const date = p.get('date');
    const duration = parseInt(p.get('duration') || '30');
    if (!clientId || !date) { sendJson(res, { error: 'clientId si date lipsesc' }, 400); return; }
    if (doctorId) {
      sendJson(res, { success: true, ...availability.getSlots(clientId, doctorId, date, duration) });
    } else {
      sendJson(res, { success: true, doctors: availability.getSlotsAllDoctors(clientId, date, null, duration) });
    }
    return;
  }

  if (pathname === '/api/availability/suggest' && req.method === 'POST') {
    const body = await parseBody(req);
    const { clientId, serviceId, duration, preferredDate, preferredTime, count } = body;
    if (!clientId) { sendJson(res, { error: 'clientId lipsa' }, 400); return; }
    const suggestions = availability.suggestSlots(clientId, serviceId, duration || 30, preferredDate, preferredTime, count || 3);
    sendJson(res, { success: true, suggestions });
    return;
  }

  if (pathname === '/api/availability/doctors' && req.method === 'GET') {
    const clientId = new URL('http://x' + req.url).searchParams.get('clientId');
    sendJson(res, { success: true, doctors: availability.getDoctors(clientId) });
    return;
  }

  if (pathname === '/api/availability/doctors' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.clientId || !body.doctors) { sendJson(res, { error: 'Date lipsesc' }, 400); return; }
    availability.saveDoctors(body.clientId, body.doctors);
    sendJson(res, { success: true });
    return;
  }

  // ── AUDIT LOG ──────────────────────────────────
  if (pathname === '/api/audit' && req.method === 'GET') {
    const clientId = new URL('http://x' + req.url).searchParams.get('clientId');
    sendJson(res, { success: true, audit: storage.getAudit(clientId, 100) });
    return;
  }

  // ── STORAGE HEALTH ──────────────────────────────
  if (pathname === '/api/storage/health' && req.method === 'GET') {
    sendJson(res, { success: true, health: storage.health() });
    return;
  }

  // ── APPOINTMENTS ────────────────────────────────
  if (pathname === '/api/appointments' && req.method === 'GET') {
    const clientId = new URL('http://x' + req.url).searchParams.get('clientId');
    sendJson(res, { success: true, appointments: storage.getAppointments(clientId) });
    return;
  }

  if (pathname === '/api/appointments/save' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.clientId) { sendJson(res, { error: 'clientId lipsa' }, 400); return; }
    const appt = storage.saveAppointment({ ...body, id: body.id || 'appt_' + Date.now() });
    // Auto-notify patient
    if (body.notify !== false) {
      notify('appointmentConfirmed', appt, body.clientId).catch(e => console.error('[NOTIFY]', e.message));
    }
    sendJson(res, { success: true, appointment: appt });
    return;
  }

  if (pathname === '/api/appointments/status' && req.method === 'POST') {
    const body = await parseBody(req);
    storage.updateAppointmentStatus(body.clientId, body.id, body.status);
    sendJson(res, { success: true });
    return;
  }

  // ── BUSINESS BRAIN SCAN ──────────────────────
  if (pathname === '/api/brain/scan' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.url) { sendJson(res, { error: 'URL lipsa' }, 400); return; }
    if (!body.clientId) { sendJson(res, { error: 'clientId lipsa' }, 400); return; }
    try {
      const brain = await buildBusinessBrain(body.url, {
        onProgress: (pct, text) => console.log(`[BRAIN] ${pct}% ${text}`)
      });
      brain.clientId = body.clientId;
      // Save to profiles
      storage.saveProfile({ ...brain, clientId: body.clientId });
      saveProfiles();
      sendJson(res, { success: true, brain, clientId: body.clientId });
    } catch(e) {
      console.error('[BRAIN] Error:', e.message);
      sendJson(res, { success: false, error: e.message }, 500);
    }
    return;
  }

  // ── AUTH ──────────────────────────────────
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const body = await parseBody(req);
    const { email, password, clientId, businessName } = body;
    if (!email || !password) { sendJson(res, { error: 'Email și parolă obligatorii' }, 400); return; }
    
    if (storage.getUsers()[email]) { sendJson(res, { error: 'Email deja înregistrat' }, 400); return; }
    const token = 'tok_' + Math.random().toString(36).substring(2) + Date.now();
    // First user for this clientId = owner, rest = specified role
    const existingForClient = storage.getUsersByClientId(clientId);
    const role = existingForClient.length === 0 ? 'owner' : (body.role || 'reception');
    storage.saveUser({ email, password, clientId, businessName, token, role, createdAt: new Date().toISOString() });
    console.log('[AUTH] Registered:', email, 'clientId:', clientId);
    sendJson(res, { success: true, token, email, clientId, businessName, role: body.role || 'owner' });
    return;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await parseBody(req);
    const { email, password } = body;
    
    const user = storage.getUser(email);
    if (!user || user.password !== password) { sendJson(res, { error: 'Email sau parolă incorecte' }, 401); return; }
    console.log('[AUTH] Login:', email);
    sendJson(res, { success: true, token: user.token, email: user.email, clientId: user.clientId, businessName: user.businessName, role: user.role || 'owner' });
    return;
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token) { sendJson(res, { error: 'Neautentificat' }, 401); return; }
    const user = Object.values(storage.getUsers()).find(u => u.token === token);
    if (!user) { sendJson(res, { error: 'Token invalid' }, 401); return; }
    sendJson(res, { success: true, email: user.email, clientId: user.clientId, businessName: user.businessName });
    return;
  }

  // Save business profile
  if (pathname === '/api/profile/save' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.clientId) { sendJson(res, { error: 'clientId lipsa' }, 400); return; }
    const profilesFile = path.join(__dirname, '../data/profiles.json');
    let profiles = {};
    try { profiles = JSON.parse(fs.readFileSync(profilesFile, 'utf8')); } catch(e) {}
    profiles[body.clientId] = body;
    storage.saveProfile({ ...body, clientId: body.clientId });
    fs.mkdirSync(path.dirname(profilesFile), { recursive: true });
    fs.writeFileSync(profilesFile, JSON.stringify(profiles, null, 2));
    console.log('[PROFILE] Saved profile for:', body.clientId, body.name);
    sendJson(res, { success: true, clientId: body.clientId });
    return;
  }

  if (pathname.startsWith('/api/profile/') && req.method === 'GET') {
    const clientId = pathname.replace('/api/profile/', '');
    const profilesFile = path.join(__dirname, '../data/profiles.json');
    let profiles = {};
    try { profiles = JSON.parse(fs.readFileSync(profilesFile, 'utf8')); } catch(e) {}
    const profile = profiles[clientId];
    if (!profile) { sendJson(res, { error: 'Profile negasit' }, 404); return; }
    sendJson(res, { success: true, profile });
    return;
  }

  // Learning Engine Analytics
  if (pathname === '/api/learning/analytics' && req.method === 'GET') {
    const industry = new URL('http://x' + req.url).searchParams.get('industry');
    sendJson(res, { success: true, data: getAnalytics(industry) });
    return;
  }

  if (pathname === '/api/learning/gaps' && req.method === 'GET') {
    const gaps = loadGaps();
    const topGaps = Object.entries(gaps)
      .filter(([k,v]) => v.status === 'open')
      .sort(([,a],[,b]) => b.count - a.count)
      .slice(0, 50)
      .map(([key, gap]) => ({ key, ...gap }));
    sendJson(res, { success: true, gaps: topGaps });
    return;
  }

  if (pathname === '/api/learning/answer' && req.method === 'POST') {
    const body = await parseBody(req);
    const ok = addGlobalAnswer(body.key, body.answer);
    sendJson(res, { success: ok });
    return;
  }

  // Save lead + email
  if (pathname === '/api/lead' && req.method === 'POST') {
    const body = await parseBody(req);
    if (!body.clientId || !body.lead) { sendJson(res, { error: 'Date lipsă' }, 400); return; }
    const leads = saveLead(body.clientId, body.lead);
    const lead = body.lead;
    const businessName = body.businessName || 'Afacerea ta';
    const ownerEmail = body.ownerEmail || '';
    const businessPhone = body.businessPhone || '';
    console.log('[LEAD]', lead.nume, '|', lead.telefon, '|', lead.serviciu);
    sendJson(res, { success: true, total: leads.length });
    setImmediate(async () => {
      if (ownerEmail) { try { await notifyOwner(lead, businessName, ownerEmail); } catch (e) { console.error('[EMAIL] Owner:', e.message); } }
      if (lead.email) { try { await confirmClient(lead, businessName, businessPhone); } catch (e) { console.error('[EMAIL] Client:', e.message); } }
    });
    return;
  }

  // Get leads
  if (pathname.startsWith('/api/leads/') && req.method === 'GET') {
    const clientId = pathname.replace('/api/leads/', '');
    const leads = loadLeads();
    sendJson(res, { success: true, leads: leads[clientId] || [], total: (leads[clientId] || []).length });
    return;
  }

  // Static files
  let filePath = pathname === '/' ? '/frontend/index.html' : pathname;
  filePath = path.join(ROOT, filePath);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<h1>404</h1><a href="/">Acasă</a>');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║     RecepAI Server v2.0              ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  http://localhost:${PORT}              ║`);
  console.log(`║  Claude: ${CLAUDE_API_KEY ? '✓ Activ  ' : '✗ Lipsă  '}                ║`);
  console.log(`║  Brevo:  ${BREVO_API_KEY ? '✓ Activ  ' : '✗ Lipsă  '}                ║`);
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  console.log('Îmbunătățiri v2.0:');
  console.log('  ✓ Multi-page fetch (tarife, preturi, servicii)');
  console.log('  ✓ Auto-detect pagini cu prețuri din meniu');
  console.log('  ✓ Extragere directă Facebook/Instagram/Email din HTML');
  console.log('  ✓ Override Claude cu linkuri detectate direct');
  console.log('  ✓ URL parsing sigur (fără crash)');
  console.log('  ✓ Răspuns corect noaptea vs ziua');
  console.log('');
});
