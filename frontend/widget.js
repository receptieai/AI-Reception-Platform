/**
 * RecepAI Widget v2.0
 * Conversație naturală cu Claude API
 * Fără flow rigid — AI răspunde liber la orice întrebare
 * 
 * Instalare: <script src="https://receptieai.ro/widget.js" 
 *   data-id="CLI-001" 
 *   data-culoare="#00D4AA"
 *   data-nume="Salon Beauty Pro"
 *   data-avatar="💇‍♀️"
 *   data-owner-email="contact@salon.ro"
 *   data-phone="0721234567"
 * ></script>
 */

(function () {
  'use strict';

  // ── CONFIG ────────────────────────────────────
  const script = document.currentScript || document.querySelector('script[data-id]');
  const C = {
    clientId:   script?.getAttribute('data-id')          || 'DEMO',
    color:      script?.getAttribute('data-culoare')      || '#00D4AA',
    position:   script?.getAttribute('data-pozitie')      || 'dreapta-jos',
    name:       script?.getAttribute('data-nume')         || 'Recepționist AI',
    avatar:     script?.getAttribute('data-avatar')       || '💬',
    ownerEmail: script?.getAttribute('data-owner-email')  || '',
    phone:      script?.getAttribute('data-phone')        || '',
    delay:      parseInt(script?.getAttribute('data-delay') || '4') * 1000,
    apiUrl:     script?.getAttribute('data-api-url')      || 'https://ai-reception-platform-production.up.railway.app',
  };

  // ── STATE ─────────────────────────────────────
  let isOpen = false;
  let isTyping = false;
  let conversationHistory = [];
  let collectedData = { name: null, phone: null, service: null, date: null };
  let leadSent = false;
  let bubbleTimer = null;

  // ── CSS ───────────────────────────────────────
  const css = `
    #rcpai-root * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif; }
    
    #rcpai-btn {
      position: fixed;
      ${C.position === 'stanga-jos' ? 'left: 20px' : 'right: 20px'};
      bottom: 20px;
      width: 58px; height: 58px;
      background: ${C.color};
      border-radius: 50%;
      border: none;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 20px rgba(0,0,0,.25), 0 0 0 0 ${C.color}66;
      z-index: 999999;
      transition: transform .25s cubic-bezier(.34,1.56,.64,1), box-shadow .25s;
      animation: rcpai-pulse 3s infinite;
    }
    @keyframes rcpai-pulse {
      0% { box-shadow: 0 4px 20px rgba(0,0,0,.25), 0 0 0 0 ${C.color}55; }
      70% { box-shadow: 0 4px 20px rgba(0,0,0,.25), 0 0 0 10px ${C.color}00; }
      100% { box-shadow: 0 4px 20px rgba(0,0,0,.25), 0 0 0 0 ${C.color}00; }
    }
    #rcpai-btn:hover { transform: scale(1.08); }
    #rcpai-btn.open { transform: scale(0.92); animation: none; box-shadow: 0 4px 20px rgba(0,0,0,.25); }
    #rcpai-btn-icon { font-size: 24px; line-height: 1; transition: all .2s; }
    #rcpai-btn-x { display: none; color: #000; font-size: 20px; font-weight: 700; line-height: 1; }
    #rcpai-btn.open #rcpai-btn-icon { display: none; }
    #rcpai-btn.open #rcpai-btn-x { display: block; }

    #rcpai-badge {
      position: fixed;
      ${C.position === 'stanga-jos' ? 'left: 86px' : 'right: 86px'};
      bottom: 30px;
      background: #1a1a1a;
      color: #f0f0f0;
      padding: 8px 14px;
      border-radius: ${C.position === 'stanga-jos' ? '12px 12px 12px 4px' : '12px 12px 4px 12px'};
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      z-index: 999998;
      animation: rcpai-slidein .4s ease;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(0,0,0,.2);
    }
    @keyframes rcpai-slidein { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

    #rcpai-window {
      position: fixed;
      ${C.position === 'stanga-jos' ? 'left: 16px' : 'right: 16px'};
      bottom: 88px;
      width: 360px;
      height: 520px;
      background: #0f0f0f;
      border-radius: 18px;
      box-shadow: 0 20px 60px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.06);
      z-index: 999997;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transform: scale(.88) translateY(16px);
      opacity: 0;
      pointer-events: none;
      transition: all .3s cubic-bezier(.34,1.56,.64,1);
      transform-origin: ${C.position === 'stanga-jos' ? 'bottom left' : 'bottom right'};
    }
    #rcpai-window.open {
      transform: scale(1) translateY(0);
      opacity: 1;
      pointer-events: all;
    }

    #rcpai-head {
      padding: 14px 16px;
      display: flex;
      align-items: center;
      gap: 10px;
      border-bottom: 1px solid rgba(255,255,255,.07);
      background: linear-gradient(135deg, ${C.color}18, transparent);
      flex-shrink: 0;
    }
    #rcpai-head-av {
      width: 38px; height: 38px;
      background: ${C.color}22;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 18px;
      flex-shrink: 0;
      border: 1.5px solid ${C.color}44;
    }
    #rcpai-head-name { font-size: 14px; font-weight: 600; color: #f0f0f0; }
    #rcpai-head-sub { font-size: 11px; color: #888; margin-top: 1px; }
    #rcpai-head-status {
      margin-left: auto;
      display: flex; align-items: center; gap: 5px;
      font-size: 11px; color: #4ade80; font-weight: 600;
    }
    #rcpai-head-status::before {
      content: '';
      width: 6px; height: 6px;
      background: #4ade80;
      border-radius: 50%;
      animation: rcpai-online 2s infinite;
    }
    @keyframes rcpai-online {
      0%, 100% { opacity: 1; }
      50% { opacity: .4; }
    }
    #rcpai-head-close {
      background: transparent; border: none;
      color: #555; font-size: 18px;
      cursor: pointer; padding: 2px 4px;
      margin-left: 6px;
      transition: color .15s;
      line-height: 1;
    }
    #rcpai-head-close:hover { color: #f0f0f0; }

    #rcpai-msgs {
      flex: 1;
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: #0a0a0a;
      scroll-behavior: smooth;
    }
    #rcpai-msgs::-webkit-scrollbar { width: 3px; }
    #rcpai-msgs::-webkit-scrollbar-track { background: transparent; }
    #rcpai-msgs::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }

    .rcpai-msg {
      max-width: 84%;
      padding: 9px 13px;
      border-radius: 16px;
      font-size: 13.5px;
      line-height: 1.55;
      white-space: pre-line;
      word-break: break-word;
      animation: rcpai-msg-in .2s ease;
    }
    @keyframes rcpai-msg-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    .rcpai-bot {
      background: #1a1a1a;
      color: #e8e8e8;
      border-radius: 4px 16px 16px 16px;
      align-self: flex-start;
    }
    .rcpai-user {
      background: ${C.color};
      color: #000;
      font-weight: 500;
      border-radius: 16px 4px 16px 16px;
      align-self: flex-end;
    }

    .rcpai-typing {
      display: none;
      align-items: center;
      gap: 4px;
      padding: 10px 14px;
      background: #1a1a1a;
      border-radius: 4px 16px 16px 16px;
      width: fit-content;
      align-self: flex-start;
    }
    .rcpai-typing.show { display: flex; animation: rcpai-msg-in .2s ease; }
    .rcpai-typing span {
      width: 5px; height: 5px;
      background: #555;
      border-radius: 50%;
      animation: rcpai-dot 1.2s infinite;
    }
    .rcpai-typing span:nth-child(2) { animation-delay: .2s; }
    .rcpai-typing span:nth-child(3) { animation-delay: .4s; }
    @keyframes rcpai-dot {
      0%, 60%, 100% { transform: translateY(0); opacity: .4; }
      30% { transform: translateY(-4px); opacity: 1; }
    }

    #rcpai-input-area {
      padding: 10px 12px;
      border-top: 1px solid rgba(255,255,255,.06);
      display: flex;
      gap: 8px;
      align-items: flex-end;
      background: #0f0f0f;
      flex-shrink: 0;
    }
    #rcpai-input {
      flex: 1;
      background: #1a1a1a;
      border: 1.5px solid #2a2a2a;
      border-radius: 12px;
      padding: 9px 13px;
      font-size: 13.5px;
      color: #e8e8e8;
      outline: none;
      resize: none;
      max-height: 80px;
      min-height: 38px;
      line-height: 1.4;
      font-family: inherit;
      transition: border-color .2s;
      -webkit-appearance: none;
    }
    #rcpai-input:focus { border-color: ${C.color}; }
    #rcpai-input::placeholder { color: #444; }
    #rcpai-send {
      width: 38px; height: 38px;
      background: ${C.color};
      border: none;
      border-radius: 10px;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      transition: all .15s;
    }
    #rcpai-send:hover { filter: brightness(1.15); }
    #rcpai-send:active { transform: scale(.94); }
    #rcpai-send:disabled { opacity: .5; cursor: not-allowed; }

    #rcpai-footer {
      padding: 5px 14px 9px;
      text-align: center;
      background: #0f0f0f;
      flex-shrink: 0;
    }
    #rcpai-footer a {
      font-size: 10px; color: #333;
      text-decoration: none;
      transition: color .2s;
    }
    #rcpai-footer a:hover { color: ${C.color}; }

    @media (max-width: 420px) {
      #rcpai-window {
        left: 0 !important; right: 0 !important;
        bottom: 0 !important;
        width: 100% !important;
        height: 90vh !important;
        border-radius: 20px 20px 0 0;
        transform-origin: bottom center;
      }
      #rcpai-btn { right: 16px !important; left: auto !important; }
      #rcpai-badge { right: 82px !important; left: auto !important; }
    }
  `;

  // ── HTML ──────────────────────────────────────
  const html = `
    <style>${css}</style>

    <div id="rcpai-badge" onclick="RecepAI.toggle()" style="display:none">
      Bună! Cu ce vă pot ajuta? 👋
    </div>

    <button id="rcpai-btn" onclick="RecepAI.toggle()" aria-label="Deschide chat">
      <span id="rcpai-btn-icon">${C.avatar}</span>
      <span id="rcpai-btn-x">✕</span>
    </button>

    <div id="rcpai-window" role="dialog" aria-modal="true" aria-label="Chat RecepAI">
      <div id="rcpai-head">
        <div id="rcpai-head-av">${C.avatar}</div>
        <div>
          <div id="rcpai-head-name">${C.name}</div>
          <div id="rcpai-head-sub">Răspunde instant · 24/7</div>
        </div>
        <div id="rcpai-head-status">Online</div>
        <button id="rcpai-head-close" onclick="RecepAI.close()" aria-label="Închide">✕</button>
      </div>

      <div id="rcpai-msgs">
        <div class="rcpai-typing" id="rcpai-typing">
          <span></span><span></span><span></span>
        </div>
      </div>

      <div id="rcpai-input-area">
        <textarea
          id="rcpai-input"
          placeholder="Scrieți mesajul dvs..."
          rows="1"
          aria-label="Mesaj"
        ></textarea>
        <button id="rcpai-send" aria-label="Trimite">
          <svg width="16" height="16" fill="none" stroke="#000" stroke-width="2.5" viewBox="0 0 24 24">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>

      <div id="rcpai-footer">
        <a href="https://receptieai.ro" target="_blank">⚡ Powered by RecepAI</a>
      </div>
    </div>
  `;

  // ── SYSTEM PROMPT ─────────────────────────────
  function getSystemPrompt(profile) {
    const now = new Date();
    const hour = now.getHours();
    const isWorking = hour >= 9 && hour < 18;
    const dayName = ['Duminică','Luni','Marți','Miercuri','Joi','Vineri','Sâmbătă'][now.getDay()];

    const services = (profile?.services || [])
      .filter(s => s?.name)
      .map(s => `  • ${s.name}${s.price ? ': ' + s.price : ''}${s.duration ? ' (' + s.duration + ')' : ''}`)
      .join('\n') || '  • Contactați-ne pentru lista completă';

    return `Ești recepționistul virtual al "${C.name}" — o afacere locală din România.

PERSONALITATE:
- Cald, profesionist, natural — ca un angajat real
- Răspunzi în română perfectă
- Mesaje scurte și clare — max 3-4 propoziții
- Folosești emoji-uri cu moderație (1-2 per mesaj)

CUNOȘTINȚE DESPRE AFACERE:
${profile?.description ? '- ' + profile.description : ''}
- Telefon: ${profile?.phone || C.phone || 'disponibil la recepție'}
- Oraș: ${profile?.city || 'România'}
- Program: ${profile?.hours || 'Luni-Vineri 09:00-19:00'}
- Facebook: ${profile?.facebook || 'nedisponibil'}

SERVICII ȘI PREȚURI:
${services}

INFORMAȚII FAQ:
${(profile?.faq || []).map(f => `  Q: ${f.question}\n  A: ${f.answer}`).join('\n') || '  Fără FAQ configurat'}

REGULI STRICTE — RESPECTĂ-LE ÎNTOTDEAUNA:
1. NU da sfaturi medicale sau veterinare — redirecționează la medic
2. NU inventa prețuri sau servicii care nu sunt în lista de mai sus
3. NU cere datele clientului înainte de a răspunde la întrebările lui
4. Dacă nu știi ceva → "Vă rog sunați la ${profile?.phone || C.phone || 'recepție'} pentru detalii"
5. NICIODATĂ nu bloca conversația — dacă clientul vrea să vorbească, răspunde

COLECTAREA DATELOR — NATURAL, nu forțat:
- Colectezi NUME, TELEFON, SERVICIU DORIT, ZI PREFERATĂ
- NU le ceri pe toate odată
- Le ceri NATURAL în conversație DUPĂ ce ai răspuns la întrebările clientului
- Exemplu corect:
  Client: "Cât costă detartrajul?"
  Tu: "Detartrajul costă 180 LEI și durează ~45 minute. Doriți să faceți o programare? 😊"
  Client: "Da"
  Tu: "Super! Cum vă numiți?"

CONTEXTUL TEMPORAL:
- Acum este ${dayName}, ora ${hour}:${String(now.getMinutes()).padStart(2,'0')}
- ${isWorking ? 'Suntem în program — confirmi că vor fi contactați în 2 ore' : 'Suntem în afara programului — confirmi că vor fi contactați în ziua lucrătoare următoare'}

FINALIZARE PROGRAMARE:
Când ai colectat NUME + TELEFON + SERVICIU, răspunde cu:
"✅ Mulțumesc, [NUME]! Am înregistrat:
👤 [Nume]
📞 [Telefon]  
🔧 [Serviciu]
${isWorking ? 'Veți fi contactat în maximum 2 ore!' : 'Veți fi contactat mâine în timpul programului!'}"

Apoi adaugă exact: [LEAD_READY]`;
  }

  // ── API CALL ──────────────────────────────────
  async function callAPI(userMessage, profile) {
    conversationHistory.push({ role: 'user', content: userMessage });

    try {
      const response = await fetch(`${C.apiUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: conversationHistory,
          businessProfile: profile || {},
          personality: 'prietenos',
          systemOverride: getSystemPrompt(profile),
        }),
      });

      if (!response.ok) throw new Error('API error: ' + response.status);
      const data = await response.json();
      const reply = data.message || 'Îmi pare rău, a apărut o eroare. Vă rog sunați direct.';
      conversationHistory.push({ role: 'assistant', content: reply });
      return reply;
    } catch (e) {
      console.error('[RecepAI] API error:', e);
      // Fallback inteligent
      return getFallbackReply(userMessage);
    }
  }

  // ── FALLBACK INTELIGENT ───────────────────────
  function getFallbackReply(message) {
    const m = message.toLowerCase();
    if (m.includes('program') || m.includes('rezerv') || m.includes('programar')) {
      return `Vă pot ajuta cu o programare! 😊\nCum vă numiți?`;
    }
    if (m.includes('pret') || m.includes('cost') || m.includes('cat')) {
      return `Pentru informații despre prețuri, vă rog sunați la ${C.phone || 'recepție'} sau scrieți-ne și vă răspundem imediat! 📞`;
    }
    if (m.includes('orar') || m.includes('program') || m.includes('ore') || m.includes('deschis')) {
      return `Programul nostru de lucru:\nLuni-Vineri: 09:00-19:00\nSâmbătă: 09:00-14:00\n\nDoriți o programare? 😊`;
    }
    return `Vă mulțumesc pentru mesaj! 😊\nVă pot ajuta cu:\n📅 Programări\n💰 Informații prețuri\n🕐 Program de lucru\n\nCe vă interesează?`;
  }

  // ── DETECT LEAD READY ─────────────────────────
  function detectAndExtractLead(text) {
    // Extrage date din conversație
    const nameMatch = conversationHistory
      .filter(m => m.role === 'user')
      .map(m => m.content)
      .join(' ')
      .match(/(?:mă numesc|sunt|numele meu e|eu sunt)\s+([A-ZÀ-Ö][a-zà-ö]+(?:\s+[A-ZÀ-Ö][a-zà-ö]+)?)/i);
    
    const phoneMatch = conversationHistory
      .filter(m => m.role === 'user')
      .map(m => m.content)
      .join(' ')
      .match(/(?:^|\s)(0[237]\d{2}[\s\-]?\d{3}[\s\-]?\d{3}|\+40[\s\-]?\d{3}[\s\-]?\d{3}[\s\-]?\d{3})(?:\s|$)/);

    if (nameMatch && !collectedData.name) collectedData.name = nameMatch[1];
    if (phoneMatch && !collectedData.phone) collectedData.phone = phoneMatch[1].trim();

    return text.includes('[LEAD_READY]') && collectedData.name && collectedData.phone;
  }

  // ── SEND LEAD ─────────────────────────────────
  async function sendLead() {
    if (leadSent) return;
    leadSent = true;

    const lead = {
      nume: collectedData.name,
      telefon: collectedData.phone,
      serviciu: collectedData.service,
      data_dorita: collectedData.date,
      timestamp: new Date().toISOString(),
      url: window.location.href,
      source: 'widget-v2',
    };

    try {
      await fetch(`${C.apiUrl}/api/lead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: C.clientId,
          businessName: C.name,
          ownerEmail: C.ownerEmail,
          businessPhone: C.phone,
          lead,
        }),
      });
      console.log('[RecepAI] Lead trimis:', lead);
    } catch (e) {
      console.log('[RecepAI] Lead salvat local:', lead);
      try {
        const key = 'rcpai_lead_' + Date.now();
        sessionStorage.setItem(key, JSON.stringify(lead));
      } catch (e2) { }
    }
  }

  // ── UI FUNCTIONS ──────────────────────────────
  function addMessage(text, type) {
    const msgs = document.getElementById('rcpai-msgs');
    const typing = document.getElementById('rcpai-typing');
    
    // Curăță textul de markers interni
    const cleanText = text.replace('[LEAD_READY]', '').replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').trim();
    if (!cleanText) return;

    const div = document.createElement('div');
    div.className = 'rcpai-msg rcpai-' + type;
    div.style.whiteSpace = 'pre-line';
    div.textContent = cleanText;
    msgs.insertBefore(div, typing);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function showTyping(show) {
    const t = document.getElementById('rcpai-typing');
    if (t) t.classList.toggle('show', show);
  }

  // ── SEND MESSAGE ──────────────────────────────
  let businessProfile = null;

  async function sendMessage(text) {
    if (!text.trim() || isTyping) return;

    // Disable input
    const input = document.getElementById('rcpai-input');
    const sendBtn = document.getElementById('rcpai-send');
    isTyping = true;
    if (sendBtn) sendBtn.disabled = true;

    addMessage(text, 'user');
    if (input) { input.value = ''; input.style.height = 'auto'; }

    showTyping(true);

    // Typing delay realist
    const delay = 600 + Math.random() * 800;
    await new Promise(r => setTimeout(r, delay));

    const reply = await callAPI(text, businessProfile);
    
    showTyping(false);
    addMessage(reply, 'bot');

    // Detectează dacă lead e gata
    if (detectAndExtractLead(reply)) {
      await sendLead();
    }

    isTyping = false;
    if (sendBtn) sendBtn.disabled = false;
    if (input) input.focus();
  }

  // ── INIT CHAT ─────────────────────────────────
  async function initChat() {
    showTyping(true);
    await new Promise(r => setTimeout(r, 800));
    showTyping(false);

    const greeting = `Bună ziua! 👋 Sunt recepționistul virtual al **${C.name}**.\n\nCu ce vă pot ajuta astăzi?`;
    addMessage(greeting, 'bot');
    conversationHistory.push({ role: 'assistant', content: greeting });
  }

  // ── TOGGLE ────────────────────────────────────
  let chatInited = false;

  window.RecepAI = {
    toggle() { isOpen ? this.close() : this.open(); },
    
    open() {
      isOpen = true;
      document.getElementById('rcpai-window')?.classList.add('open');
      document.getElementById('rcpai-btn')?.classList.add('open');
      document.getElementById('rcpai-badge').style.display = 'none';
      if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
      
      if (!chatInited) {
        chatInited = true;
        initChat();
      }
      
      setTimeout(() => document.getElementById('rcpai-input')?.focus(), 300);
    },
    
    close() {
      isOpen = false;
      document.getElementById('rcpai-window')?.classList.remove('open');
      document.getElementById('rcpai-btn')?.classList.remove('open');
    },
  };

  // ── BOOT ──────────────────────────────────────
  function boot() {
    const root = document.createElement('div');
    root.id = 'rcpai-root';
    root.innerHTML = html;
    document.body.appendChild(root);

    // Input events
    const input = document.getElementById('rcpai-input');
    const sendBtn = document.getElementById('rcpai-send');

    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const text = input.value.trim();
          if (text && !isTyping) sendMessage(text);
        }
      });
      input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 80) + 'px';
      });
    }

    if (sendBtn) {
      sendBtn.addEventListener('click', () => {
        const text = input?.value.trim();
        if (text && !isTyping) sendMessage(text);
      });
    }

    // Badge după delay
    bubbleTimer = setTimeout(() => {
      const badge = document.getElementById('rcpai-badge');
      if (badge && !isOpen) {
        badge.style.display = 'block';
        setTimeout(() => {
          if (!isOpen && badge) badge.style.display = 'none';
        }, 7000);
      }
    }, C.delay);
  }

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
