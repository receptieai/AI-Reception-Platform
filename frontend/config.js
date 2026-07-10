/**
 * RecepAI — Config central
 * 
 * UN singur fișier care controlează toate URL-urile.
 * Schimbi o singură linie → totul se actualizează.
 */

const CONFIG = {
  // API URL — detectat automat după environment
  API_URL: (function() {
    const host = window.location.hostname;
    
    // Production
    if (host === 'receptieai.ro' || host === 'www.receptieai.ro' || host === 'app.receptieai.ro') {
      return 'https://api.receptieai.ro';
    }
    
    // Railway staging
    if (host.includes('railway.app')) {
      return 'https://ai-reception-platform-production.up.railway.app';
    }
    
    // Development local → ngrok
    // SCHIMBĂ DOAR ACEASTĂ LINIE când ngrok-ul se restartează
    if (host === 'localhost' || host === '127.0.0.1') {
      return 'https://pentagon-treading-decipher.ngrok-free.dev';
    }
    
    // Fallback
    return 'https://ai-reception-platform-production.up.railway.app';
  })(),

  // Widget settings
  WIDGET_URL: (function() {
    const host = window.location.hostname;
    if (host === 'receptieai.ro' || host === 'www.receptieai.ro') {
      return 'https://widget.receptieai.ro/widget.js';
    }
    return window.location.origin + '/frontend/widget.js';
  })(),

  // Environment detectat
  ENV: (function() {
    const host = window.location.hostname;
    if (host === 'receptieai.ro' || host === 'api.receptieai.ro') return 'production';
    if (host.includes('railway.app')) return 'staging';
    return 'development';
  })(),

  // Version
  VERSION: '2.1.0',
};

// Log în development
if (CONFIG.ENV === 'development') {
  console.log('[RecepAI Config]', CONFIG.ENV, '→', CONFIG.API_URL);
}

// Export pentru Node.js (server-side) dacă e nevoie
if (typeof module !== 'undefined') module.exports = CONFIG;
