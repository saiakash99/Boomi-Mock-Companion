'use strict';

// ============================================================
// Boomi Companion — knowledge/scenarios.json REPAIR + VALIDATION
//
// The shipping file was malformed: a pretty-printed 3-scenario array was
// concatenated (without its closing bracket) in front of a compact ~310-scenario
// array, so JSON.parse failed and the local scenario bank silently loaded as
// empty (the local fast-path tier was completely dead).
//
// This script:
//   1. Locates the second top-level array start and parses BOTH arrays.
//   2. Deduplicates by scenario id — the FIRST (richer) occurrence wins.
//   3. Validates the schema of every entry (id / keywords[] / answer / type).
//   4. Reports counts BEFORE and AFTER (nothing is lost silently).
//   5. With --write, writes the repaired single-array file.
//
// Usage:
//   node scripts/repair-scenarios.js            # dry run (report only)
//   node scripts/repair-scenarios.js --write    # write repaired file
// ============================================================

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'knowledge', 'scenarios.json');
const WRITE = process.argv.includes('--write');

// Find the index of the second top-level '[' (array #2 start). The first
// array never closes before it, so the stack holds exactly one '[' — and NO
// open object '{' — at the point array #2 begins. (Keywords arrays appear
// inside objects, i.e. while '{' is still on the stack, so they are skipped.)
function splitIndex(content) {
  const stack = [];
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '"') {
      i++;
      while (i < content.length) {
        if (content[i] === '\\') { i += 2; continue; }
        if (content[i] === '"') break;
        i++;
      }
      continue;
    }
    if (c === '[' || c === '{') {
      if (c === '[' && stack.length === 1 && stack[0] === '[') return i;
      stack.push(c);
    } else if (c === ']' || c === '}') {
      stack.pop();
    }
  }
  return -1;
}

function isValidEntry(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  if (typeof e.id !== 'string' || !e.id) return false;
  if (!Array.isArray(e.keywords) || !e.keywords.length) return false;
  if (typeof e.answer !== 'string' || !e.answer.trim()) return false;
  if (typeof e.type !== 'string' || !e.type) return false;
  if (!e.keywords.every(k => typeof k === 'string' && k.trim())) return false;
  return true;
}

function parseReport(label, text) {
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error(label + ' is not an array');
    const valid = arr.filter(isValidEntry);
    const invalid = arr.length - valid.length;
    return { label, total: arr.length, valid: valid.length, invalid, entries: valid };
  } catch (err) {
    throw new Error('Could not parse ' + label + ': ' + err.message);
  }
}

function main() {
  const content = fs.readFileSync(FILE, 'utf8');
  const idx = splitIndex(content);
  if (idx === -1) {
    console.error('Could not locate the second array — file may already be valid JSON.');
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        console.log('scenarios.json is ALREADY a single valid array (' + parsed.length + ' entries). Nothing to repair.');
      }
    } catch (_) {
      console.error('File is not valid JSON and the split heuristic failed. Aborting.');
      process.exit(1);
    }
    return;
  }

  const array1 = parseReport('array #1 (pretty block)', content.slice(0, idx) + ']');
  const array2 = parseReport('array #2 (compact block)', content.slice(idx));

  // Merge — first (richer) occurrence wins by id.
  const byId = new Map();
  const duplicates = [];
  for (const e of [...array1.entries, ...array2.entries]) {
    if (byId.has(e.id)) {
      duplicates.push({ id: e.id, keptFrom: byId.get(e.id).source, droppedFrom: e.source });
    } else {
      byId.set(e.id, e);
    }
  }

  const finalEntries = Array.from(byId.values());
  const invalid = array1.invalid + array2.invalid;

  console.log('=== scenarios.json repair report ===');
  console.log('Array #1 (pretty):  total=' + array1.total + ' valid=' + array1.valid + ' invalid=' + array1.invalid);
  console.log('Array #2 (compact): total=' + array2.total + ' valid=' + array2.valid + ' invalid=' + array2.invalid);
  console.log('Original total entries (both arrays): ' + (array1.total + array2.total));
  console.log('Duplicate ids removed (first occurrence wins): ' + duplicates.length);
  console.log('Invalid / malformed entries: ' + invalid);
  console.log('Final valid scenario count: ' + finalEntries.length);
  if (invalid > 0) {
    console.log('WARNING: ' + invalid + ' entries were dropped because they failed schema validation.');
  }
  if (duplicates.length > 0) {
    console.log('First few duplicates dropped: ' + duplicates.slice(0, 5).map(d => d.id).join(', ') + (duplicates.length > 5 ? ', ...' : ''));
  }

  if (WRITE) {
    const output = JSON.stringify(finalEntries, null, 2);
    fs.writeFileSync(FILE, output + '\n', 'utf8');
    console.log('WROTE repaired knowledge/scenarios.json with ' + finalEntries.length + ' entries.');
    const verify = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    console.log('VERIFIED: repaired file parses as a valid JSON array of ' + verify.length + ' entries.');
  } else {
    console.log('(dry run — pass --write to persist the repaired file)');
  }
}

main();