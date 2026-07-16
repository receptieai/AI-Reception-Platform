'use strict';
const { extractJsonLd, field, cleanUrl } = require('./utils');

function extractSocial(html, page='homepage') {
  const result = {};
  const platforms = {
    facebook: { patterns: [/facebook\.com/i], exclude: ['sharer','share.php','login'] },
    instagram: { patterns: [/instagram\.com/i], exclude: [] },
    tiktok: { patterns: [/tiktok\.com/i], exclude: [] },
    youtube: { patterns: [/youtube\.com\/(?:channel|c|@|user)\//i], exclude: [] },
    whatsapp: { patterns: [/wa\.me/i, /api\.whatsapp\.com/i], exclude: [] },
    linkedin: { patterns: [/linkedin\.com\/(?:company|in)\//i], exclude: [] },
  };

  const jsonLd = extractJsonLd(html);
  jsonLd.forEach(item => {
    [].concat(item.sameAs||[]).forEach(url => {
      Object.entries(platforms).forEach(([p, cfg]) => {
        if (!result[p] && cfg.patterns.some(r=>r.test(url)) && !cfg.exclude.some(e=>url.includes(e)))
          result[p] = field(cleanUrl(url),'json_ld_sameAs',100,'sameAs',page);
      });
    });
  });

  const hrefs = [...html.matchAll(/href=["'](https?:\/\/[^"'\s]+)["']/gi)];
  hrefs.forEach(m => {
    Object.entries(platforms).forEach(([p, cfg]) => {
      if (!result[p] && cfg.patterns.some(r=>r.test(m[1])) && !cfg.exclude.some(e=>m[1].includes(e)))
        result[p] = field(cleanUrl(m[1]),'html_href',95,'href link',page);
    });
  });

  Object.keys(platforms).forEach(p => { if (!result[p]) result[p] = field(null,'not_found',0,'not found'); });
  return result;
}

module.exports = { extractSocial };
