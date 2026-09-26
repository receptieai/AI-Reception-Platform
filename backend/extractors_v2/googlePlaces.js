'use strict';

/**
 * Google Places fallback — fills phone / address / website for sites the
 * scanner couldn't fully read, using Google's public business data.
 *
 * SILENT NO-OP without GOOGLE_PLACES_API_KEY — if the key is absent,
 * returns null and the scan continues exactly as before. Never throws.
 *
 * Cost note: Text Search is billed per call. We only call it when a field
 * is actually missing, so steady-state cost stays low.
 */

const https = require('https');

/**
 * @param {string} name      business name (most useful query signal)
 * @param {string} address   street address (optional)
 * @param {string} city      city (optional)
 * @param {string} apiKey    GOOGLE_PLACES_API_KEY
 * @returns {Promise<{phone:string|null,address:string|null,website:string|null,city:string|null,source:string}|null>}
 */
function googlePlacesQuery(name, address, city, apiKey) {
  return new Promise((resolve) => {
    if (!apiKey) return resolve(null);
    const q = [name, city, address].filter(Boolean).join(', ').slice(0, 200);
    if (q.length < 3) return resolve(null);
    const url = 'https://maps.googleapis.com/maps/api/place/textsearch/json?query=' +
      encodeURIComponent(q) + '&key=' + encodeURIComponent(apiKey);
    const req = https.get(url, { headers: { 'User-Agent': 'RecepAI' } }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.status !== 'OK' || !j.results || !j.results.length) return resolve(null);
          const r = j.results[0];
          resolve({
            phone: r.formatted_phone_number || r.international_phone_number || null,
            address: r.formatted_address || null,
            website: r.website || null,
            city: (r.geometry && r.geometry.location && r.formatted_address)
              ? detectCity(r.formatted_address) : null,
            source: 'google_places',
          });
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

const CITIES = [
  'București','Cluj','Timișoara','Iași','Constanța','Craiova','Brașov','Bacău',
  'Arad','Sibiu','Pitești','Oradea','Vâlcea','Râmnicu Vâlcea','Galicea','Horezu',
];
function detectCity(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  for (const c of CITIES) if (t.includes(c.toLowerCase().replace('.', ''))) return c;
  return null;
}

module.exports = { googlePlacesQuery };
