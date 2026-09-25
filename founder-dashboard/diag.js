'use strict';
// ─────────────────────────────────────────────────────────────────────
// Diagnostic: why is a site's email not detected?
//
// Usage (from the AI-Reception-Platform folder, after git pull):
//   node founder-dashboard/diag.js https://clinicatrident.ro
//
// It:
//   1. Checks the scanner code actually has the Cloudflare cfemail fix.
//   2. Fetches the site (homepage + /contact) with the real crawler.
//   3. Reports: raw HTML size, whether data-cfemail is present,
//      every data-cfemail blob, what it decodes to, and what the
//      extractor returns. So you SEE exactly where the email is lost.
// ─────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const url = process.argv[2];
if (!url) { console.log('Usage: node founder-dashboard/diag.js https://site.ro'); process.exit(1); }

const ROOT = path.join(__dirname, '..');
const utilsPath = path.join(ROOT, 'backend/extractors_v2/utils.js');

// 1) Does the code have the fix?
const utilsSrc = fs.readFileSync(utilsPath, 'utf8');
const hasDecode = utilsSrc.includes('function decodeCfEmail');
console.log('────────────────────────────────────────────');
console.log('1) CODE CHECK');
console.log('   utils.js has decodeCfEmail :', hasDecode);
const contactSrc = fs.readFileSync(path.join(ROOT, 'backend/extractors_v2/contactExtractor.js'), 'utf8');
console.log('   contactExtractor uses cf_email:', contactSrc.includes('cf_email'));
if (!hasDecode) {
  console.log('\n   ❌ FIX NOT PRESENT in your local code. You did not git pull (or pulled the wrong branch).');
  console.log('      Run in the AI-Reception-Platform folder:  git pull');
  process.exit(2);
}

const { decodeCfEmail } = require(utilsPath);
const { extractEmail } = require(path.join(ROOT, 'backend/extractors_v2/contactExtractor.js'));
const { crawl } = require(path.join(ROOT, 'backend/scanner/crawler.js'));

(async () => {
  console.log('\n2) CRAWL');
  const cr = await crawl(url, { maxPages: 12, timeout: 15000 });
  if (!cr.pages || cr.pages.length === 0) { console.log('   ❌ Could not fetch', url, '-', cr.error || 'no pages'); process.exit(3); }
  console.log('   fetched', cr.pages.length, 'pages from', cr.origin);

  let foundAny = false;
  for (const page of cr.pages) {
    const cf = [...page.html.matchAll(/data-cfemail=["']([0-9a-fA-F]{4,128})["']/gi)].map(m => m[1]);
    const mailtos = [...page.html.matchAll(/href=["']mailto:([^"'\s?&]+)["']/gi)].map(m => m[1]);
    const ext = extractEmail(page.html, page.label);
    const note = cf.length ? 'cfemail blobs=' + cf.length : (mailtos.length ? 'mailto links' : 'no email hints');
    console.log('   [' + page.label + '] ' + page.url);
    console.log('      size=' + page.html.length + ' | ' + note);
    for (const b of cf.slice(0, 5)) {
      const d = decodeCfEmail(b);
      console.log('      cfemail ' + b.slice(0, 16) + '… -> ' + (d || '(decode failed)'));
      if (d) foundAny = true;
    }
    if (ext.value) {
      console.log('      ➜ EXTRACTOR FOUND: ' + ext.value + ' (conf ' + ext.confidence + ', via ' + ext.source + ')');
      foundAny = true;
    }
  }

  console.log('\n3) RESULT');
  if (foundAny) {
    console.log('   ✅ An email WAS found somewhere in the crawled pages (see above).');
    console.log('   If it still doesn\'t show in the dashboard, the running server is STALE — kill all node servers and restart.');
  } else {
    console.log('   ❌ No email found in any crawled page — even after cfemail decode.');
    console.log('   That means Trident hides the email another way (image? JS-built? JS-rendered page?). Tell me and I\'ll add that detector.');
  }
  console.log('────────────────────────────────────────────');
})().catch(e => { console.log('ERROR:', e.message); process.exit(1); });
