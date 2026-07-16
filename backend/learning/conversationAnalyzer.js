'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const CONVS_FILE = path.join(DATA_DIR, 'conversations.json');
const GAPS_FILE = path.join(DATA_DIR, 'knowledge_gaps.json');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── LOAD / SAVE ────────────────────────────
function loadConversations() {
  try { return JSON.parse(fs.readFileSync(CONVS_FILE, 'utf8')); } catch(e) { return []; }
}

function loadGaps() {
  try { return JSON.parse(fs.readFileSync(GAPS_FILE, 'utf8')); } catch(e) { return {}; }
}

function saveGaps(gaps) {
  fs.writeFileSync(GAPS_FILE, JSON.stringify(gaps, null, 2));
}

// ── QUESTION EXTRACTOR ─────────────────────
const QUESTION_CATEGORIES = {
  pricing: ['cât costă','cât este','preț','tarif','cost','lei','ron','cât face'],
  booking: ['programare','programez','rezervare','când','disponibil','liber','slot'],
  hours: ['program','orar','deschis','închis','ore','când sunteți','luni','vineri'],
  location: ['unde','adresă','locație','parcare','cum ajung','hartă'],
  services: ['faceți','oferiți','aveți','servicii','tratament','proceduri'],
  doctors: ['doctor','medic','specialist','cu cine','dr.'],
  emergency: ['urgență','urgent','acum','durere','ajutor'],
  insurance: ['asigurare','cas','cnas','decontat','card'],
  duration: ['cât durează','durata','timp','minute','ore'],
  payment: ['card','numerar','cash','rate','plată'],
};

function categorizeQuestion(text) {
  const lower = text.toLowerCase();
  for (const [cat, keywords] of Object.entries(QUESTION_CATEGORIES)) {
    if (keywords.some(kw => lower.includes(kw))) return cat;
  }
  return 'other';
}

function isQuestion(text) {
  return text.includes('?') || 
    /^(?:cât|cum|când|unde|ce|care|dacă|aveți|faceți|puteți|există)/i.test(text.trim());
}

function wasAnswered(aiResponse) {
  const lower = aiResponse.toLowerCase();
  const notAnswered = [
    'nu știu', 'nu am informații', 'vă rog sunați', 'contactați direct',
    'nu pot', 'nu știu să', 'nu am date', 'nu dețin informații',
    'nu dispun', 'nu știm', 'sunați la', 'vă rugăm să sunați',
    'contactați-ne direct', 'nu avem date', 'pentru detalii sunați',
  ];
  return !notAnswered.some(phrase => lower.includes(phrase));
}

// ── SAVE CONVERSATION ──────────────────────
function saveConversation(messages, businessProfile, aiResponse) {
  try {
    const conversations = loadConversations();
    
    // Extract user questions from this conversation
    const userMessages = messages.filter(m => m.role === 'user');
    const questions = userMessages
      .filter(m => isQuestion(m.content))
      .map(m => ({
        text: m.content,
        category: categorizeQuestion(m.content),
        answered: wasAnswered(aiResponse),
      }));

    const conv = {
      id: 'conv_' + Date.now(),
      businessId: businessProfile.clientId || businessProfile.domain || 'unknown',
      businessName: businessProfile.name || 'Unknown',
      industry: businessProfile.type || 'general',
      timestamp: new Date().toISOString(),
      messageCount: messages.length,
      questions,
      hasLead: aiResponse.includes('[LEAD_READY]'),
      sentiment: detectSentiment(messages),
    };

    conversations.push(conv);
    
    // Keep last 10000 conversations
    const toSave = conversations.slice(-10000);
    fs.writeFileSync(CONVS_FILE, JSON.stringify(toSave, null, 2));

    // Update knowledge gaps
    updateKnowledgeGaps(questions, businessProfile);

    return conv;
  } catch(e) {
    console.error('[LEARNING] Save error:', e.message);
    return null;
  }
}

// ── UPDATE KNOWLEDGE GAPS ──────────────────
function updateKnowledgeGaps(questions, businessProfile) {
  const gaps = loadGaps();
  const industry = businessProfile.type || 'general';

  questions.forEach(q => {
    if (q.answered) return; // Only track unanswered
    
    const key = q.category + ':' + normalizeQuestion(q.text);
    if (!gaps[key]) {
      gaps[key] = {
        question: q.text,
        category: q.category,
        industry,
        count: 0,
        businesses: [],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        status: 'open', // open | answered | ignored
        globalAnswer: null,
      };
    }
    gaps[key].count++;
    gaps[key].lastSeen = new Date().toISOString();
    if (!gaps[key].businesses.includes(businessProfile.name)) {
      gaps[key].businesses.push(businessProfile.name);
    }
  });

  saveGaps(gaps);
}

function normalizeQuestion(text) {
  return text.toLowerCase()
    .replace(/[?!.,;]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 60);
}

function detectSentiment(messages) {
  const text = messages.map(m => m.content).join(' ').toLowerCase();
  const positive = ['mulțumesc','perfect','excelent','minunat','super','ok','da','bine'];
  const negative = ['nu','problema','rau','prost','nemulțumit','dezamăgit'];
  const posCount = positive.filter(w => text.includes(w)).length;
  const negCount = negative.filter(w => text.includes(w)).length;
  if (posCount > negCount) return 'positive';
  if (negCount > posCount) return 'negative';
  return 'neutral';
}

// ── GET ANALYTICS ──────────────────────────
function getAnalytics(industry = null) {
  const conversations = loadConversations();
  const gaps = loadGaps();

  const filtered = industry 
    ? conversations.filter(c => c.industry === industry)
    : conversations;

  // Top questions by category
  const categoryCounts = {};
  filtered.forEach(c => {
    c.questions?.forEach(q => {
      categoryCounts[q.category] = (categoryCounts[q.category] || 0) + 1;
    });
  });

  // Top gaps
  const topGaps = Object.entries(gaps)
    .filter(([k, v]) => v.status === 'open')
    .sort(([,a], [,b]) => b.count - a.count)
    .slice(0, 20)
    .map(([key, gap]) => gap);

  // Lead rate
  const leadRate = filtered.length > 0
    ? Math.round(filtered.filter(c => c.hasLead).length / filtered.length * 100)
    : 0;

  return {
    totalConversations: filtered.length,
    totalQuestions: filtered.reduce((a, c) => a + (c.questions?.length || 0), 0),
    leadRate,
    topCategories: Object.entries(categoryCounts).sort((a,b)=>b[1]-a[1]).slice(0,5),
    topGaps,
    sentimentBreakdown: {
      positive: filtered.filter(c => c.sentiment === 'positive').length,
      neutral: filtered.filter(c => c.sentiment === 'neutral').length,
      negative: filtered.filter(c => c.sentiment === 'negative').length,
    },
  };
}

function addGlobalAnswer(gapKey, answer) {
  const gaps = loadGaps();
  if (gaps[gapKey]) {
    gaps[gapKey].globalAnswer = answer;
    gaps[gapKey].status = 'answered';
    gaps[gapKey].answeredAt = new Date().toISOString();
    saveGaps(gaps);
    return true;
  }
  return false;
}

module.exports = { saveConversation, getAnalytics, addGlobalAnswer, loadGaps };
