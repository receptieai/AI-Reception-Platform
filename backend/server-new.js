const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 9090;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';
const MIME = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json'};

function setCors(res){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');}
function parseBody(req){return new Promise(r=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{r(JSON.parse(b||'{}'))}catch{r({})}})});}
function sendJson(res,data,s=200){res.writeHead(s,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}

function stripHtml(html){return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().substring(0,8000);}

function fetchSite(siteUrl){
  return new Promise((resolve,reject)=>{
    let fullUrl=siteUrl;
    if(!fullUrl.startsWith('http'))fullUrl='https://'+fullUrl;
    const parsed=new URL(fullUrl);
    const mod=parsed.protocol==='https:'?https:http;
    const req=mod.request({hostname:parsed.hostname,path:parsed.pathname||'/',method:'GET',headers:{'User-Agent':'Mozilla/5.0 RecepAI/1.0'},timeout:10000},(res)=>{
      if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){fetchSite(res.headers.location).then(resolve).catch(reject);return;}
      let d='';res.setEncoding('utf8');
      res.on('data',c=>{d+=c;if(d.length>50000){req.destroy();resolve(d);}});
      res.on('end',()=>resolve(d));
    });
    req.on('timeout',()=>{req.destroy();reject(new Error('Timeout'));});
    req.on('error',reject);
    req.end();
  });
}

function callClaude(system,user){
  return new Promise((resolve,reject)=>{
    const body=JSON.stringify({model:'claude-sonnet-4-6',max_tokens:2000,system,messages:[{role:'user',content:user}]});
    const req=https.request({hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':CLAUDE_API_KEY,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(body)},timeout:30000},(res)=>{
      let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{const p=JSON.parse(d);resolve(p.content?.[0]?.text||'');}catch(e){reject(e);}});
    });
    req.on('timeout',()=>{req.destroy();reject(new Error('Timeout'));});
    req.on('error',reject);
    req.write(body);req.end();
  });
}

function fallback(domain){
  const s=domain.toLowerCase();
  let type='💇 Salon Beauty',services=[{name:'Serviciu 1',price:'100 LEI'},{name:'Serviciu 2',price:'150 LEI'},{name:'Serviciu 3',price:'200 LEI'}];
  if(s.includes('dent')||s.includes('stomat')||s.includes('clinic')||s.includes('medic')||s.includes('dental')){type='🦷 Cabinet Dentar';services=[{name:'Consultatie',price:'80 LEI'},{name:'Detartraj',price:'180 LEI'},{name:'Plomba',price:'280 LEI'}];}
  else if(s.includes('vet')||s.includes('animal')||s.includes('biovet')){type='🐾 Cabinet Veterinar';services=[{name:'Consultatie',price:'150 LEI'},{name:'Vaccinare',price:'150 LEI'},{name:'Castrare',price:'300 LEI'}];}
  else if(s.includes('auto')||s.includes('service')||s.includes('car')||s.includes('landrover')||s.includes('bmw')||s.includes('mercedes')||s.includes('dacia')){type='🚗 Service Auto';services=[{name:'Revizie',price:'350 LEI'},{name:'Schimb ulei',price:'150 LEI'},{name:'Diagnoza',price:'80 LEI'}];}
  else if(s.includes('fizio')||s.includes('recuper')||s.includes('masaj')){type='💆 Fizioterapie';services=[{name:'Sedinta',price:'120 LEI'},{name:'Masaj',price:'150 LEI'},{name:'Evaluare',price:'100 LEI'}];}
  const name=domain.replace(/^www\./,'').split('.')[0].replace(/-/g,' ').replace(/\b\w/g,l=>l.toUpperCase());
  return {name,type,phone:null,email:`contact@${domain}`,city:null,hours:'Luni-Vineri 09:00-19:00',services,faq:[],confidence:45,missing:['telefon','oras','preturi complete']};
}

const server=http.createServer(async(req,res)=>{
  setCors(res);
  const p=url.parse(req.url,true).pathname;
  if(req.method==='OPTIONS'){res.writeHead(200);res.end();return;}

  if(p==='/api/analyze'&&req.method==='POST'){
    const body=await parseBody(req);
    if(!body.url){sendJson(res,{error:'URL lipsa'},400);return;}
    const domain=body.url.replace(/^https?:\/\//,'').replace(/\/.*/,'');
    if(!CLAUDE_API_KEY){sendJson(res,{success:true,data:fallback(domain),mock:true});return;}
    try{
      let html='';
      try{html=await fetchSite(body.url);}catch(e){console.log('Fetch failed:',e.message);}
      const text=html?stripHtml(html):'';
      const prompt=text
        ?`Analizeaza acest website romanesc si extrage informatiile structurate.\nURL: ${body.url}\nContiut:\n${text}\n\nReturneaza EXACT acest JSON:\n{"name":"","type":"tip cu emoji","phone":null,"email":null,"city":null,"hours":null,"services":[{"name":"","price":""}],"faq":[],"confidence":85,"missing":[]}`
        :`Genereaza un profil realist pentru afacerea cu domeniu: ${domain}\nReturneaza JSON: {"name":"","type":"tip cu emoji","phone":null,"email":null,"city":null,"hours":null,"services":[{"name":"","price":""}],"faq":[],"confidence":50,"missing":[]}`;
      const result=await callClaude('Esti expert in analiza afacerilor locale din Romania. Returneaza DOAR JSON valid, fara text suplimentar.',prompt);
      const clean=result.replace(/```json|```/g,'').trim();
      const parsed=JSON.parse(clean);
      sendJson(res,{success:true,data:parsed});
    }catch(e){
      console.error('Analyze error:',e.message);
      sendJson(res,{success:true,data:fallback(domain),mock:true});
    }
    return;
  }

  // Static files
  let filePath=p==='/'?'/frontend/index.html':p;
  filePath=path.join(__dirname,'..',filePath);
  const ext=path.extname(filePath);
  fs.readFile(filePath,(err,content)=>{
    if(err){res.writeHead(404);res.end('404');return;}
    res.writeHead(200,{'Content-Type':MIME[ext]||'text/plain'});
    res.end(content);
  });
});

server.listen(PORT,()=>{
  console.log(`\nRecepAI Server complet pe http://localhost:${PORT}`);
  console.log(`Claude: ${CLAUDE_API_KEY?'✓ Activ':'✗ Lipsa API Key'}\n`);
});
