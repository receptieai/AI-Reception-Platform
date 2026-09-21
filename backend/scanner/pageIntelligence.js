'use strict';

// Page Intelligence — classify a page BEFORE extraction so the right
// extractors run with priority. Pure heuristics: URL path + content signals.
// No external model needed (fast, offline).

// -> returns { type, confidence, signals[] }
// type: PRICING | SERVICES | TEAM | CONTACT | EMERGENCY | FAQ | HOURS | ABOUT | HOME | GENERIC

function classifyPage(url, html) {
  const path = (url || '').toLowerCase().replace(/^https?:\/\/[^/]+/, '');
  const p = path.split('?')[0].split('#')[0];
  const text = (html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const textLower = text.toLowerCase();
  const signals = [];

  const count = (re) => (textLower.match(re) || []).length;

  // Price-density signal
  const priceHits = count(/\d{2,5}\s*(?:lei|ron|€|eur)/gi);
  const hasPriceTable = /<table[\s\S]*?<\/table>/i.test(text) && priceHits > 2;
  const priceLabels = count(/(tarif|pret|preț|preturi|tarife|pricing|price list|listă|lista (?:tarifului|prețurilor))/gi);
  const serviceLabels = count(/(servici|tratament|procedur|epilare|implant|ortodont|albire|consult|sedare|laser|hidrapor|hydra|ingrijire)/gi);
  const teamLabels = count(/(echip[ăa]|doctor|medic|dentist|specialist|equipe|team|physio|kinetoterapeut|veterinar)/gi);
  const contactLabels = count(/(contact|sun[ăa] ne|apel|scrie ne|email|telefon|adres[ăa]|program[ăa]r[ie])/gi);
  const faqLabels = count(/(întreb[ăa]|intreb|faq|întreab[ăa]|întrebați|întrebați-ne|dori[țt]i s[ăa] [^,]{0,40}știi)/gi);
  const emergencyLabels = count(/(urgent[ăa]|urgent|de urgen[țt]|[aa]iud|asisten[țt][ăa] de urgen)/gi);
  const hoursLabels = count(/(program de lucru|ore de program|orar|programul (?:nostru|de lucru)|luni|mar[țt]i)/gi);
  const aboutLabels = count(/(despre (?:noi|clinic[ăa]|ne)|mission|viziune|about us|despre (?:clinica|salonul|clinic[ăa]))/gi);

  // Path-based classification (strongest signal)
  let byPath = null;
  if (/(^|\/)(tarife|tarif|preturi|pret|pret-|preturi|prices|pricing|tarif|list-preturi|servicii-si-preturi)(\/|$)/.test(p)) { byPath = 'PRICING'; }
  else if (/(^|\/)(servicii|serviciile|tratament|tratamente|proceduri|oferte|epilare|tratamente-faciale)(\/|$)/.test(p)) { byPath = 'SERVICES'; }
  else if (/(^|\/)(echipa|echipe|doctori|medici|echip|team|staff|medic-|doctor-)/.test(p)) { byPath = 'TEAM'; }
  else if (/(^|\/)(contact|contact-|sun[ăa]-ne|suna-ne)(\/|$)/.test(p)) { byPath = 'CONTACT'; }
  else if (/(^|\/)(urgent|urgente|de-urgent)(\/|$)/.test(p)) { byPath = 'EMERGENCY'; }
  else if (/(^|\/)(faq|intrebari|intreb[ăa]ri|întreb[ăa]ri)(\/|$)/.test(p)) { byPath = 'FAQ'; }
  else if (/(^|\/)(despre|about|despre-noi)(\/|$)/.test(p)) { byPath = 'ABOUT'; }
  else if (p === '/' || p === '') { byPath = 'HOME'; }

  // Content-based (used when path is unknown or generic)
  let byContent = null;
  if (hasPriceTable || (priceLabels >= 2 && priceHits >= 5)) byContent = 'PRICING';
  else if (teamLabels >= 3 && serviceLabels < teamLabels) byContent = 'TEAM';
  else if (emergencyLabels >= 2) byContent = 'EMERGENCY';
  else if (faqLabels >= 3) byContent = 'FAQ';
  else if (hoursLabels >= 3 && contactLabels < hoursLabels) byContent = 'HOURS';
  else if (aboutLabels >= 2 && serviceLabels < aboutLabels) byContent = 'ABOUT';
  else if (serviceLabels >= 5) byContent = 'SERVICES';
  else if (contactLabels >= 4 && serviceLabels < contactLabels) byContent = 'CONTACT';

  let type = byPath || byContent || 'GENERIC';
  // Homepage with services/prices is effectively a services + pricing hub
  if (type === 'HOME') {
    if (priceHits >= 5) type = 'SERVICES';
    else if (serviceLabels >= 3) type = 'SERVICES';
  }

  let confidence = 50;
  if (byPath && byPath === type) confidence = 90;
  else if (byPath) confidence = 70; // content disagreed with path — keep path
  else if (byContent) confidence = 75;

  const signalList = [];
  if (byPath) signalList.push('path:' + (byPath.toLowerCase()));
  if (priceHits) signalList.push('prices:' + priceHits);
  if (teamLabels >= 3) signalList.push('team:' + teamLabels);
  if (serviceLabels >= 3) signalList.push('services:' + serviceLabels);
  if (contactLabels >= 3) signalList.push('contact:' + contactLabels);
  if (faqLabels >= 2) signalList.push('faq:' + faqLabels);
  if (emergencyLabels >= 2) signalList.push('emergency:' + emergencyLabels);

  return { type, confidence, signals: signalList, path: p, stats: { priceHits, serviceLabels, teamLabels, contactLabels, faqLabels, emergencyLabels, hoursLabels } };
}

// Which extractors should run (and with what weight) on this page type?
// Returns array of extractor names in priority order.
function recommendedExtractors(classification) {
  const byType = {
    PRICING:   ['services', 'prices', 'contact', 'hours'],
    SERVICES:  ['services', 'facilities', 'contact'],
    TEAM:      ['doctors', 'facilities', 'contact'],
    CONTACT:   ['contact', 'hours', 'social'],
    EMERGENCY: ['contact', 'hours', 'emergency'],
    FAQ:       ['faq', 'contact'],
    HOURS:     ['hours', 'contact'],
    ABOUT:     ['facilities', 'payments', 'social'],
    HOME:      ['services', 'contact', 'hours', 'doctors', 'facilities'],
    GENERIC:   ['services', 'contact', 'hours'],
  };
  return byType[classification.type] || byType.GENERIC;
}

module.exports = { classifyPage, recommendedExtractors };
