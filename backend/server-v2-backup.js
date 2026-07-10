/**
 * RecepAI Server v2.0
 * Scanner îmbunătățit cu multi-page fetch
 * Lecții învățate: fetch pagini cu prețuri + extragere directă linkuri din HTML
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { extractAll } = require('./extractors');
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
        'User-Agent': 'Mozilla/5.0 (compatible; RecepAI/2.0; +https://receptieai.ro)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ro,en;q=0.9',
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
      res.on('data', c => { d += c; if (d.length > 200000) { req.destroy(); resolve(d); } });
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
      // Playwright doar pentru primele 2 pagini JS si doar daca nu avem destul continut
      const pageIndex = allPriceUrls.indexOf(pageUrl);
      if (needsBrowser(pageHtml) && extraContent.length < 15000 && pageIndex < 2) {
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
  const fullText = (homepageText.substring(0, 2000) + ' ' + extraContent.substring(0, 4000)).substring(0, 6000);

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
      // Confidence: combina extractoare (deterministe) cu Claude (semantice)
      const finalServices = parsed.services || [];
      const finalWithPrices = finalServices.filter(s => s.price).length;
      const detConf = detExtracted._confidence;
      parsed.fieldConfidence = {
        ...detConf,
        // Override services/prices cu datele finale (Claude + extractoare)
        services: finalServices.length > 10 ? 90 : finalServices.length > 3 ? 70 : finalServices.length > 0 ? 50 : 0,
        prices: finalWithPrices > 10 ? 90 : finalWithPrices > 3 ? 70 : finalWithPrices > 0 ? 50 : 0,
      };
    // Recalculează confidence global din toate sursele
    const weights = {phone:15,email:10,name:15,city:5,hours:10,services:25,prices:15,facebook:3,instagram:2};
    let wSum=0, wTotal=0;
    Object.entries(weights).forEach(([k,w])=>{
      const val = parsed.fieldConfidence[k] || 0;
      wSum += val * w; wTotal += w * 100;
    });
    parsed.confidence = Math.round(wSum / wTotal * 100);
    console.log('[EXTRACTORS] Recalculated confidence:', parsed.confidence, '%');
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
  
  const system = `Ești recepționistul virtual al "${profile.name || 'acestei afaceri'}" din ${profile.city || 'România'}.
Ton: ${tones[personality || 'prietenos'] || tones.prietenos}

REGULI STRICTE:
- Vorbești DOAR în română
- Nu dai sfaturi medicale sau veterinare
- Nu inventezi prețuri sau servicii inexistente
- Dacă nu știi → "Vă rog sunați la ${profile.phone || 'recepție'}"
- Răspunsuri scurte — maxim 4 propoziții
- Colectezi întotdeauna: NUME + TELEFON + SERVICIU dorit

SERVICII DISPONIBILE:
${services || 'Contactați-ne pentru lista completă de servicii'}

PROGRAM: ${profile.hours || 'Luni-Vineri 09:00-19:00'}

CÂND CLIENTUL VREA PROGRAMARE:
1. Cere numele
2. Cere telefonul
3. Cere serviciul dorit
4. Cere ziua preferată
5. ${isWorkingHours
    ? 'Confirmă: "Veți fi contactat în maximum 2 ore!"'
    : 'Confirmă: "Solicitarea a fost înregistrată! Vă vom contacta mâine în cursul programului nostru de lucru."'}`;

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
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

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
  setCors(res);
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
      const result = await chatWithAI(body.messages, body.businessProfile, body.personality);
      sendJson(res, result);
    } catch (e) { sendJson(res, { error: 'Chat error' }, 500); }
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
