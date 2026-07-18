'use strict';
const { extractJsonLd, stripHtml, deduplicateAndScore } = require('./utils');

const SPECIALTIES = ['implantologie','ortodonție','ortodontie','endodonție','endodontie','protetică','protetica','pedodonție','pedodontie','chirurgie orală','estetică dentară','parodontologie','radiologie','stomatologie','cardiologie','oftalmologie','ortopedie','reumatologie','orl','pediatrie','ginecologie','dermatologie','neurologie','nutritie','nutriție','endocrinologie','kinetoterapie','fizioterapie'];

function findSpecialties(ctx) {
  return [...new Set(SPECIALTIES.filter(s=>ctx.toLowerCase().includes(s.toLowerCase())))];
}

function extractDoctors(html, page='homepage') {
  const all = [];
  const text = stripHtml(html);

  // JSON-LD Person (95%)
  extractJsonLd(html).forEach(item => {
    const types = [item['@type']].flat();
    if (types.some(t=>['Person','Physician','Dentist'].includes(t)) && item.name) {
      all.push({ name:item.name, specialties:item.jobTitle?[item.jobTitle]:findSpecialties(JSON.stringify(item)), description:item.description?.substring(0,200)||null, photo:item.image||null, source:['json_ld'], confidence:95, page });
    }
  });

  // Doctor card patterns (85%)
  const cardPat = /<div[^>]*class="[^"]*(?:doctor|medic|team|echipa|member|staff)[^"]*"[^>]*>([\s\S]{20,500}?)<\/div>/gi;
  let m;
  while ((m=cardPat.exec(html))!==null) {
    const cardText = stripHtml(m[1]);
    const nm = cardText.match(/(?:Dr\.?\s+)?([A-ZĂÂÎȘȚ][a-zăâîșț]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț]+){1,3})/);
    if (nm) all.push({ name:nm[0].trim(), specialties:findSpecialties(cardText), description:cardText.substring(0,200), source:['card_pattern'], confidence:85, page });
  }

  // Dr. regex (80%)
  const drPat = /(?:Dr\.?|Doctor|Conf\.?\s+Dr\.?|Prof\.?\s+Dr\.?|Medic(?:\s+Primar|\s+Specialist)?)\s+([A-ZĂÂÎȘȚ][a-zăâîșț]+(?:[\s\-][A-ZĂÂÎȘȚ][a-zăâîșț]+){1,3})/g;
  while ((m=drPat.exec(text))!==null) {
    const fullName = m[0].trim();
    if (fullName.length > 5) {
      const idx = text.indexOf(fullName);
      const ctx = text.substring(Math.max(0,idx-100),idx+300);
      all.push({ name:fullName, specialties:findSpecialties(ctx), source:['regex_dr'], confidence:80, page });
    }
  }

  const dedup = deduplicateAndScore(all);
  return { type:'doctors', items:dedup.slice(0,20), confidence:dedup.length>0?dedup[0].confidence:0, source:['json_ld','card_pattern','regex_dr'], warnings:[], durationMs:0 };
}

module.exports = { extractDoctors };
