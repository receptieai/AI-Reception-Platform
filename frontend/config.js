/**
 * RecepAI — Config central v3
 * 
 * Prioritate:
 * 1. localStorage('API_URL_OVERRIDE') — pentru ngrok/testing
 * 2. localhost:8080 — development local
 * 3. api.receptieai.ro — production
 * 
 * Pentru ngrok (supraviețuiește refresh-ului):
 *   localStorage.setItem('API_URL_OVERRIDE', 'https://xxx.ngrok-free.dev')
 *   location.reload()
 * 
 * Pentru a șterge override:
 *   localStorage.removeItem('API_URL_OVERRIDE')
 *   location.reload()
 */

const CONFIG = (function() {
  const override = localStorage.getItem('API_URL_OVERRIDE');

  const API_URL =
    override ||
    (
      location.hostname === 'localhost' || location.hostname === '127.0.0.1'
        ? 'http://localhost:8080'
        : 'https://api.receptieai.ro'
    );

  const ENV =
    override ? 'override' :
    location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? 'development' :
    location.hostname.includes('railway.app') ? 'staging' :
    'production';

  if (ENV === 'development' || ENV === 'override') {
    console.log(`[RecepAI Config v3] ENV: ${ENV} → ${API_URL}`);
    if (!override) {
      console.log('[RecepAI] Ngrok? localStorage.setItem("API_URL_OVERRIDE", "https://xxx.ngrok-free.dev"); location.reload()');
    } else {
      console.log('[RecepAI] Override activ. Pentru a sterge: localStorage.removeItem("API_URL_OVERRIDE"); location.reload()');
    }
  }

  return { API_URL, ENV, VERSION: '3.0.0' };
})();

if (typeof module !== 'undefined') module.exports = CONFIG;
