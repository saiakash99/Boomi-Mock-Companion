'use strict';
// RAG Database Data Repair
// ------------------------
// Replaces scenario `answer` text in knowledge/scenarios.json with the rich
// technical definitions stored in boomi-glossary.json whenever a scenario
// keyword set identifies a glossary term.
//
// The scenario schema uses `answer` (not `model_answer`) and a `keywords`
// array (not a singular `keyword` field). A glossary key is a candidate when
// every word of the key appears among the scenario keywords (case-insensitive);
// the LONGEST such key wins so a multi-word term ("process property") is
// preferred over its single-word parent ("process"). If only single-word keys
// match, the earliest keyword in the array breaks the tie (keywords are
// ordered by relevance).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCENARIOS_PATH = path.join(ROOT, 'knowledge', 'scenarios.json');
const GLOSSARY_PATH = path.join(ROOT, 'boomi-glossary.json');

const scenarios = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
const glossary = JSON.parse(fs.readFileSync(GLOSSARY_PATH, 'utf8'));

// Pre-split every glossary key into its constituent words, lowercased.
const glossaryTerms = Object.keys(glossary).map((key) => ({
  key,
  words: key.toLowerCase().split(/\s+/).filter(Boolean),
}));

function bestGlossaryKey(keywords) {
  const kw = (keywords || []).map((k) => String(k).toLowerCase());
  const kwSet = new Set(kw);
  let best = null;
  let bestScore = -1;
  for (const term of glossaryTerms) {
    if (term.words.some((w) => !kwSet.has(w))) continue;
    // Prefer more words (more specific), then the word earliest in the keyword
    // order, then a longer key.
    const firstWord = Math.min(...term.words.map((w) => kw.indexOf(w)));
    const score = term.words.length * 1000 - firstWord;
    if (score > bestScore) {
      best = term.key;
      bestScore = score;
    }
  }
  return best;
}

let updated = 0;
const missing = [];

for (const scenario of scenarios) {
  const matchKey = bestGlossaryKey(scenario.keywords);
  if (!matchKey) {
    missing.push(scenario.id);
    continue;
  }
  const definition = glossary[matchKey];
  if (typeof definition !== 'string' || definition.trim() === '') {
    missing.push(scenario.id);
    continue;
  }
  scenario.answer = definition;
  updated++;
}

fs.writeFileSync(SCENARIOS_PATH, JSON.stringify(scenarios, null, 2) + '\n', 'utf8');

console.log('RAG data repair complete.');
console.log('Scenarios total:      ' + scenarios.length);
console.log('Records updated:      ' + updated);
console.log('No glossary match:    ' + missing.length);

if (missing.length) {
  console.log('Scenarios left untouched (no keyword in glossary): ' + missing.slice(0, 12).join(', ') + (missing.length > 12 ? '…' : ''));
}

// Sample audit of what changed.
const BACKUP_PATH = 'C:\\Users\\Bhanu\\AppData\\Local\\Temp\\opencode\\scenarios.json.backup';
const before = fs.existsSync(BACKUP_PATH) ? JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8')) : null;
if (before) {
  const after = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  const changed = before.filter((b, i) => b.answer !== (after[i] && after[i].answer));
  console.log('Sample updates:');
  for (const s of changed.slice(0, 5)) {
    console.log('  [' + s.id + ']');
    console.log('    keywords: ' + JSON.stringify(s.keywords));
    console.log('    before: ' + s.answer.slice(0, 100) + '…');
    const now = after.find((x) => x.id === s.id);
    console.log('    after:  ' + now.answer.slice(0, 100) + '…');
  }
}