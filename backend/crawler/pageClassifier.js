'use strict';

const PAGE_RULES = [
  {
    type: 'prices',
    priority: 95,
    keywords: ['pret','preturi','tarif','tarife','lista-preturi','price','pricing','cost'],
    extractors: ['serviceExtractor'],
  },
  {
    type: 'services',
    priority: 90,
    keywords: ['servicii','tratamente','proceduri','services','treatments','what-we-do','ce-facem','oferta'],
    extractors: ['serviceExtractor'],
  },
  {
    type: 'doctors',
    priority: 85,
    keywords: ['echipa','medici','doctori','specialisti','team','staff','our-team','despre-noi','dr-','doctor-'],
    extractors: ['doctorExtractor'],
  },
  {
    type: 'contact',
    priority: 70,
    keywords: ['contact','contactati','contacteaza','find-us','locatie','adresa','location'],
    extractors: ['contactExtractor'],
  },
  {
    type: 'about',
    priority: 50,
    keywords: ['despre','about','cine-suntem','who-we-are','povestea','istoria','history'],
    extractors: ['contactExtractor'],
  },
  {
    type: 'faq',
    priority: 60,
    keywords: ['faq','intrebari','intrebari-frecvente','frequently-asked','questions'],
    extractors: ['faqExtractor'],
  },
];

const SKIP_RULES = [
  'blog','articol','article','news','stire','stiri',
  'gdpr','cookie','politic','privacy','terms','termeni',
  'cariere','job','career','sitemap','login','register',
  'cart','cos','checkout','admin','wp-admin','feed',
  '.pdf','.jpg','.png','.gif','.css','.js',
];

function classifyPage(url) {
  const lower = url.toLowerCase();

  // Skip irrelevant pages
  if (SKIP_RULES.some(r => lower.includes(r))) {
    return { type: 'skip', priority: -1, extractors: [], url };
  }

  // Match page type
  for (const rule of PAGE_RULES) {
    if (rule.keywords.some(kw => lower.includes(kw))) {
      return {
        type: rule.type,
        priority: rule.priority,
        extractors: rule.extractors,
        url,
      };
    }
  }

  // Default: unknown page, low priority
  return { type: 'other', priority: 20, extractors: ['serviceExtractor'], url };
}

function classifyPages(urls) {
  return urls
    .map(url => classifyPage(url))
    .filter(p => p.priority > 0)
    .sort((a, b) => b.priority - a.priority);
}

module.exports = { classifyPage, classifyPages };
