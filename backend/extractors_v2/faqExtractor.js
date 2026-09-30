'use strict';

/**
 * FAQ Extractor — pulls Q/A pairs from the visible page.
 *
 * Patterns covered (in priority order):
 *   1. <details><summary>Q</summary><p>A</p></details>   (the pattern used
 *      on satoshicourt.com and most modern sites)
 *   2. Accordion markup: .faq-item / .accordion with h3/h4 questions
 *   3. Generic: heading or <p> ending in "?" followed by 1–3 lines of text
 *
 * Returns [{question, answer, page}] — no JSON-LD handling here
 * (jsonLdExtractor already covers FAQPage).
 */

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&eacute;|&Eacute;/g, 'é')
    .replace(/&iacute;/g, 'í').replace(/&ocirc;/g, 'ô').replace(/&acirc;/g, 'â')
    .replace(/&ccedil;|&Ccedil;/g, 'ç').replace(/&mdash;/g, '—')
    .trim();
}

function extractFaq(html, page = 'unknown') {
  if (!html) return [];
  const faqs = [];
  const seen = new Set();
  const add = (q, a) => {
    q = decodeEntities(q);
    a = decodeEntities(a);
    if (!q || !a || q.length < 5 || a.length < 10) return;
    const k = q.toLowerCase().slice(0, 50);
    if (seen.has(k)) return;
    seen.add(k);
    faqs.push({ question: q.slice(0, 200), answer: a.slice(0, 500), source: 'faq_extractor', page });
  };

  // 1) <details>/<summary> pairs
  const detRe = /<details[^>]*>[\s\S]*?<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi;
  let m;
  while ((m = detRe.exec(html)) !== null) {
    const q = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const a = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (q.endsWith('?') || /pentru|cat|care|cand|când|unde|pot |da\.|nu\.|^da|^nu/.test(q.toLowerCase())) {
      add(q, a);
    }
  }

  // 2) Accordion / faq-item blocks: <h3|4|5 ...>Question?</h3> <p>answer</p>
  if (faqs.length < 4) {
    const accRe = /<h([3-5])[^>]*>([\s\S]{5,200}?)\?[\s\S]*?<\/h[3-5]>\s*(?:<[^>]+>)*\s*<p[^>]*>([\s\S]{10,600}?)<\/p>/gi;
    while ((m = accRe.exec(html)) !== null) {
      add(m[2].replace(/<[^>]+>/g, ' '), m[3].replace(/<[^>]+>/g, ' '));
    }
  }

  // 3) Generic: a line ending in ? followed by 1-3 short lines (text content)
  if (faqs.length < 4) {
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, '\n')
      .replace(/&nbsp;|&#160;/g, ' ')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    for (let i = 0; i < text.length - 1; i++) {
      const q = text[i];
      if (!q.endsWith('?') || q.length < 12 || q.length > 160) continue;
      // next non-empty line(s) up to 200 chars, skip if it's another question
      let a = '';
      let j = i + 1;
      while (j < text.length && text[j] && !text[j].endsWith('?') && a.length < 300) {
        a = (a ? a + ' ' : '') + text[j];
        j++;
        if (a.length > 60) break; // 1-2 lines are enough
      }
      if (a.length >= 30) add(q, a);
    }
  }

  return faqs;
}

module.exports = { extractFaq };
