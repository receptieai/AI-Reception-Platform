/**
 * RecepAI — Backend Server Complet
 * receptieai.ro
 * 
 * Endpoints:
 * GET  /              → Health check
 * POST /api/analyze   → Analizează un URL și returnează Business Profile
 * POST /api/chat      → Chat cu AI Receptionist
 * POST /api/lead      → Salvează un lead nou
 * GET  /api/leads/:clientId → Returnează leads pentru un client
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 8080;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';

// ── MIME TYPES ────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.md':   'text/markdown',
};

// ── LEADS DATABASE (in-memory, JSON file pe disk) ─
const LEADS_FILE = path.join(__dirname, 'data', 'leads.json');

function loadLeads() {
  try {
    if (!fs.existsSync(path.join(__dirname, 'data'))) {
      fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    }
    if (!fs.existsSync(LEADS_FILE)) return {};
    return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
  } catch(e) { return {}; }
}

function saveLead(clientId, lead) {
  const leads = loadLeads();
  if (!leads[clientId]) leads[clientId] = [];
  leads[clientId].push({
    ...lead,
    id: Date.now().toString(36),
    timestamp: new Date().toISOString(),
  });
  try {
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
  } catch(e) { console.error('Error saving lead:', e); }
  return leads[clientId];
}

// ── FETCH WEBSITE HTML ────────────────────────
function fetchWebsite(siteUrl) {
  return new Promise((resolve, reject) => {
    // Ensure URL has protocol
    let fullUrl = siteUrl;
    if (!fullUrl.startsWith('http')) {
      fullUrl = 'https://' + fullUrl;
    }

    const parsedUrl = new URL(fullUrl);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname || '/',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RecepAI/1.0; +https://receptieai.ro)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ro,en;q=0.9',
      },
      timeout: 10000,
    };

    const req = protocol.request(options, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchWebsite(res.headers.location).then(resolve).catch(reject);
        return;
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { 
        data += chunk; 
        // Limit to 50KB to avoid huge pages
        if (data.length > 50000) { 
          req.destroy();
          resolve(data.substring(0, 50000)); 
        }
      });
      res.on('end', () => resolve(data));
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ── STRIP HTML ───────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim()
    .substring(0, 8000); // Max 8000 chars pentru Claude
}

// ── CALL CLAUDE API ───────────────────────────
function callClaude(systemPrompt, userMessage) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.content && parsed.content[0]) {
            resolve(parsed.content[0].text);
          } else {
            reject(new Error('Invalid Claude response: ' + data));
          }
        } catch(e) { reject(e); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Claude timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── ANALYZE URL ──────────────────────────────
async function analyzeUrl(siteUrl) {
  console.log('[ANALYZE] Starting analysis for:', siteUrl);

  let htmlContent = '';
  let fetchError = false;

  try {
    htmlContent = await fetchWebsite(siteUrl);
    console.log('[ANALYZE] Fetched', htmlContent.length, 'chars');
  } catch(e) {
    console.log('[ANALYZE] Fetch failed:', e.message, '— using URL-based analysis');
    fetchError = true;
  }

  const textContent = fetchError ? '' : stripHtml(htmlContent);
  const domain = siteUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  const systemPrompt = `Ești un expert în analiza afacerilor locale din România.
Analizezi conținutul unui website și extragi informații structurate.
Returnezi DOAR JSON valid, fără text suplimentar, fără markdown.`;

  const userMessage = fetchError
    ? `Analizează URL-ul: ${siteUrl}
       Domeniu: ${domain}
       Nu am putut accesa site-ul. Generează un profil realist bazat pe numele domeniului.`
    : `Analizează conținutul acestui website românesc și extrage informațiile structurate.

URL: ${siteUrl}
Domeniu: ${domain}

Conținut website:
${textContent}

Returnează EXACT acest JSON (completează cu datele găsite, sau null dacă nu găsești):
{
  "name": "Numele afacerii",
  "type": "tipul cu emoji (ex: 💇‍♀️ Salon Beauty sau 🦷 Cabinet Dentar)",
  "phone": "număr telefon sau null",
  "email": "email sau null", 
  "address": "adresa sau null",
  "city": "orașul sau null",
  "hours": "programul de lucru sau null",
  "facebook": "link facebook sau null",
  "instagram": "link instagram sau null",
  "services": [
    {"name": "serviciu", "price": "preț în LEI sau null", "duration": "durată sau null"}
  ],
  "faq": [
    {"question": "întrebare frecventă", "answer": "răspuns"}
  ],
  "description": "descriere scurtă a afacerii în română (2-3 propoziții)",
  "tone": "prietenos sau profesionist sau elegant sau cald",
  "confidence": număr între 60 și 95,
  "missing": ["lista cu ce informații lipsesc de pe site"],
  "language": "ro"
}`;

  try {
    const result = await callClaude(systemPrompt, userMessage);
    const cleanResult = result.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleanResult);
    console.log('[ANALYZE] Success:', parsed.name, '| Confidence:', parsed.confidence);
    return { success: true, data: parsed };
  } catch(e) {
    console.error('[ANALYZE] Claude error:', e.message);
    // Fallback inteligent bazat pe domeniu
    return { success: true, data: generateFallback(domain) };
  }
}

// ── SMART FALLBACK ────────────────────────────
function generateFallback(domain) {
  const lower = domain.toLowerCase();
  let type = '💇‍♀️ Salon Beauty';
  let services = [
    {name:'Tuns + coafat', price:'80 LEI', duration:'45 min'},
    {name:'Vopsit complet', price:'150 LEI', duration:'2h'},
    {name:'Manichiură gel', price:'120 LEI', duration:'1h'},
  ];

  if (lower.includes('dent') || lower.includes('stomat') || lower.includes('clinic')) {
    type = '🦷 Cabinet Stomatologic';
    services = [
      {name:'Consultație', price:'80 LEI', duration:'30 min'},
      {name:'Detartraj', price:'180 LEI', duration:'45 min'},
      {name:'Albire', price:'600 LEI', duration:'2h'},
      {name:'Plombă', price:'280 LEI', duration:'1h'},
    ];
  } else if (lower.includes('vet') || lower.includes('animal')) {
    type = '🐾 Cabinet Veterinar';
    services = [
      {name:'Consultație', price:'150 LEI', duration:'30 min'},
      {name:'Vaccinare polivalentă', price:'150 LEI', duration:'20 min'},
      {name:'Vaccinare antirabică', price:'70 LEI', duration:'15 min'},
      {name:'Castrare pisică', price:'300 LEI', duration:'2h'},
    ];
  } else if (lower.includes('fizio') || lower.includes('recuper') || lower.includes('kine')) {
    type = '💆 Fizioterapie';
    services = [
      {name:'Evaluare inițială', price:'100 LEI', duration:'1h'},
      {name:'Ședință fizioterapie', price:'120 LEI', duration:'1h'},
      {name:'Masaj terapeutic', price:'150 LEI', duration:'1h'},
    ];
  } else if (lower.includes('auto') || lower.includes('service') || lower.includes('car')) {
    type = '🚗 Service Auto';
    services = [
      {name:'Revizie completă', price:'350 LEI', duration:'3h'},
      {name:'Schimb ulei', price:'150 LEI', duration:'1h'},
      {name:'Geometrie roți', price:'100 LEI', duration:'1h'},
    ];
  }

  const name = domain.split('.')[0]
    .replace(/-/g, ' ')
    .replace(/\b\w/g, l => l.toUpperCase());

  return {
    name,
    type,
    phone: null,
    email: `contact@${domain}`,
    address: null,
    city: null,
    hours: 'Luni-Vineri 09:00-19:00, Sâmbătă 09:00-14:00',
    facebook: null,
    instagram: null,
    services,
    faq: [],
    description: `${name} este o afacere locală specializată în ${type.replace(/[^\w\s]/gi, '').trim()}.`,
    tone: 'prietenos',
    confidence: 45,
    missing: ['telefon', 'adresă', 'program exact', 'prețuri complete'],
    language: 'ro',
  };
}

// ── CHAT WITH AI ──────────────────────────────
async function chatWithAI(messages, businessProfile, personality) {
  const services = (businessProfile.services || [])
    .map(s => `• ${s.name}: ${s.price || 'preț la cerere'}${s.duration ? ' ('+s.duration+')' : ''}`)
    .join('\n');

  const tones = {
    prietenos: 'prietenos, cald, folosești emoji-uri cu moderație',
    profesionist: 'profesionist, formal, fără emoji-uri',
    elegant: 'elegant, sofisticat, rafinat',
    cald: 'foarte empatic și grijuliu',
    dinamic: 'rapid, direct, concis',
  };

  const systemPrompt = `Ești recepționistul virtual al "${businessProfile.name || 'acestei afaceri'}" din ${businessProfile.city || 'România'}.

TON: ${tones[personality || 'prietenos'] || tones.prietenos}

REGULI STRICTE:
- Vorbești DOAR în română
- Nu dai sfaturi medicale sau veterinare
- Nu inventezi prețuri sau servicii inexistente  
- Dacă nu știi → "Vă rog sunați la ${businessProfile.phone || 'recepție'}"
- Răspunsuri scurte — maxim 4 propoziții
- Colectezi întotdeauna: NUME + TELEFON + SERVICIU dorit

SERVICII DISPONIBILE:
${services || 'Contactați-ne pentru lista completă de servicii'}

PROGRAM: ${businessProfile.hours || 'Luni-Vineri 09:00-19:00'}

TELEFON: ${businessProfile.phone || 'disponibil pe site'}

CÂND CLIENTUL VREA PROGRAMARE:
1. Cere numele
2. Cere telefonul  
3. Cere serviciul dorit
4. Cere ziua preferată
5. Confirmă: "Veți fi contactat în max 2 ore!"

LA FINAL MEREU: "Veți fi contactat în maximum 2 ore pentru confirmare."`;

  try {
    const result = await callClaude(systemPrompt, 
      messages.map(m => `${m.role === 'user' ? 'Client' : 'Asistent'}: ${m.content}`).join('\n\n') 
    );
    return { success: true, message: result };
  } catch(e) {
    console.error('[CHAT] Error:', e.message);
    return { success: false, message: 'Îmi pare rău, a apărut o eroare. Vă rog să sunați direct.' };
  }
}

// ── CORS HEADERS ──────────────────────────────
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── PARSE BODY ────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch(e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ── SEND JSON ─────────────────────────────────
function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── SERVE STATIC FILES ────────────────────────
function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/frontend/index.html' : req.url;
  
  // Remove query string
  filePath = filePath.split('?')[0];
  
  // Security: prevent directory traversal
  filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
  
  const fullPath = path.join(__dirname, filePath);
  const ext = path.extname(fullPath);
  const contentType = MIME[ext] || 'text/plain';

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      // Try without leading slash
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end(`<h1>404 — Pagina nu există</h1><p><a href="/">Înapoi acasă</a></p>`);
      } else {
        res.writeHead(500);
        res.end('Server error');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

// ── MAIN SERVER ───────────────────────────────
const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}`);

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // ── API ROUTES ────────────────────────────

  // Health check
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, { 
      status: 'ok', 
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      claude: CLAUDE_API_KEY ? 'configured' : 'missing — set CLAUDE_API_KEY env var',
    });
    return;
  }

  // Analyze URL
  if (pathname === '/api/analyze' && req.method === 'POST') {
    const body = await parseBody(req);
    
    if (!body.url) {
      sendJson(res, { error: 'URL lipsă' }, 400);
      return;
    }

    if (!CLAUDE_API_KEY) {
      // Return mock if no API key
      console.log('[ANALYZE] No API key — returning mock data');
      const domain = body.url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      sendJson(res, { success: true, data: generateFallback(domain), mock: true });
      return;
    }

    try {
      const result = await analyzeUrl(body.url);
      sendJson(res, result);
    } catch(e) {
      console.error('[ANALYZE] Error:', e);
      sendJson(res, { error: 'Analiza a eșuat. Verificați URL-ul.' }, 500);
    }
    return;
  }

  // Chat endpoint
  if (pathname === '/api/chat' && req.method === 'POST') {
    const body = await parseBody(req);
    
    if (!body.messages || !body.businessProfile) {
      sendJson(res, { error: 'Date lipsă' }, 400);
      return;
    }

    if (!CLAUDE_API_KEY) {
      sendJson(res, { 
        success: true, 
        message: 'Bună ziua! Vă pot ajuta cu o programare sau informații despre servicii.',
        mock: true 
      });
      return;
    }

    try {
      const result = await chatWithAI(body.messages, body.businessProfile, body.personality);
      sendJson(res, result);
    } catch(e) {
      sendJson(res, { error: 'Chat error' }, 500);
    }
    return;
  }

  // Save lead
  if (pathname === '/api/lead' && req.method === 'POST') {
    const body = await parseBody(req);
    
    if (!body.clientId || !body.lead) {
      sendJson(res, { error: 'Date lipsă' }, 400);
      return;
    }

    const leads = saveLead(body.clientId, body.lead);
    console.log('[LEAD] Saved for client:', body.clientId, '| Total:', leads.length);
    sendJson(res, { success: true, total: leads.length });
    return;
  }

  // Get leads
  if (pathname.startsWith('/api/leads/') && req.method === 'GET') {
    const clientId = pathname.replace('/api/leads/', '');
    const leads = loadLeads();
    sendJson(res, { 
      success: true, 
      leads: leads[clientId] || [],
      total: (leads[clientId] || []).length,
    });
    return;
  }

  // ── STATIC FILES ──────────────────────────
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║       RecepAI Server v1.0            ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Local:  http://localhost:${PORT}       ║`);
  console.log(`║  API:    http://localhost:${PORT}/api   ║`);
  console.log(`║  Claude: ${CLAUDE_API_KEY ? '✓ Configured' : '✗ Missing API Key'}          ║`);
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  console.log('Endpoints disponibile:');
  console.log('  GET  /api/health');
  console.log('  POST /api/analyze  — { url: "site.ro" }');
  console.log('  POST /api/chat     — { messages, businessProfile, personality }');
  console.log('  POST /api/lead     — { clientId, lead }');
  console.log('  GET  /api/leads/:clientId');
  console.log('');
  if (!CLAUDE_API_KEY) {
    console.log('⚠️  CLAUDE_API_KEY lipsă! Setează cu:');
    console.log('   export CLAUDE_API_KEY="sk-ant-..."');
    console.log('   node backend/server-full.js');
    console.log('');
  }
});

module.exports = server;
