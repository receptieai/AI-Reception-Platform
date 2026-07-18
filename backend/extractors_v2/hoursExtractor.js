'use strict';
const { extractJsonLd, field, bestField } = require('./utils');

function extractHours(html, page='homepage') {
  const candidates = [];
  const jsonLd = extractJsonLd(html);
  jsonLd.forEach(item => {
    if (item.openingHours) candidates.push(field([].concat(item.openingHours).join(' | '),'json_ld',95,'openingHours',page));
  });
  const textOnly = html.replace(/<[^>]+>/g,' ');
  const days = 'Luni|Marți|Miercuri|Joi|Vineri|Sâmbătă|Duminică|Lun|Mar|Mie';
  const rangePattern = new RegExp(`((?:${days})\\s*[-–]\\s*(?:${days})?\\s*:?\\s*\\d{1,2}[:.]\\d{2}\\s*[-–]\\s*\\d{1,2}[:.]\\d{2})`,'gi');
  const ranges = [...textOnly.matchAll(rangePattern)].map(m=>m[1].trim());
  if (ranges.length > 0) candidates.push(field([...new Set(ranges)].slice(0,5).join(' | '),'regex',75,'day-hours pattern',page));
  const label = textOnly.match(/(?:Program|Orar)\s*:?\s*((?:Luni|Mon|Lun)[\s\S]{10,200}?(?:\d{2}:\d{2}))/i);
  if (label) candidates.push(field(label[1].trim().substring(0,200),'label_text',70,'Program: label',page));
  return { value: bestField(...candidates) };
}

module.exports = { extractHours };
