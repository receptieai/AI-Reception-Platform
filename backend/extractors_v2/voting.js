'use strict';

// ── Multi-Detector Voting Engine ─────────────────────────────────────
// Each field may be found by several independent detectors
// (tel-link, JSON-LD, footer regex, header regex, label...).
// Instead of "first detector wins", every detector votes.
//
// voteFields(candidates):
//   candidates = [{ value, confidence, source, method }]
//   -> groups candidates by NORMALISED value
//   -> base score = max confidence in the group
//   -> corroboration bonus: each DISTINCT source that agrees adds a bonus
//      (two independent detectors finding the same phone is stronger
//       than one detector with high confidence)
//   -> returns the winning group as a field with an extra `votes` array
//      so the UI / explainability layer can show WHY it won.
//
// This is exactly the plan's:
//   tel link      99%
//   JSON-LD       95%
//   footer regex  80%
//     -> aggregate weighted confidence

// Optional per-source weight (relative trust). Defaults to 1.
const SOURCE_WEIGHTS = {
  json_ld: 1.2,      // structured, machine-declared — most trusted
  tel_link: 1.1,     // explicit tel: href
  mailto_link: 1.1,
  label_text: 1.0,
  regex: 0.9,        // raw text regex — weaker
  text_lines: 0.8,
  bare_range: 0.7,
};

function voteFields(candidates) {
  const valid = (candidates || []).filter(c => c && c.value !== null && c.value !== undefined && c.value !== '');
  if (valid.length === 0) {
    return { value: null, confidence: 0, source: 'none', votes: [], corroboration: 0 };
  }

  // Group by normalised value.
  const groups = new Map();
  for (const c of valid) {
    const key = normalizeKey(c.value, c.source);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  let best = null;
  for (const [key, members] of groups.entries()) {
    const base = Math.max(...members.map(m => m.confidence || 0));
    const distinctSources = [...new Set(members.map(m => m.source))];

    // Weighted corroboration: sum of source weights beyond the first,
    // each capped, then capped overall at +20.
    let bonus = 0;
    for (const s of distinctSources) {
      bonus += (SOURCE_WEIGHTS[s] !== undefined ? SOURCE_WEIGHTS[s] : 0.9) * 6;
    }
    bonus = Math.min(bonus, 20);

    // Prefer the group whose best member has the highest source weight
    // on ties (so JSON-LD beats regex at equal confidence).
    const bestMember = members.reduce((a, b) => {
      const wa = (SOURCE_WEIGHTS[a.source] || 0.9) * 100 + (a.confidence || 0);
      const wb = (SOURCE_WEIGHTS[b.source] || 0.9) * 100 + (b.confidence || 0);
      return wb > wa ? b : a;
    }, members[0]);

    const confidence = Math.min(100, Math.round(base + bonus));
    const result = {
      value: bestMember.value,
      confidence,
      source: bestMember.source,
      method: bestMember.method,
      page: bestMember.page,
      votes: members.map(m => ({ value: m.value, confidence: m.confidence, source: m.source, method: m.method })),
      corroboration: distinctSources.length,
      _key: key,
    };

    if (!best || result.confidence > best.confidence) best = result;
  }

  return best;
}

function normalizeKey(value, source) {
  let v = String(value);
  if (source === 'tel_link' || source === 'json_ld') {
    // For phones coming from structured/tel sources, strip separators.
    v = v.replace(/[\s.\-()]/g, '').toLowerCase();
  } else {
    v = v.trim().toLowerCase();
  }
  return v;
}

module.exports = { voteFields, SOURCE_WEIGHTS };
