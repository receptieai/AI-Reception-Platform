const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 8080;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'receptieai@proton.me';

// Root directory = project root (one level up from backend/)
const ROOT = path.join(__dirname, '..');

const MIME = {
  '.html':'text/html;charset=utf-8',
  '.js':'application/javascript',
  '.css':'text/css',
  '.json':'application/json',
  '.png':'image/png',
  '.jpg':'image/jpeg',
  '.svg':'image/svg+xml',
  '.ico':'image/x-icon',
  '.md':'text/plain'
};

// ── LEADS ─────────────────────────────────────
const DATA_DIR = path.join(ROOT, 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');

function loadLeads() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, {recursive:true});
    if (!fs.existsSync(LEADS_FILE)) return {};
    return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
  } catch(e) { return {}; }
}

function saveLead(clientId, lead) {
  const leads = loadLeads();
  if (!leads[clientId]) leads[clientId] = [];
  leads[clientId].push({...lead, id:Date.now().toString(36), timestamp:new Date().toISOString()});
  try { fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2)); } catch(e) {}
  return leads[clientId];
}

// ── EMAIL ─────────────────────────────────────
function sendEmail({to, toName, subject, html}) {
  return new Promise((resolve, reject) => {
    if (!BREVO_API_KEY) { console.log('[EMAIL] No key'); resolve({skipped:true}); return; }
    if (!to || !to.includes('@')) { resolve({skipped:true}); return; }
    const body = JSON.stringify({
      sender:{name:'RecepAI', email:FROM_EMAIL},
      to:[{email:to, name:toName||to}],
      subject, htmlContent:html
    });
    const req = https.request({
      hostname:'api.brevo.com', path:'/v3/smtp/email', method:'POST',
      headers:{'Content-Type':'application/json','api-key':BREVO_API_KEY,'Content-Length':Buffer.byteLength(body)},
      timeout:10000
    }, (res) => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{
        if(res.statusCode>=200&&res.statusCode<300){console.log('[EMAIL] ✓',subject,'→',to);resolve({success:true});}
        else{console.error('[EMAIL] Error:',res.statusCode,d);reject(new Error('Email failed'));}
      });
    });
    req.on('error',reject); req.write(body); req.end();
  });
}

function notifyOwner(lead, businessName, ownerEmail) {
  return sendEmail({
    to: ownerEmail, toName: businessName,
    subject: `🔔 Lead nou — ${lead.nume||'Client'} vrea programare`,
    html: `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
<h2 style="color:#00D4AA">RecepAI — Lead nou!</h2>
<p>Afacere: <b>${businessName}</b></p>
<div style="background:#f5f5f5;padding:16px;border-left:4px solid #00D4AA;border-radius:4px;margin:16px 0">
<p>👤 <b>Nume:</b> ${lead.nume||'—'}</p>
<p>📞 <b>Telefon:</b> <a href="tel:${(lead.telefon||'').replace(/\s/g,'')}">${lead.telefon||'—'}</a></p>
${lead.serviciu?`<p>🔧 <b>Serviciu:</b> ${lead.serviciu}</p>`:''}
${lead.data_dorita?`<p>📅 <b>Data:</b> ${lead.data_dorita}</p>`:''}
</div>
<a href="tel:${(lead.telefon||'').replace(/\s/g,'')}" style="background:#00D4AA;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">
📞 Sună acum
</a>
<p style="color:#999;font-size:12px;margin-top:16px">Powered by RecepAI · receptieai.ro</p>
</div>`
  });
}

function confirmClient(lead, businessName, businessPhone) {
  if (!lead.email || !lead.email.includes('@')) return Promise.resolve({skipped:true});
  return sendEmail({
    to: lead.email, toName: lead.nume||'Client',
    subject: `✅ Solicitarea ta la ${businessName} a fost înregistrată`,
    html: `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px;text-align:center">
<h2 style="color:#00D4AA">✅ Solicitare înregistrată!</h2>
<p>Bună ziua <b>${lead.nume||'Client'}</b>!<br>${businessName} te va contacta în maximum 2 ore.</p>
${lead.serviciu?`<p>🔧 Serviciu: <b>${lead.serviciu}</b></p>`:''}
${lead.data_dorita?`<p>📅 Data: <b>${lead.data_dorita}</b></p>`:''}
${businessPhone?`<a href="tel:${businessPhone.replace(/\s/g,'')}" style="background:#000;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block">📞 ${businessPhone}</a>`:''}
<p style="color:#999;font-size:12px;margin-top:16px">Powered by RecepAI · receptieai.ro</p>
</div>`
  });
}

// ── CLAUDE ────────────────────────────────────
function callClaude(system, user) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({model:'claude-sonnet-4-6',max_tokens:2000,system,messages:[{role:'user',content:user}]});
    const req = https.request({
      hostname:'api.anthropic.com', path:'/v1/messages', method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':CLAUDE_API_KEY,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(body)},
      timeout:30000
    }, (res) => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{try{const p=JSON.parse(d);resolve(p.content?.[0]?.text||'');}catch(e){reject(e);}});
    });
    req.on('timeout',()=>{req.destroy();reject(new Error('Timeout'));});
    req.on('error',reject); req.write(body); req.end();
  });
}

function fetchSite(siteUrl) {
  return new Promise((resolve, reject) => {
    let u = siteUrl;
    if (!u.startsWith('http')) u = 'https://' + u;
    const parsed = new URL(u);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname:parsed.hostname, path:parsed.pathname||'/', method:'GET',
      headers:{'User-Agent':'Mozilla/5.0 RecepAI/1.0'}, timeout:12000
    }, (res) => {
      if (res.statusCode>=300&&res.statusCode<400&&res.headers.location) {
        fetchSite(res.headers.location).then(resolve).catch(reject); return;
      }
      let d=''; res.setEncoding('utf8');
      res.on('data',c=>{d+=c;if(d.length>150000){req.destroy();resolve(d);}});
      res.on('end',()=>resolve(d));
    });
    req.on('timeout',()=>{req.destroy();reject(new Error('Timeout'));});
    req.on('error',reject); req.end();
  });
}

function extractLinks(html) {
  const links = {};
  const fb = html.match(/href=["'](https?:\/\/(?:www\.)?facebook\.com\/[^"'\s?]+)["']/i);
  const ig = html.match(/href=["'](https?:\/\/(?:www\.)?instagram\.com\/[^"'\s?]+)["']/i);
  const em = html.match(/href=["']mailto:([^"'\s]+)["']/i);
  if(fb) links.facebook = fb[1];
  if(ig) links.instagram = ig[1];
  if(em) links.email = em[1];
  return links;
}

function stripHtml(h) {
  return h.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'')
    .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().substring(0,15000);
}

function makeFallback(domain) {
  const s = domain.toLowerCase();
  let type='💇 Salon Beauty', services=[{name:'Serviciu 1',price:'100 LEI'},{name:'Serviciu 2',price:'150 LEI'},{name:'Serviciu 3',price:'200 LEI'}];
  if(s.includes('dent')||s.includes('stomat')||s.includes('clinic')||s.includes('medic')||s.includes('dental')){type='🦷 Cabinet Dentar';services=[{name:'Consultatie',price:'80 LEI'},{name:'Detartraj',price:'180 LEI'},{name:'Plomba',price:'280 LEI'}];}
  else if(s.includes('vet')||s.includes('animal')||s.includes('biovet')){type='🐾 Cabinet Veterinar';services=[{name:'Consultatie',price:'150 LEI'},{name:'Vaccinare',price:'150 LEI'},{name:'Castrare',price:'300 LEI'}];}
  else if(s.includes('fizio')||s.includes('recuper')){type='💆 Fizioterapie';services=[{name:'Sedinta',price:'120 LEI'},{name:'Masaj',price:'150 LEI'}];}
  else if(s.includes('auto')||s.includes('service')||s.includes('landrover')||s.includes('bmw')||s.includes('mercedes')||s.includes('dacia')){type='🚗 Service Auto';services=[{name:'Revizie',price:'350 LEI'},{name:'Schimb ulei',price:'150 LEI'}];}
  const name = domain.replace(/^www\./,'').split('.')[0].replace(/-/g,' ').replace(/\b\w/g,l=>l.toUpperCase());
  return {name,type,phone:null,email:`contact@${domain}`,city:null,hours:'Luni-Vineri 09:00-19:00',services,faq:[],confidence:45,missing:['telefon','oras','preturi'],mock:true};
}

// ── HELPERS ───────────────────────────────────
function setCors(res){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');}
function parseBody(req){return new Promise(r=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{r(JSON.parse(b||'{}'))}catch{r({})}})});}
function sendJson(res,data,s=200){res.writeHead(s,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}

// ── SERVER ────────────────────────────────────
const server = http.createServer(async(req, res) => {
  setCors(res);
  const pathname = url.parse(req.url, true).pathname;
  if(req.method==='OPTIONS'){res.writeHead(200);res.end();return;}

  // Health
  if(pathname==='/api/health'&&req.method==='GET'){
    sendJson(res,{status:'ok',version:'1.1.0',timestamp:new Date().toISOString(),claude:CLAUDE_API_KEY?'✓':'✗',brevo:BREVO_API_KEY?'✓':'✗'});
    return;
  }

  // Analyze
  if(pathname==='/api/analyze'&&req.method==='POST'){
    const body = await parseBody(req);
    if(!body.url){sendJson(res,{error:'URL lipsa'},400);return;}
    const domain = body.url.replace(/^https?:\/\//,'').replace(/\/.*/,'');
    if(!CLAUDE_API_KEY){sendJson(res,{success:true,data:makeFallback(domain),mock:true});return;}
    try{
      let html='';
      try{
  html=await fetchSite(body.url);
  try{
    const base=body.url.replace(/\/$/,'');
    const pages=['/contact','/tarife','/preturi','/servicii','/despre-noi'];
    for(const page of pages){
      try{
        const extra=await fetchSite(base+page);
        html+=' '+extra;
        if(html.length>100000) break;
      }catch(e3){}
    }
  }catch(e2){}
}catch(e){console.log('[ANALYZE] Fetch failed:',e.message);}
      const links = html ? extractLinks(html) : {};
      const text = html ? stripHtml(html) : '';
      const prompt = text
        ?`Analizeaza website-ul romanesc: ${body.url}\nLinkuri detectate automat: facebook=${links.facebook||'negasit'} instagram=${links.instagram||'negasit'} email=${links.email||'negasit'}\nContinut:\n${text}\nCauta emailuri in tot textul inclusiv "mailto:", "office@", "contact@", "email:". Returneaza DOAR JSON:\n{"name":"","type":"tip cu emoji","phone":null,"email":null,"city":null,"hours":null,"services":[{"name":"numele serviciului","price":"pretul in LEI sau EUR exact cum apare pe site (ex: 100 Lei, 300 Lei/30 min)","duration":"durata daca e mentionata"}],"faq":[{"question":"","answer":""}],"facebook":null,"instagram":null,"confidence":85,"missing":[]}`
        :`Genereaza profil pentru domeniu: ${domain}\nJSON: {"name":"","type":"tip cu emoji","phone":null,"email":null,"city":null,"hours":null,"services":[{"name":"","price":""}],"faq":[],"confidence":45,"missing":[]}`;
      const result = await callClaude('Esti expert afaceri Romania. Cauta TOATE emailurile in text inclusiv "mailto:", "@", "office@", "contact@". Returneaza DOAR JSON valid.',prompt);
      const parsed = JSON.parse(result.replace(/```json|```/g,'').trim());
      console.log('[ANALYZE]',parsed.name,'Conf:',parsed.confidence+'%');
      sendJson(res,{success:true,data:parsed});
    }catch(e){
      console.error('[ANALYZE] Error:',e.message);
      sendJson(res,{success:true,data:makeFallback(domain),mock:true});
    }
    return;
  }

  // Chat
  if(pathname==='/api/chat'&&req.method==='POST'){
    const body = await parseBody(req);
    if(!body.messages||!body.businessProfile){sendJson(res,{error:'Date lipsa'},400);return;}
    if(!CLAUDE_API_KEY){sendJson(res,{success:true,message:'Buna ziua! Va pot ajuta cu o programare.',mock:true});return;}
    try{
      const profile = body.businessProfile;
      const services = (profile.services||[]).map(s=>`• ${s.name}: ${s.price||'la cerere'}`).join('\n');
      const system = `Esti recepționistul virtual al "${profile.name||'afacerii'}" din ${profile.city||'România'}.
Vorbești DOAR română. Nu dai sfaturi medicale. Nu inventezi prețuri.
Răspunsuri scurte (max 4 propoziții). Colectezi: NUME + TELEFON + SERVICIU.
SERVICII:\n${services||'Contactati-ne'}
PROGRAM: ${profile.hours||'Luni-Vineri 09:00-19:00'}
LA FINAL: "Veți fi contactat în maximum 2 ore pentru confirmare."`;
      const userMsg = body.messages.map(m=>`${m.role==='user'?'Client':'Asistent'}: ${m.content}`).join('\n\n');
      const reply = await callClaude(system, userMsg);
      sendJson(res,{success:true,message:reply});
    }catch(e){sendJson(res,{error:'Chat error'},500);}
    return;
  }

  // Lead + email
  if(pathname==='/api/lead'&&req.method==='POST'){
    const body = await parseBody(req);
    if(!body.clientId||!body.lead){sendJson(res,{error:'Date lipsa'},400);return;}
    const leads = saveLead(body.clientId, body.lead);
    const lead = body.lead;
    const businessName = body.businessName||'Afacerea ta';
    const ownerEmail = body.ownerEmail||'';
    const businessPhone = body.businessPhone||'';
    console.log('[LEAD]',lead.nume,'|',lead.telefon,'|',lead.serviciu);
    sendJson(res,{success:true,total:leads.length});
    setImmediate(async()=>{
      if(ownerEmail){try{await notifyOwner(lead,businessName,ownerEmail);}catch(e){console.error('[EMAIL] Owner:',e.message);}}
      if(lead.email){try{await confirmClient(lead,businessName,businessPhone);}catch(e){console.error('[EMAIL] Client:',e.message);}}
    });
    return;
  }

  // Get leads
  if(pathname.startsWith('/api/leads/')&&req.method==='GET'){
    const clientId = pathname.replace('/api/leads/','');
    const leads = loadLeads();
    sendJson(res,{success:true,leads:leads[clientId]||[],total:(leads[clientId]||[]).length});
    return;
  }

  // Static files
  let filePath = pathname==='/' ? '/frontend/index.html' : pathname;
  filePath = path.join(ROOT, filePath);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, content) => {
    if(err){
      // Try index.html for SPA routing
      fs.readFile(path.join(ROOT,'frontend','index.html'),(err2,content2)=>{
        if(err2){res.writeHead(404);res.end('404 Not Found');return;}
        res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
        res.end(content2);
      });
      return;
    }
    res.writeHead(200,{'Content-Type':MIME[ext]||'text/plain'});
    res.end(content);
  });
});

server.listen(PORT, ()=>{
  console.log(`\nRecepAI v1.1 → http://localhost:${PORT}`);
  console.log(`Claude: ${CLAUDE_API_KEY?'✓':'✗'} | Brevo: ${BREVO_API_KEY?'✓':'✗'}\n`);
});
// Patch applied via terminal
