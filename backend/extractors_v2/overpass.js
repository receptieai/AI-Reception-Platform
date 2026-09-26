'use strict';

/**
 * OpenStreetMap Overpass fallback — FREE, keyless business data.
 *
 * When the scanner can't find a phone / website / hours on the site itself,
 * it asks OSM's community data (populated by local mappers — often very
 * accurate for RO clinics, vets, salons). No API key, no cost, no rate
 * limits on the private.coffee instance.
 *
 * SILENT NO-OP on any failure — if the network or OSM is unavailable,
 * returns null and the scan continues exactly as before.
 *
 * Pipeline:  Nominatim (city → center) → Overpass (name~ around center)
 */

const https = require('https');

const OVERPASS_ENDPOINTS = [
  'https://overpass.private.coffee/api/interpreter', // no rate limit
  'https://overpass-api.de/api/interpreter',        // main instance
];
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA = 'RecepAI/1.0 (local-business scanner; contact: founder@receptie.ai)';

// in-memory city→bbox cache (Nominatim asks for 1 req/s max)
const cityCache = new Map(); // city → { lat, lon, at }
const CACHE_TTL_MS = 3600 * 1000;

function httpsGetJson(url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

function overpassPost(query, endpoint, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const payload = 'data=' + encodeURIComponent(query);
    const u = new URL(endpoint);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

async function cityCenter(city) {
  if (!city) return null;
  const key = city.toLowerCase().trim();
  const cached = cityCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return { lat: cached.lat, lon: cached.lon };
  const j = await httpsGetJson(
    NOMINATIM + '?format=jsonv2&limit=1&q=' + encodeURIComponent(city), 8000);
  if (!j || !Array.isArray(j) || !j.length) return null;
  const c = { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon) };
  if (isNaN(c.lat) || isNaN(c.lon)) return null;
  cityCache.set(key, { ...c, at: Date.now() });
  return c;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} name  business name
 * @param {string} city  city (for the bounding box)
 * @returns {Promise<{name:string,phone:string|null,website:string|null,hours:string|null,address:string|null,source:string}|null>}
 */
async function overpassBusinessQuery(name, city) {
  if (!name || name.length < 3) return null;

  // bbox: city center ± ~5km, else a generous fallback box around Bucharest
  const c = await cityCenter(city);
  const lat = c ? c.lat : 44.4332;
  const lon = c ? c.lon : 26.1045;
  const d = 0.05;
  const bbox = (lat - d) + ',' + (lon - d) + ',' + (lat + d) + ',' + (lon + d);

  const query =
    '[out:json][timeout:20];' +
    '(node["name"~"' + escapeRegex(name).slice(0, 60) + '.*",' + 'i](' + bbox + ');' +
    'way["name"~"' + escapeRegex(name).slice(0, 60) + '.*",' + 'i](' + bbox + ');' +
    'relation["name"~"' + escapeRegex(name).slice(0, 60) + '.*",' + 'i](' + bbox + ');' +
    ');out tags 6;';

  let j = null;
  for (const ep of OVERPASS_ENDPOINTS) {
    j = await overpassPost(query, ep);
    if (j && j.elements) break;
  }
  if (!j || !Array.isArray(j.elements) || !j.elements.length) return null;

  // Pick the element that carries the most useful tags
  const score = (e) =>
    ((e.tags && e.tags.phone) ? 2 : 0) +
    ((e.tags && e.tags.website) ? 1 : 0) +
    ((e.tags && e.tags['opening_hours']) ? 1 : 0);
  const best = [...j.elements].sort((a, b) => score(b) - score(a))[0];
  const t = best.tags || {};
  if (!t.name && !t.phone) return null;

  return {
    name: t.name || name,
    phone: t.phone || t['contact:phone'] || t['contact:mobile'] || null,
    website: t.website || t['contact:website'] || null,
    hours: t.opening_hours || t['opening_hours:official'] || null,
    address: [t['addr:street'], t['addr:housenumber'], t['addr:city']].filter(Boolean).join(', ') || null,
    source: 'osm_overpass',
  };
}

module.exports = { overpassBusinessQuery };
