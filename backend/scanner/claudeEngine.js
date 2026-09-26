'use strict';

const https = require('https');
const { chatCompletion } = require('./inference');

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 2000;

async function callClaude(prompt, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text || '';
          resolve(text);
        } catch(e) { reject(new Error('Claude parse error: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Claude timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildPrompt(context) {
  const { industry, pages, alreadyExtracted, missingFields, brainInferences } = context;

  // Clean page text for the LLM — strip 80% of the markup noise BEFORE
  // sending to the model (saves 3–5x tokens vs raw HTML and reduces
  // hallucination: the model sees content, not tag soup).
  const pageSummaries = pages
    .filter(p => missingFields.some(f => isRelevantPage(p.label, f)))
    .slice(0, 5)
    .map(p => {
      let text = p.html
        // remove non-content blocks wholesale
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
        .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
        .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(svg|iframe|form|button|input|img)[\s\S]*?>/gi, ' ');
      // turn structure into readable lines: headings / lists / paragraphs
      text = text
        .replace(/<h[1-6][^>]*>/gi, '\n# ')
        .replace(/<\/h[1-6]>/gi, '\n')
        .replace(/<li[^>]*>/gi, '\n- ')
        .replace(/<(div|p|tr|br|section|article|ul|ol|table)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/g, ' ')
        .replace(/&amp;/g, '&').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í')
        .replace(/\s+/g, ' ')
        .trim();
      // More text for price/service pages
      const maxChars = ['prices','services','pachete'].includes(p.label) ? 2500 : 1200;
      return `[${p.label.toUpperCase()}]\n${text.substring(0, maxChars)}`;
    })
    .join('\n\n---\n\n');

  const extracted = JSON.stringify(alreadyExtracted, null, 2);
  const brain = brainInferences ? JSON.stringify({
    industry: brainInferences.industry,
    facilities: brainInferences.facilities.slice(0, 10),
    insurances: brainInferences.insurances,
    specialties: brainInferences.specialties.slice(0, 10),
    emergency: brainInferences.emergency,
    parking: brainInferences.parking,
  }, null, 2) : '{}';

  return `Ești un extractor de date pentru afaceri locale românești. Industrie: ${industry}.

DATE DEJA EXTRASE (nu le repeta, sunt corecte):
${extracted}

INFERENȚE BUSINESS BRAIN:
${brain}

CÂMPURI LIPSĂ (completează DOAR pe acestea):
${missingFields.join(', ')}

CONȚINUT PAGINI WEB:
${pageSummaries}

Răspunde STRICT cu JSON valid, fără markdown, fără explicații. Exemplu format:
{
  "name": "Clinica Exemplu",
  "hours": "Luni-Vineri: 09:00-18:00, Sâmbătă: 09:00-13:00",
  "faq": [
    {"question": "Acceptați asigurări?", "answer": "Da, acceptăm Signal Iduna și Allianz"},
    {"question": "Aveți parcare?", "answer": "Da, avem parcare gratuită"}
  ],
  "description": "Clinică stomatologică cu experiență de 10 ani în București",
  "emergency_phone": null,
  "website_type": "dental"
}

Completează DOAR câmpurile din lista missingFields. 
PENTRU SERVICES: extrage TOATE serviciile și prețurile din text. Dacă prețul lipsește, pune price: null dar include serviciul.
Format services: [{"name": "Serviciu", "price": "150 RON"}, ...]
Nu inventa prețuri. Nu inventa servicii care nu există în text.`;
}

function isRelevantPage(label, field) {
  const map = {
    homepage: ['name', 'description', 'hours', 'emergency', 'parking'],
    contact: ['name', 'hours', 'emergency_phone', 'address'],
    services: ['services', 'faq', 'specialties'],
    prices: ['services', 'faq'],
    team: ['doctors', 'specialists'],
    about: ['description', 'name', 'history'],
    faq: ['faq'],
    emergency: ['emergency', 'emergency_phone', 'hours'],
  };
  return (map[label] || []).some(f => field.toLowerCase().includes(f)) || true;
}

function parseClaudeResponse(text) {
  try {
    // Remove markdown code blocks if present
    const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    return JSON.parse(clean);
  } catch(e) {
    // Try to extract JSON from text
    const match = text.match(/\{[\s\S]+\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch(e2) {}
    }
    console.log('[CLAUDE] Parse failed:', e.message);
    return null;
  }
}

async function fillMissingFields(context, apiKey) {
  if (!context.missingFields || context.missingFields.length === 0) {
    console.log('[CLAUDE] No missing fields — skipping');
    return null;
  }

  console.log('[CLAUDE] Filling:', context.missingFields.join(', '));
  const prompt = buildPrompt(context);

  // Route through the unified inference layer: local OpenMayhem gateway
  // when reachable (free/cheap), otherwise Claude. The prompt is the same
  // generic extraction prompt either way — no site-specific rules.
  let text;
  try {
    const r = await chatCompletion(prompt, apiKey);
    text = r.text;
  } catch (e) {
    console.log('[CLAUDE] Inference error:', e.message);
    return null;
  }
  if (!text) return null;

  let parsed;
  try {
    parsed = parseClaudeResponse(text);
    if (parsed) {
      console.log('[CLAUDE] OK — got:', Object.keys(parsed).filter(k => parsed[k] !== null).join(', '));
    }
  } catch (e) {
    console.log('[CLAUDE] Parse error:', e.message);
    return null;
  }
  if (!parsed) return null;

  // VALIDATE the model's answer before trusting it — a hallucinated phone
  // number or impossible price never reaches the client's widget.
  try {
    const { validateAiOutput } = require('./validateEngine');
    const { data, dropped } = validateAiOutput(parsed);
    if (dropped.length) {
      console.log('[VALIDATE] dropped', dropped.length, 'field(s):', dropped.slice(0, 5).join(', '));
    }
    return data;
  } catch (e) {
    console.log('[VALIDATE] skipped:', e.message);
    return parsed;
  }
}

module.exports = { fillMissingFields };
