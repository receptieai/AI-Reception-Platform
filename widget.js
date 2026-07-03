(function () {
  'use strict';

  var script = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();

  var config = {
    id: script.getAttribute('data-id') || 'CLI-000',
    culoare: script.getAttribute('data-culoare') || '#00D4AA',
    nume: script.getAttribute('data-nume') || 'RecepAI',
    apiUrl: script.getAttribute('data-api') || ''
  };

  var STEPS = ['name', 'phone', 'service', 'date'];
  var PROMPTS = {
    name: 'Cum vă numiți?',
    phone: 'Care este numărul dvs. de telefon?',
    service: 'Ce serviciu doriți? (ex: vopsire, tuns, manichiură)',
    date: 'Ce dată preferați pentru programare?'
  };

  var state = {
    open: false,
    step: 0,
    data: { name: '', phone: '', service: '', date: '' },
    finished: false
  };

  var root = document.createElement('div');
  root.id = 'recepai-widget';
  document.body.appendChild(root);

  var style = document.createElement('style');
  style.textContent = [
    '#recepai-widget{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:14px;line-height:1.5;z-index:2147483647}',
    '#recepai-widget *{box-sizing:border-box;margin:0;padding:0}',
    '.ra-bubble{position:fixed;bottom:24px;right:24px;width:60px;height:60px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 24px rgba(0,0,0,.18);transition:transform .2s,box-shadow .2s;z-index:2147483647}',
    '.ra-bubble:hover{transform:scale(1.06);box-shadow:0 6px 32px rgba(0,0,0,.22)}',
    '.ra-bubble svg{width:28px;height:28px}',
    '.ra-bubble.ra-open svg.ra-icon-chat{display:none}',
    '.ra-bubble:not(.ra-open) svg.ra-icon-close{display:none}',
    '.ra-panel{position:fixed;bottom:96px;right:24px;width:380px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,.18);display:flex;flex-direction:column;overflow:hidden;opacity:0;visibility:hidden;transform:translateY(16px) scale(.96);transition:opacity .25s,transform .25s,visibility .25s;z-index:2147483646}',
    '.ra-panel.ra-visible{opacity:1;visibility:visible;transform:translateY(0) scale(1)}',
    '.ra-header{padding:16px 18px;color:#fff;display:flex;align-items:center;gap:12px;flex-shrink:0}',
    '.ra-avatar{width:40px;height:40px;background:rgba(255,255,255,.2);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}',
    '.ra-header-info{flex:1;min-width:0}',
    '.ra-header-name{font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ra-header-sub{font-size:11px;opacity:.85;margin-top:1px}',
    '.ra-online{margin-left:auto;font-size:11px;display:flex;align-items:center;gap:5px;opacity:.9;flex-shrink:0}',
    '.ra-online::before{content:"";width:7px;height:7px;background:#4ade80;border-radius:50%;animation:ra-pulse 2s infinite}',
    '@keyframes ra-pulse{0%,100%{opacity:1}50%{opacity:.4}}',
    '.ra-msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;background:#f8f9fa}',
    '.ra-msg{max-width:85%;padding:10px 14px;border-radius:14px;font-size:13.5px;line-height:1.55;word-wrap:break-word;animation:ra-pop .25s ease}',
    '@keyframes ra-pop{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}',
    '.ra-msg-bot{background:#fff;border:1px solid #e8e8e8;border-radius:4px 14px 14px 14px;align-self:flex-start;color:#333}',
    '.ra-msg-user{color:#000;font-weight:500;border-radius:14px 4px 14px 14px;align-self:flex-end}',
    '.ra-typing{display:none;align-items:center;gap:4px;padding:10px 14px;background:#fff;border:1px solid #e8e8e8;border-radius:4px 14px 14px 14px;width:fit-content;align-self:flex-start}',
    '.ra-typing.ra-show{display:flex}',
    '.ra-typing span{width:6px;height:6px;background:#bbb;border-radius:50%;animation:ra-dot 1.2s infinite}',
    '.ra-typing span:nth-child(2){animation-delay:.2s}',
    '.ra-typing span:nth-child(3){animation-delay:.4s}',
    '@keyframes ra-dot{0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-4px);opacity:1}}',
    '.ra-input-row{padding:12px 14px;border-top:1px solid #eee;background:#fff;display:flex;gap:8px;flex-shrink:0}',
    '.ra-input{flex:1;border:1px solid #ddd;border-radius:10px;padding:10px 14px;font-size:13.5px;font-family:inherit;outline:none;transition:border-color .2s}',
    '.ra-input:focus{border-color:' + config.culoare + '}',
    '.ra-input:disabled{background:#f5f5f5;color:#999;cursor:not-allowed}',
    '.ra-send{width:40px;height:40px;border:none;border-radius:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:opacity .2s}',
    '.ra-send:disabled{opacity:.45;cursor:not-allowed}',
    '.ra-powered{text-align:center;padding:6px;font-size:10px;color:#aaa;background:#fff;border-top:1px solid #f0f0f0;flex-shrink:0}',
    '.ra-powered a{color:#888;text-decoration:none}',
    '.ra-powered a:hover{text-decoration:underline}',
    '@media(max-width:480px){.ra-bubble{bottom:16px;right:16px;width:56px;height:56px}.ra-panel{bottom:84px;right:16px;width:calc(100vw - 32px);height:calc(100vh - 100px)}}'
  ].join('\n');
  document.head.appendChild(style);

  root.innerHTML = [
    '<button class="ra-bubble" aria-label="Deschide chat" style="background:' + config.culoare + '">',
    '  <svg class="ra-icon-chat" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
    '    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    '  </svg>',
    '  <svg class="ra-icon-close" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round">',
    '    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    '  </svg>',
    '</button>',
    '<div class="ra-panel" role="dialog" aria-label="Chat ' + escapeHtml(config.nume) + '">',
    '  <div class="ra-header" style="background:linear-gradient(135deg,' + config.culoare + ',' + darken(config.culoare, 15) + ')">',
    '    <div class="ra-avatar">💬</div>',
    '    <div class="ra-header-info">',
    '      <div class="ra-header-name">' + escapeHtml(config.nume) + '</div>',
    '      <div class="ra-header-sub">Recepționist AI · Online acum</div>',
    '    </div>',
    '    <div class="ra-online">Online</div>',
    '  </div>',
    '  <div class="ra-msgs" id="ra-msgs">',
    '    <div class="ra-typing" id="ra-typing"><span></span><span></span><span></span></div>',
    '  </div>',
    '  <div class="ra-input-row">',
    '    <input class="ra-input" id="ra-input" type="text" placeholder="Scrieți mesajul dvs..." autocomplete="off">',
    '    <button class="ra-send" id="ra-send" style="background:' + config.culoare + '" aria-label="Trimite">',
    '      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">',
    '        <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    '      </svg>',
    '    </button>',
    '  </div>',
    '  <div class="ra-powered">Powered by <a href="https://recepai.ro" target="_blank" rel="noopener">RecepAI</a></div>',
    '</div>'
  ].join('');

  var bubble = root.querySelector('.ra-bubble');
  var panel = root.querySelector('.ra-panel');
  var msgsEl = root.querySelector('#ra-msgs');
  var typingEl = root.querySelector('#ra-typing');
  var inputEl = root.querySelector('#ra-input');
  var sendBtn = root.querySelector('#ra-send');

  bubble.addEventListener('click', togglePanel);
  sendBtn.addEventListener('click', handleSend);
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') handleSend();
  });

  function togglePanel() {
    state.open = !state.open;
    bubble.classList.toggle('ra-open', state.open);
    panel.classList.toggle('ra-visible', state.open);
    if (state.open) {
      inputEl.focus();
      if (msgsEl.querySelectorAll('.ra-msg').length === 0) {
        startConversation();
      }
    }
  }

  function startConversation() {
    showTyping(true);
    setTimeout(function () {
      showTyping(false);
      addBotMsg('Bună ziua! Cu ce vă pot ajuta?');
      setTimeout(function () {
        showTyping(true);
        setTimeout(function () {
          showTyping(false);
          addBotMsg(PROMPTS.name);
        }, 700);
      }, 500);
    }, 600);
  }

  function handleSend() {
    if (state.finished) return;
    var text = inputEl.value.trim();
    if (!text) return;

    var currentStep = STEPS[state.step];
    if (!currentStep) return;

    if (currentStep === 'phone' && !isValidPhone(text)) {
      addBotMsg('Vă rugăm introduceți un număr de telefon valid (ex: 0721 234 567).');
      return;
    }

    state.data[currentStep] = text;
    addUserMsg(text);
    inputEl.value = '';
    state.step++;

    if (state.step >= STEPS.length) {
      finishConversation();
      return;
    }

    showTyping(true);
    setTimeout(function () {
      showTyping(false);
      addBotMsg(PROMPTS[STEPS[state.step]]);
    }, 800);
  }

  function finishConversation() {
    state.finished = true;
    inputEl.disabled = true;
    sendBtn.disabled = true;
    inputEl.placeholder = 'Conversație finalizată';

    showTyping(true);
    setTimeout(function () {
      showTyping(false);
      var d = state.data;
      addBotMsg(
        '✅ Programare înregistrată!\n\n' +
        '👤 ' + d.name + '\n' +
        '📞 ' + d.phone + '\n' +
        '💇 ' + d.service + '\n' +
        '📅 ' + d.date + '\n\n' +
        'Veți fi contactat(ă) în maximum 2 ore pentru confirmare. Mulțumim!'
      );
      submitLead(d);
    }, 1000);
  }

  function submitLead(data) {
    var payload = {
      clientId: config.id,
      businessName: config.nume,
      name: data.name,
      phone: data.phone,
      service: data.service,
      preferredDate: data.date,
      timestamp: new Date().toISOString()
    };

    if (config.apiUrl) {
      fetch(config.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(function () {});
    }

    if (typeof window.RecepAI !== 'undefined' && typeof window.RecepAI.onLead === 'function') {
      window.RecepAI.onLead(payload);
    }
  }

  function addBotMsg(text) {
    var el = document.createElement('div');
    el.className = 'ra-msg ra-msg-bot';
    el.style.whiteSpace = 'pre-line';
    el.textContent = text;
    msgsEl.insertBefore(el, typingEl);
    scrollBottom();
  }

  function addUserMsg(text) {
    var el = document.createElement('div');
    el.className = 'ra-msg ra-msg-user';
    el.style.background = config.culoare;
    el.textContent = text;
    msgsEl.insertBefore(el, typingEl);
    scrollBottom();
  }

  function showTyping(show) {
    typingEl.classList.toggle('ra-show', show);
    if (show) scrollBottom();
  }

  function scrollBottom() {
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function isValidPhone(val) {
    var digits = val.replace(/\D/g, '');
    return digits.length >= 9 && digits.length <= 12;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function darken(hex, percent) {
    var num = parseInt(hex.replace('#', ''), 16);
    var r = Math.max(0, (num >> 16) - Math.round(2.55 * percent));
    var g = Math.max(0, ((num >> 8) & 0xff) - Math.round(2.55 * percent));
    var b = Math.max(0, (num & 0xff) - Math.round(2.55 * percent));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }
})();
