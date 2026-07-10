# BrainBank v3 — Ghid de integrare

## Ce s-a schimbat față de v2

| Schimbare | Detalii |
|-----------|---------|
| **Business Rules Engine** | Layer NOU — logică deterministă separată de AI |
| **Knowledge Sources** | Acum include `updatedBy` (user/scanner/admin) |
| **Confidence Brain** | Include `reason` ("Found on homepage only, no JSON-LD") |
| **Appointment Brain** | Configurabil de client: durate custom, reguli per specialist |
| **Learning Brain** | Generează RECOMANDĂRI — nu modifică automat BrainBank |
| **Versioning** | Limitat la 20 versiuni (nu 2000) |

---

## Instalare

```bash
cp -r brainbank/ ~/Documents/AI-Reception-Platform/backend/brainbank/
cd ~/Documents/AI-Reception-Platform/backend
node brainbank/test-brainbank.js
# → 132 passed, 0 failed ✅
```

---

## Integrare în server.js

```javascript
const {
  generateSystemPrompt,
  analyzeConversation,
  updateFeedbackData,
  updateLearningData,
  generateRecommendations,
  createKnowledge,
  updateKnowledge,
  evaluateBusinessRules,
} = require('./brainbank/brainbank');

// ═══ /api/chat ═══

app.post('/api/chat', async (req, res) => {
  const { message, companyId, conversationHistory } = req.body;

  const companyData   = await getCompanyData(companyId);
  const learningData  = await getLearningData(companyData.industry);
  const businessRules = await getBusinessRules(companyId); // regulile custom

  // Generează prompt cu toate cele 11 componente
  const systemPrompt = generateSystemPrompt({
    industry: companyData.industry,
    companyData,
    conversationHistory,
    learningData,
    includeAppointments: true,
    userMessage: message,          // Retrieval Layer
    businessRules,                 // Business Rules Engine
  });

  const response = await callClaude({
    system: systemPrompt,
    messages: [...conversationHistory, { role: 'user', content: message }],
  });

  // Feedback + Learning (async)
  setImmediate(async () => {
    try {
      const fullHistory = [...conversationHistory,
        { role: 'user', content: message },
        { role: 'assistant', content: response }
      ];
      const analysis = analyzeConversation(fullHistory);

      const fb = await getFeedbackData(companyId);
      await saveFeedbackData(companyId, updateFeedbackData(fb, analysis));

      const lr = updateLearningData(learningData, analysis);
      await saveLearningData(companyData.industry, lr);

      // Generează recomandări (le vezi în dashboard)
      const updatedFb = updateFeedbackData(fb, analysis);
      if (updatedFb.totalConversations % 10 === 0) { // la fiecare 10 conversații
        const recs = generateRecommendations(lr, updatedFb);
        if (recs.length > 0) await saveRecommendations(companyId, recs);
      }
    } catch (e) {
      console.error('Feedback error:', e.message);
    }
  });

  res.json({ response });
});
```

---

## Business Rules Engine — cum funcționează

Regulile de business sunt SEPARATE de AI. Sunt logică deterministă.

### Reguli default per industrie (automate):

```
dental:
  - Urgențe au prioritate
  - Implant doar dimineața (08-12)
  - Nu două implanturi consecutive

vet:
  - Chirurgii doar dimineața
  - Sterilizare necesită confirmare cu 24h

beauty:
  - Coafură mireasă cu 2 săptămâni înainte

auto:
  - Distribuție = zi întreagă
```

### Reguli custom (configurate de client):

```javascript
// Salvate per client — editabile din Dashboard
const businessRules = [
  {
    id: 'no-friday-implant',
    type: 'schedule',
    condition: { field: 'dayOfWeek', operator: 'eq', value: 'vineri' },
    action: { type: 'block', message: 'Nu programăm implanturi vinerea.' },
    active: true,
  },
  {
    id: 'ortho-only-dr-pop',
    type: 'staff',
    condition: { field: 'service', operator: 'eq', value: 'ortodonție' },
    action: { type: 'restrict_time', message: 'Ortodonția doar cu Dr. Popescu, marți.',
              allowedHours: [8,9,10,11,12,13,14,15,16] },
    active: true,
  },
];
```

### Evaluare programă:

```javascript
// Când clientul cere o programare, evaluezi regulile:
const result = evaluateBusinessRules('dental', customRules, {
  service: 'implant',
  hour: 15,           // ora cerută
  dayOfWeek: 'vineri',
  isUrgency: false,
});

// result = {
//   allowed: false,
//   messages: ['Implanturile se programează doar dimineața.', 'Nu vinerea.'],
//   appliedRules: ['implant-morning', 'no-friday-implant'],
// }
```

---

## Knowledge Sources — updatedBy + reason

```javascript
// Din scanner
companyData.phone = createKnowledge(
  '0722 123 456',     // value
  'scanner',          // source
  100,                // confidence
  'scanner',          // updatedBy
  'Found in tel: link' // reason
);

// Client confirmă în onboarding
companyData.phone = updateKnowledge(
  companyData.phone,
  '0722 999 888',     // new value
  'manual',           // source
  100,                // confidence
  'user',             // updatedBy
  'Client confirmed'  // reason
);

// Versiunea veche e în .history — poți reveni
console.log(companyData.phone.history);
// [{ value: '0722 123 456', source: 'scanner', confidence: 100, ... }]
```

---

## Confidence Brain — motivul contează

Acum AI-ul primește nu doar procentul, ci și motivul:

```
Informații confirmate: telefon, email.
Informații probabile: program (Found on homepage only, no JSON-LD).
Informații nesigure: servicii (Only image prices found).
```

Asta îi permite AI-ului să fie mai precis în formulare:
- Telefon 100% → "Telefonul nostru este..."
- Program 62% → "Din informațiile disponibile, programul pare să fie..."
- Servicii 40% → "Vă recomand să confirmați telefonic prețul exact."

---

## Appointment Brain — configurabil de client

```javascript
companyData.appointmentRules = {
  // Override durate industry
  durations: {
    'consultație': 20,           // industry default: 30
    'albire profesională': 90,   // serviciu nou, nu există în industry
  },

  // Reguli adiționale
  rules: ['Nu programăm implanturi vinerea'],

  // Pauză custom
  breakBetween: 20,  // industry default: 15

  // Reguli per specialist (NOU)
  staffRules: {
    'Dr. Popescu': ['Doar implanturi', 'Doar Luni-Vineri'],
    'Dr. Ionescu': ['Doar ortodonție', 'Doar Marți-Joi'],
  },
};
```

Prompt-ul arată clar ce e default și ce e setat de client:
```
  consultație: 20 min (setat de client)
  detartraj: 45 min
```

---

## Learning Brain — recomandări, nu auto-modify

```javascript
const recs = generateRecommendations(learningData, feedbackData);

// Exemplu output:
// [
//   { type: 'add_information', priority: 'high', status: 'pending',
//     description: 'Clienții întreabă frecvent: "parking" — adaugă info.' },
//   { type: 'improve_quality', priority: 'critical',
//     description: 'Scorul mediu este 38/100. Verifică informațiile.' },
//   { type: 'reduce_redirects', priority: 'high',
//     description: '40% din conversații sunt redirecționate la telefon.' },
// ]

// Adminul aprobă/respinge din Dashboard
// Learning Brain NU modifică BrainBank singur
```

---

## Arhitectura completă

```
Scanner
     │
     ▼
Knowledge Sources (value + source + confidence + updatedBy + reason)
     │
     ▼
Company Brain (date client structurate)
     │
     ▼
Industry Brain (cunoștințe per industrie)
     │
     ▼
Retrieval Layer (trimite doar ce e relevant)
     │
     ▼
Confidence Brain (ton adaptat la încredere + motiv)
     │
     ▼
Conversation Brain (context din chat curent)
     │
     ▼
Business Rules Engine (logică deterministă)
     │
     ▼
Appointment Brain (reguli programări, configurabil)
     │
     ▼
Claude API (~1225 tokens system prompt)
     │
     ▼
Feedback Brain (scor, sentiment, lead, frustrare)
     │
     ▼
Learning Brain (recomandări → admin aprobă → BrainBank se actualizează)
```

---

## Statistici prompt

```
Full prompt (toate componentele):  ~1225 tokeni
Cu Retrieval activ:                ~830 tokeni (-32%)
Minimal (fără date):               ~443 tokeni
```

---

## Teste

```
132 teste · 12 categorii · 0 failed
```

Rulează: `node brainbank/test-brainbank.js`
