const {
  generateSystemPrompt, getIndustryBrain, buildCompanyBrain,
  wrapScannerData,
  createKnowledge, updateKnowledge, resolveValue, resolveConfidence, resolveReason,
  calculateGlobalConfidence, buildConfidenceInstructions,
  detectRelevantSections, filterCompanyData,
  buildConversationContext,
  evaluateBusinessRules, buildBusinessRulesContext, DEFAULT_RULES,
  buildAppointmentContext,
  analyzeConversation, updateFeedbackData,
  buildLearningContext, updateLearningData, generateRecommendations,
} = require('./brainbank');

let passed = 0, failed = 0;
const SEP = '\n' + '═'.repeat(60) + '\n';
function test(name, cond) {
  if (cond) { console.log(`  ✅ ${name}`); passed++; }
  else { console.log(`  ❌ ${name}`); failed++; }
}

// ── 1. Industry Brain ──
console.log(SEP + '1. INDUSTRY BRAIN' + SEP);
test('dental', getIndustryBrain('dental').industryKey === 'dental');
test('stomatologie', getIndustryBrain('stomatologie').industryKey === 'dental');
test('veterinar', getIndustryBrain('veterinar').industryKey === 'vet');
test('salon', getIndustryBrain('salon').industryKey === 'beauty');
test('fizioterapie', getIndustryBrain('fizioterapie').industryKey === 'physio');
test('clinica → medical', getIndustryBrain('clinica').industryKey === 'medical');
test('gym', getIndustryBrain('gym').industryKey === 'fitness');
test('restaurant', getIndustryBrain('restaurant').industryKey === 'horeca');
test('null → generic', getIndustryBrain(null).industryKey === 'generic');
test('"" → generic', getIndustryBrain('').industryKey === 'generic');
test('has systemContext', !!getIndustryBrain('dental').systemContext);
test('has neverSay', getIndustryBrain('dental').neverSay.length > 0);
test('has appointmentRules', !!getIndustryBrain('dental').appointmentRules);

// ── 2. Company Brain ──
console.log(SEP + '2. COMPANY BRAIN' + SEP);
const ct = buildCompanyBrain({
  name: 'Test', phone: '0722', hours: {'L-V':'9-18'},
  services: [{name:'A',price:'100 lei'}], staff: [{name:'Dr. X',role:'M'}],
  faq: [{q:'Q',a:'A'}], policies: {payment:'Card'},
});
test('name', ct.includes('Test'));
test('phone', ct.includes('0722'));
test('services', ct.includes('A'));
test('staff', ct.includes('Dr. X'));
test('faq', ct.includes('Q'));
test('policies', ct.includes('Card'));
test('null → empty', buildCompanyBrain(null) === '');
// Funcționează cu KnowledgeEntry
const ctK = buildCompanyBrain({ name: createKnowledge('KTest','scanner',90) });
test('KnowledgeEntry name', ctK.includes('KTest'));

// ── 3. Scanner Brain ──
console.log(SEP + '3. SCANNER BRAIN' + SEP);
const w = wrapScannerData({ phone:'0722', phone_source:'tel-link', email:'a@b.ro', email_confidence:95, name:'X', fieldConfidence:{name:88} });
test('phone value', w.phone.value === '0722');
test('phone source', w.phone.source === 'tel-link');
test('email confidence', w.email.confidence === 95);
test('name confidence', w.name.confidence === 88);
test('updatedBy=scanner', w.phone.updatedBy === 'scanner');

// ── 4. Knowledge Sources + Versioning ──
console.log(SEP + '4. KNOWLEDGE SOURCES + VERSIONING' + SEP);
const k1 = createKnowledge('L-V', 'scanner', 85, 'scanner', 'Found in JSON-LD');
test('value', k1.value === 'L-V');
test('source', k1.source === 'scanner');
test('confidence', k1.confidence === 85);
test('updatedBy', k1.updatedBy === 'scanner');
test('reason', k1.reason === 'Found in JSON-LD');
test('version 1', k1.version === 1);

const k2 = updateKnowledge(k1, 'L-S', 'manual', 100, 'user', 'Client confirmed');
test('new value', k2.value === 'L-S');
test('version 2', k2.version === 2);
test('updatedBy user', k2.updatedBy === 'user');
test('reason updated', k2.reason === 'Client confirmed');
test('history has old', k2.history.length === 1 && k2.history[0].value === 'L-V');
test('history has old reason', k2.history[0].reason === 'Found in JSON-LD');
test('history has old updatedBy', k2.history[0].updatedBy === 'scanner');

const k3 = updateKnowledge(k2, 'L-D', 'manual', 100, 'admin');
test('version 3', k3.version === 3);
test('history 2 entries', k3.history.length === 2);

test('resolveValue', resolveValue(k3) === 'L-D');
test('resolveValue plain', resolveValue('txt') === 'txt');
test('resolveConfidence', resolveConfidence(k2) === 100);
test('resolveReason', resolveReason(k1) === 'Found in JSON-LD');
test('resolveReason plain', resolveReason('x') === null);
test('clamp 150→100', createKnowledge('x','s',150).confidence === 100);
test('clamp -10→0', createKnowledge('x','s',-10).confidence === 0);

// History limit test
let kLimit = createKnowledge('v0','s',50);
for (let i = 1; i <= 25; i++) { kLimit = updateKnowledge(kLimit, `v${i}`, 's', 50); }
test('history max 20', kLimit.history.length === 20);
test('history oldest is v5', kLimit.history[0].value === 'v5');

// ── 5. Confidence Brain ──
console.log(SEP + '5. CONFIDENCE BRAIN (cu reason)' + SEP);
const cd = {
  phone: createKnowledge('0722','scanner',100,'scanner'),
  email: createKnowledge('a@b','scanner',95,'scanner'),
  hours: createKnowledge('L-V','scanner',62,'scanner','Found on homepage only, no JSON-LD'),
  services: createKnowledge([],'scanner',40,'scanner','Only image prices found'),
};
const gc = calculateGlobalConfidence(cd);
test('global confidence is number', typeof gc === 'number');
test('global confidence in range', gc >= 0 && gc <= 100);
const ci = buildConfidenceInstructions(cd);
test('has confirmed', ci.includes('confirmate'));
test('has reason for hours', ci.includes('Found on homepage only'));
test('has reason for services', ci.includes('image prices'));
test('has missing fields', ci.includes('lipsă'));
console.log(`  → ${ci.replace(/\n/g, '\n    ')}`);

// ── 6. Retrieval Layer ──
console.log(SEP + '6. RETRIEVAL LAYER' + SEP);
const r1 = detectRelevantSections('Cât costă?');
test('price → services', r1.has('services'));
test('price → prices', r1.has('prices'));
test('price → no location', !r1.has('location'));

const r2 = detectRelevantSections('Unde sunteți?');
test('location', r2.has('location'));

const r3 = detectRelevantSections('Vreau programare mâine');
test('appt → appointment', r3.has('appointment'));
test('appt → hours', r3.has('hours'));

const r4 = detectRelevantSections('Bună!');
test('greeting → fallback all', r4.size >= 4);

const r5 = detectRelevantSections('Plata cu cardul?');
test('payment → policies', r5.has('policies'));

const full = { name:'T', phone:'0722', email:'e', hours:{}, services:[{name:'A'}],
  staff:[{name:'D'}], faq:[{q:'Q',a:'A'}], policies:{parking:'Da'}, address:'Str' };
const fl = filterCompanyData(full, new Set(['identity','services']));
test('filtered has name', !!fl.name);
test('filtered has services', !!fl.services);
test('filtered no staff', !fl.staff);
test('filtered has phone (always)', !!fl.phone);

// ── 7. Conversation Brain ──
console.log(SEP + '7. CONVERSATION BRAIN' + SEP);
const cv = buildConversationContext([
  {role:'user',content:'Sunt Maria Ionescu'},
  {role:'assistant',content:'Bună!'},
  {role:'user',content:'Vreau un detartraj luni dimineața'},
  {role:'user',content:'0744 123 456'},
]);
test('name', cv.includes('maria ionescu'));
test('service', cv.includes('detartraj'));
test('day', cv.includes('luni'));
test('no repeat', cv.includes('NU repeta'));
test('empty → empty', buildConversationContext([]) === '');

// ── 8. Business Rules Engine ──
console.log(SEP + '8. BUSINESS RULES ENGINE (NOU)' + SEP);
test('dental has default rules', DEFAULT_RULES.dental.length >= 2);
test('vet has default rules', DEFAULT_RULES.vet.length >= 1);

// Test evaluare reguli
const br1 = evaluateBusinessRules('dental', [], { service: 'implant', hour: 15, isUrgency: false });
test('implant at 15:00 → blocked', br1.allowed === false);
test('implant message', br1.messages.some(m => m.includes('dimineața')));

const br2 = evaluateBusinessRules('dental', [], { service: 'implant', hour: 10, isUrgency: false });
test('implant at 10:00 → allowed', br2.allowed === true);

const br3 = evaluateBusinessRules('dental', [], { service: 'consultație', isUrgency: true });
test('urgency → prioritize message', br3.messages.some(m => m.includes('prioritate')));

// Custom rules
const customRules = [
  { id: 'no-friday-implant', type: 'schedule', condition: { field: 'dayOfWeek', operator: 'eq', value: 'vineri' },
    action: { type: 'block', message: 'Nu programăm implanturi vinerea.' }, active: true },
  { id: 'ortho-tuesday', type: 'staff', condition: { field: 'service', operator: 'eq', value: 'ortodonție' },
    action: { type: 'restrict_time', message: 'Ortodonția doar marți.', allowedHours: [8,9,10,11,12,13,14,15,16] }, active: true },
  { id: 'inactive-rule', type: 'custom', condition: { field: 'x', operator: 'eq', value: 'y' },
    action: { type: 'block', message: 'Should not appear' }, active: false },
];

const br4 = evaluateBusinessRules('dental', customRules, { dayOfWeek: 'vineri' });
test('custom rule: no friday → blocked', br4.allowed === false);
test('custom rule: message', br4.messages.some(m => m.includes('vinerea')));

const br5 = evaluateBusinessRules('dental', customRules, { dayOfWeek: 'luni' });
test('custom rule: monday → not blocked', br5.allowed === true);

const br6 = evaluateBusinessRules('dental', customRules, { service: 'ortodonție', hour: 20 });
test('ortho at 20:00 → blocked', br6.allowed === false);

// Inactive rule should not fire
const br7 = evaluateBusinessRules('dental', [customRules[2]], { x: 'y' });
test('inactive rule ignored', br7.appliedRules.length === 0);

// Business rules context
const brc = buildBusinessRulesContext('dental', customRules);
test('context has rules', brc.includes('REGULI DE BUSINESS'));
test('context has custom', brc.includes('vinerea'));
test('context no inactive', !brc.includes('Should not appear'));

// ── 9. Appointment Brain (configurabil) ──
console.log(SEP + '9. APPOINTMENT BRAIN (configurabil)' + SEP);
const apt = buildAppointmentContext('dental', {
  appointmentRules: {
    durations: { 'consultație': 20, 'albire profesională': 90 },
    rules: ['Nu vinerea'],
    breakBetween: 20,
    staffRules: { 'Dr. Popescu': ['Doar implanturi','Doar L-V'] },
  },
});
test('industry durations', apt.includes('detartraj: 45 min'));
test('client override', apt.includes('consultație: 20 min'));
test('override marked', apt.includes('setat de client'));
test('new service added', apt.includes('albire profesională: 90 min'));
test('client rules', apt.includes('Nu vinerea'));
test('staff rules', apt.includes('Dr. Popescu'));
test('staff rule content', apt.includes('Doar implanturi'));
test('custom break', apt.includes('20 min'));
test('unknown → empty', buildAppointmentContext('xyz',{}) === '');

// ── 10. Feedback Brain ──
console.log(SEP + '10. FEEDBACK BRAIN' + SEP);
const c1 = [{role:'user',content:'Cât costă?'},{role:'assistant',content:'200 lei.'},
  {role:'user',content:'Mulțumesc! Sunt Ana Pop, 0744 555 666.'},{role:'assistant',content:'Notat!'}];
const a1 = analyzeConversation(c1);
test('questions detected', a1.questionsAsked.length > 0);
test('answered', a1.questionsAnswered.length > 0);
test('lead', a1.leadCollected === true);
test('positive', a1.sentiment === 'positive');
test('score > 50', a1.score > 50);

const c2 = [{role:'user',content:'Program?'},{role:'assistant',content:'Nu dețin informații.'},
  {role:'user',content:'Nu ești util...'},{role:'assistant',content:'Sunați la cabinet.'}];
const a2 = analyzeConversation(c2);
test('frustration', a2.clientGotFrustrated);
test('dont know', a2.aiSaidDontKnow);
test('redirect', a2.redirectedToPhone);
test('negative', a2.sentiment === 'negative');
test('score < 30', a2.score < 30);

let fb = null; fb = updateFeedbackData(fb,a1); fb = updateFeedbackData(fb,a2);
test('2 conversations', fb.totalConversations === 2);
test('1 lead', fb.leadsCollected === 1);
test('1 frustration', fb.frustrationCount === 1);
test('avg score', fb.averageScore > 0);

// ── 11. Learning Brain (recomandări) ──
console.log(SEP + '11. LEARNING BRAIN + RECOMANDĂRI' + SEP);
let lr = null; lr = updateLearningData(lr,a1); lr = updateLearningData(lr,a2);
test('conversations tracked', lr.stats.totalConversations === 2);
test('top questions', lr.topQuestions.length > 0);
test('missing fields', lr.missingFields.length > 0);
test('has pendingRecommendations array', Array.isArray(lr.pendingRecommendations));

const lctx = buildLearningContext(lr);
test('context has questions', lctx.includes('frecvente'));

// Generare recomandări (NU auto-apply)
const recs = generateRecommendations(lr, fb);
test('has recommendations', recs.length > 0);
test('recs are pending', recs.every(r => r.status === 'pending'));
test('recs have type', recs.every(r => !!r.type));
test('recs have description', recs.every(r => !!r.description));
test('has add_information rec', recs.some(r => r.type === 'add_information'));
console.log(`  → ${recs.length} recomandări generate:`);
recs.forEach(r => console.log(`    [${r.priority}] ${r.type}: ${r.description.slice(0,60)}...`));

// ── 12. System Prompt Complet ──
console.log(SEP + '12. SYSTEM PROMPT (toate 11 componentele)' + SEP);
const prompt = generateSystemPrompt({
  industry: 'dental',
  companyData: {
    name: 'Clinica DP', industry: 'dental',
    phone: createKnowledge('0722','scanner',100,'scanner'),
    email: createKnowledge('a@b.ro','scanner',95,'scanner'),
    hours: createKnowledge({'L-V':'09-19'},'manual',100,'user','Client confirmed'),
    services: [{name:'Consultație',price:'150 lei'},{name:'Detartraj',price:'200 lei'}],
    faq: [{q:'Card?',a:'Da.'}],
    appointmentRules: { durations: {consultație:20}, staffRules: {'Dr.P':['Doar implanturi']} },
  },
  conversationHistory: [
    {role:'user',content:'Sunt Ana, vreau detartraj'},
    {role:'assistant',content:'Ce zi preferați?'},
    {role:'user',content:'Joi dimineața'},
  ],
  learningData: lr,
  includeAppointments: true,
  userMessage: 'Joi dimineața',
  businessRules: [{id:'no-fri',type:'schedule',condition:{field:'day',operator:'eq',value:'fri'},
    action:{type:'block',message:'Nu vinerea.'},active:true}],
});

test('has identity', prompt.includes('recepționistul AI'));
test('has industry', prompt.includes('CUNOȘTINȚE INDUSTRIE'));
test('has company', prompt.includes('INFORMAȚII AFACERE'));
test('has confidence', prompt.includes('NIVEL ÎNCREDERE'));
test('has business rules', prompt.includes('REGULI DE BUSINESS'));
test('has learning', prompt.includes('CUNOȘTINȚE ACUMULATE'));
test('has conversation', prompt.includes('CONTEXT CONVERSAȚIE'));
test('has appointments', prompt.includes('PROGRAMĂRI'));
test('has staff rules', prompt.includes('Dr.P'));
test('has general rules', prompt.includes('REGULI GENERALE'));
test('has BR instruction', prompt.includes('Respectă regulile de business'));

const lines = prompt.split('\n');
console.log(`\n  Prompt: ${lines.length} linii · ${prompt.length} chars · ~${Math.round(prompt.length/3.5)} tokens`);

// ══ REZULTAT ══
console.log(SEP);
console.log(`REZULTAT: ${passed} passed, ${failed} failed`);
if (failed === 0) console.log('✅ TOATE TESTELE AU TRECUT');
else console.log('❌ SUNT TESTE CARE NU AU TRECUT');
console.log(SEP);
