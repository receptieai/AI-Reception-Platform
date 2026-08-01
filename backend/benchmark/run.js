#!/usr/bin/env node
'use strict';

const https = require('https');

const SITES = [
  // DENTAL
  { url: 'https://clinicatrident.ro', industry: 'dental', minScore: 85 },
  { url: 'https://satoshicourt.com', industry: 'dental', minScore: 82 },
  { url: 'https://dentalmed.ro', industry: 'dental', minScore: 82 },
  { url: 'https://clinicaelite.ro', industry: 'dental', minScore: 82 },
  { url: 'https://dentexpert.ro', industry: 'dental', minScore: 60 },
  { url: 'https://ortodont.ro', industry: 'dental', minScore: 40 },
  // VET
  { url: 'https://amonvet.ro', industry: 'vet', minScore: 82 },
  { url: 'https://vetconsult.ro', industry: 'vet', minScore: 45 },
  { url: 'https://animallife.ro', industry: 'vet', minScore: 40 },
  // BEAUTY
  { url: 'https://salonfabricadefrumusete.ro', industry: 'beauty', minScore: 30 },
  { url: 'https://artistsalonacademy.ro', industry: 'beauty', minScore: 60 },
  { url: 'https://lovelyskin.ro', industry: 'beauty', minScore: 40 },
  // PHYSIO
  { url: 'https://fizioplus.ro', industry: 'physio', minScore: 55 },
  { url: 'https://recuperare-medicala.ro', industry: 'physio', minScore: 45 },
];

const API = process.env.API_URL || 'https://ai-reception-platform-production.up.railway.app';

async function scanSite(url) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ url });
    const apiUrl = new URL(API);
    const req = https.request({
      hostname: apiUrl.hostname,
      path: '/api/scan',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 60000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve({ error: 'parse error' }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

async function runBenchmark() {
  console.log('\n🔍 RecepAI Scanner V3 — Benchmark\n' + '='.repeat(50));
  const results = [];
  let passed = 0, failed = 0;

  for (const site of SITES) {
    process.stdout.write(`Scanning ${site.url}... `);
    const start = Date.now();
    const result = await scanSite(site.url);
    const duration = Math.round((Date.now() - start) / 1000);
    
    if (result.error) {
      console.log(`❌ ERROR: ${result.error}`);
      results.push({ ...site, confidence: 0, services: 0, duration, status: 'error' });
      failed++;
    } else {
      const conf = result.confidence || 0;
      const svcs = result.services?.length || 0;
      const ok = conf >= site.minScore;
      console.log(`${ok ? '✅' : '❌'} ${conf}% | ${svcs} servicii | ${duration}s`);
      results.push({ ...site, confidence: conf, services: svcs, duration, status: ok ? 'pass' : 'fail' });
      if (ok) passed++; else failed++;
    }
  }

  const avg = Math.round(results.filter(r => r.confidence > 0).reduce((a, b) => a + b.confidence, 0) / results.filter(r => r.confidence > 0).length);
  
  console.log('\n' + '='.repeat(50));
  console.log(`📊 Rezultate: ${passed}/${SITES.length} passed | Average: ${avg}%`);
  console.log(`${passed === SITES.length ? '🎉 ALL PASSED' : '⚠️ SOME FAILED'}`);
  
  // Save results
  const fs = require('fs');
  const report = { date: new Date().toISOString(), avg, passed, total: SITES.length, results };
  fs.writeFileSync('benchmark/latest.json', JSON.stringify(report, null, 2));
  console.log('\n💾 Saved to benchmark/latest.json\n');
  
  return passed === SITES.length;
}

runBenchmark().then(ok => process.exit(ok ? 0 : 1));
