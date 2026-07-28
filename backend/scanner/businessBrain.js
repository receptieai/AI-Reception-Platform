'use strict';

// Business Brain — inferență semantică per industrie
// Nu regex. Knowledge.

const DENTAL_SIGNALS = {
  brands: {
    'Straumann': { tags: ['implantologie', 'implant premium'], confidence: 95 },
    'Nobel Biocare': { tags: ['implantologie', 'implant premium'], confidence: 95 },
    'Osstem': { tags: ['implantologie'], confidence: 90 },
    'MegaGen': { tags: ['implantologie'], confidence: 90 },
    'Invisalign': { tags: ['ortodontie', 'alinere invizibila'], confidence: 95 },
    'Align Technology': { tags: ['ortodontie', 'alinere invizibila'], confidence: 90 },
    'EMS Airflow': { tags: ['profilaxie avansata', 'detartraj'], confidence: 90 },
    'Zeiss': { tags: ['endodontie avansata', 'microscop'], confidence: 90 },
    'CBCT': { tags: ['radiologie 3D', 'tomografie'], confidence: 85 },
    'Cerec': { tags: ['coroane ceramice CAD/CAM', 'proteze rapide'], confidence: 90 },
    'Zoom': { tags: ['albire profesionala'], confidence: 85 },
    'Philips Zoom': { tags: ['albire profesionala'], confidence: 90 },
    'KaVo': { tags: ['echipamente premium'], confidence: 75 },
    'Dentsply': { tags: ['materiale dentare premium'], confidence: 75 },
  },
  insurance: {
    'Signal Iduna': 'Signal Iduna',
    'Allianz': 'Allianz',
    'MedLife': 'MedLife',
    'Regina Maria': 'Regina Maria',
    'Sanador': 'Sanador',
    'Medicover': 'Medicover',
    'Omniasig': 'Omniasig',
    'Generali': 'Generali',
    'AXA': 'AXA',
    'Uniqa': 'Uniqa',
    'Groupama': 'Groupama',
  },
  facilities: {
    'sedare': 'sedare disponibila',
    'protoxid': 'sedare cu protoxid de azot',
    'anestezie generala': 'anestezie generala disponibila',
    'parcare': 'parcare disponibila',
    'parking': 'parcare disponibila',
    'urgente': 'urgente stomatologice',
    'urgenta': 'urgente stomatologice',
    'copii': 'stomatologie pediatrica',
    'pediatric': 'stomatologie pediatrica',
    'noapte': 'program nocturn',
    'weekend': 'program weekend',
    'sambata': 'program sambata',
    'duminica': 'program duminica',
    'microscop': 'tratament sub microscop',
    'laser': 'tratamente laser',
    'radiologie': 'radiologie digitala',
    'rx': 'radiologie digitala',
    'panoramic': 'radiografie panoramica',
    'cbct': 'tomografie CBCT 3D',
    'sterilizare': 'sterilizare certificata',
    'aparat dentar': 'ortodontie',
    'aparat fix': 'ortodontie fixa',
    'aparat mobil': 'ortodontie mobila',
    'fatete': 'fatete dentare',
    'fatete ceramice': 'fatete ceramice',
    'implant': 'implantologie',
    'albire': 'albire dentara',
    'detartraj': 'detartraj profesional',
    'canal': 'tratament de canal',
    'endodontie': 'endodontie',
    'parodontologie': 'parodontologie',
    'chirurgie': 'chirurgie orala',
    'extractie': 'extractii dentare',
    'protetica': 'protetica dentara',
    'coroana': 'coroane dentare',
    'punte': 'punti dentare',
    'proteza': 'proteze dentare',
  },
};

const VET_SIGNALS = {
  facilities: {
    'urgente': 'urgente veterinare 24/7',
    'urgenta': 'urgente veterinare',
    'noapte': 'program nocturn',
    'gardă': 'garda veterinara',
    'chirurgie': 'chirurgie veterinara',
    'anestezie': 'anestezie veterinara',
    'laborator': 'laborator analize',
    'ecografie': 'ecografie',
    'radiografie': 'radiologie veterinara',
    'rx': 'radiologie',
    'vaccinare': 'vaccinare',
    'deparazitare': 'deparazitare',
    'sterilizare': 'sterilizare animale',
    'castrare': 'castrare',
    'pension': 'pensiune animale',
    'hotel': 'hotel animale',
    'grooming': 'grooming',
    'dentara': 'stomatologie veterinara',
    'cardiologie': 'cardiologie veterinara',
    'dermatologie': 'dermatologie veterinara',
    'oftalmologie': 'oftalmologie veterinara',
    'ortopedie': 'ortopedie veterinara',
    'oncologie': 'oncologie veterinara',
  },
  species: {
    'câine': 'tratament caini',
    'caine': 'tratament caini',
    'pisică': 'tratament pisici',
    'pisica': 'tratament pisici',
    'iepure': 'animale exotice',
    'papagal': 'animale exotice',
    'hamster': 'animale mici',
    'reptile': 'reptile',
  },
};

const BEAUTY_SIGNALS = {
  services: {
    'manichiura': 'manichiura',
    'pedichiura': 'pedichiura',
    'gel': 'unghii gel',
    'acryl': 'unghii acryl',
    'epilare': 'epilare',
    'laser': 'epilare laser',
    'ceara': 'epilare ceara',
    'masaj': 'masaj',
    'facial': 'tratamente faciale',
    'lifting': 'lifting',
    'botox': 'botox',
    'filler': 'fillere',
    'peeling': 'peeling',
    'microblading': 'microblading sprancene',
    'extensii': 'extensii gene',
    'vopsit': 'vopsit par',
    'highlights': 'highlights',
    'balayage': 'balayage',
    'keratina': 'tratament keratina',
    'coafat': 'coafat',
    'tuns': 'tuns',
    'frizerie': 'frizerie',
    'barbershop': 'barbershop',
    'tatuaj': 'tatuaje',
    'piercing': 'piercing',
    'solarium': 'solarium',
    'bronzare': 'bronzare',
    'spa': 'spa',
    'sauna': 'sauna',
    'jacuzzi': 'jacuzzi',
  },
};

const PHYSIO_SIGNALS = {
  services: {
    'kinetoterapie': 'kinetoterapie',
    'fizioterapie': 'fizioterapie',
    'masaj': 'masaj terapeutic',
    'recuperare': 'recuperare medicala',
    'electroterapie': 'electroterapie',
    'ultrasunete': 'ultrasunete terapeutice',
    'laser': 'laserterapie',
    'magnetoterapie': 'magnetoterapie',
    'hidroterapie': 'hidroterapie',
    'terapie manuala': 'terapie manuala',
    'osteopatie': 'osteopatie',
    'acupunctura': 'acupunctura',
    'intepare': 'dry needling',
    'kinesio': 'kinesio taping',
    'sport': 'recuperare sportiva',
    'coloana': 'recuperare coloana vertebrala',
    'hernie': 'tratament hernie de disc',
    'scolioza': 'tratament scolioza',
    'artroza': 'tratament artroza',
    'artrita': 'tratament artrita',
    'accident': 'recuperare post accident',
    'operatie': 'recuperare postoperatorie',
  },
};

function detectIndustry(html, knownType) {
  if (knownType && knownType !== 'other') return knownType;
  const text = html.toLowerCase();
  const scores = { dental: 0, vet: 0, beauty: 0, physio: 0, medical: 0 };
  const dentalKw = ['dentar','stomatolog','implant','ortodont','canal','protetica','dinte','gingie'];
  const vetKw = ['veterinar','animal','câine','pisică','caine','pisica','vaccinare','deparazit'];
  const beautyKw = ['salon','coafor','manichiura','pedichiura','epilare','masaj','cosmetica','spa'];
  const physioKw = ['kinetoterapie','fizioterapie','recuperare','masaj terapeutic','electroterapie'];
  const medKw = ['clinica','cabinet medical','medicina','cardiolog','neurolog','pediatru','ginecolog'];
  for (const kw of dentalKw) if (text.includes(kw)) scores.dental += 5;
  for (const kw of vetKw) if (text.includes(kw)) scores.vet += 5;
  for (const kw of beautyKw) if (text.includes(kw)) scores.beauty += 5;
  for (const kw of physioKw) if (text.includes(kw)) scores.physio += 5;
  for (const kw of medKw) if (text.includes(kw)) scores.medical += 3;
  const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return top[1] > 0 ? top[0] : 'other';
}

function applyBrain(combinedText, industry, extractedData) {
  const text = combinedText.toLowerCase();
  const inferences = {
    tags: [],
    insurances: [],
    facilities: [],
    technologies: [],
    specialties: [],
  };

  if (industry === 'dental') {
    // Brand detection
    for (const [brand, info] of Object.entries(DENTAL_SIGNALS.brands)) {
      if (text.includes(brand.toLowerCase())) {
        inferences.technologies.push({ name: brand, tags: info.tags, confidence: info.confidence });
        inferences.tags.push(...info.tags);
      }
    }
    // Insurance detection
    for (const [ins, label] of Object.entries(DENTAL_SIGNALS.insurance)) {
      if (text.includes(ins.toLowerCase())) {
        inferences.insurances.push(label);
      }
    }
    // Facility detection
    for (const [kw, label] of Object.entries(DENTAL_SIGNALS.facilities)) {
      if (text.includes(kw.toLowerCase())) {
        if (!inferences.facilities.includes(label)) inferences.facilities.push(label);
      }
    }
  }

  if (industry === 'vet') {
    for (const [kw, label] of Object.entries(VET_SIGNALS.facilities)) {
      if (text.includes(kw.toLowerCase())) {
        if (!inferences.facilities.includes(label)) inferences.facilities.push(label);
      }
    }
    for (const [kw, label] of Object.entries(VET_SIGNALS.species)) {
      if (text.includes(kw.toLowerCase())) {
        if (!inferences.specialties.includes(label)) inferences.specialties.push(label);
      }
    }
  }

  if (industry === 'beauty') {
    for (const [kw, label] of Object.entries(BEAUTY_SIGNALS.services)) {
      if (text.includes(kw.toLowerCase())) {
        if (!inferences.specialties.includes(label)) inferences.specialties.push(label);
      }
    }
  }

  if (industry === 'physio') {
    for (const [kw, label] of Object.entries(PHYSIO_SIGNALS.services)) {
      if (text.includes(kw.toLowerCase())) {
        if (!inferences.specialties.includes(label)) inferences.specialties.push(label);
      }
    }
  }

  // Emergency detection (all industries)
  if (/urgent|gardă|24\/7|non-?stop|nonstop|permanent disponibil/i.test(combinedText)) {
    inferences.emergency = true;
    if (!inferences.facilities.includes('urgente disponibile')) {
      inferences.facilities.push('urgente disponibile');
    }
  }

  // Parking detection
  if (/parcare|parking|loc de parcare|parcare gratuita/i.test(combinedText)) {
    inferences.parking = true;
    if (!inferences.facilities.includes('parcare disponibila')) {
      inferences.facilities.push('parcare disponibila');
    }
  }

  // Weekend/extended hours
  if (/sâmbătă|sambata|weekend|duminică|duminica/i.test(combinedText)) {
    inferences.weekendHours = true;
  }

  // Unique tags
  inferences.tags = [...new Set(inferences.tags)];
  inferences.facilities = [...new Set(inferences.facilities)];
  inferences.insurances = [...new Set(inferences.insurances)];
  inferences.specialties = [...new Set(inferences.specialties)];

  const brainScore = Math.min(
    50 + inferences.tags.length * 3 + inferences.facilities.length * 2 + inferences.insurances.length * 5,
    100
  );

  return {
    ...inferences,
    brainScore,
    industry,
  };
}


const TYPICAL_SERVICES = {
  dental: [
    { name: 'Consultație stomatologică', price: null },
    { name: 'Detartraj și periaj profesional', price: null },
    { name: 'Obturație compozită', price: null },
    { name: 'Tratament de canal', price: null },
    { name: 'Extracție dentară', price: null },
    { name: 'Albire dentară', price: null },
    { name: 'Implant dentar', price: null },
    { name: 'Proteză dentară', price: null },
    { name: 'Aparat dentar', price: null },
    { name: 'Radiografie dentară', price: null },
  ],
  vet: [
    { name: 'Consultație veterinară', price: null },
    { name: 'Vaccinare', price: null },
    { name: 'Deparazitare internă și externă', price: null },
    { name: 'Sterilizare', price: null },
    { name: 'Analize sânge', price: null },
    { name: 'Ecografie', price: null },
    { name: 'Radiografie', price: null },
    { name: 'Chirurgie veterinară', price: null },
  ],
  beauty: [
    { name: 'Tuns și coafat', price: null },
    { name: 'Vopsit păr', price: null },
    { name: 'Manichiură', price: null },
    { name: 'Pedichiură', price: null },
    { name: 'Epilare ceară', price: null },
    { name: 'Masaj relaxant', price: null },
    { name: 'Tratament facial', price: null },
    { name: 'Extensii gene', price: null },
  ],
  physio: [
    { name: 'Consultație kinetoterapie', price: null },
    { name: 'Masaj terapeutic', price: null },
    { name: 'Electroterapie', price: null },
    { name: 'Recuperare medicală', price: null },
    { name: 'Kinetoterapie', price: null },
    { name: 'Ultrasunete terapeutice', price: null },
    { name: 'Laserterapie', price: null },
  ],
  medical: [
    { name: 'Consultație medicală', price: null },
    { name: 'Analize medicale', price: null },
    { name: 'Ecografie', price: null },
    { name: 'Electrocardiogramă', price: null },
    { name: 'Vaccinare', price: null },
  ],
};

function getTypicalServices(industry) {
  return TYPICAL_SERVICES[industry] || [];
}

module.exports = { applyBrain, detectIndustry, getTypicalServices };

