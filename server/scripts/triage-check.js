#!/usr/bin/env node
/**
 * Score the classification prompt against labelled fixtures.
 *
 * Ids beginning with "t" are expected to be tasks, "n" to be rejected. Run this
 * after any edit to prompts/classify.md or the strictness setting.
 *
 *   node server/scripts/triage-check.js [fixtures/triage-bar.json]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyBatch } from '../classify.js';
import { getSetting } from '../db.js';

const file = process.argv[2] ?? 'fixtures/triage-bar.json';
const batch = JSON.parse(readFileSync(resolve(file), 'utf8'));
const minConfidence = Number(getSetting('min_confidence'));
const timezone = getSetting('timezone');

console.log(`\n${batch.length} labelled messages · strictness ${minConfidence} · ${timezone}\n`);

const started = Date.now();
const { verdicts } = await classifyBatch(batch, { model: getSetting('model'), timezone });

let correct = 0;
const misses = [];

for (const m of batch) {
  const v = verdicts.get(m.id);
  const expected = m.id.startsWith('t');
  const actual = v ? v.isTask && v.confidence >= minConfidence : false;
  const ok = expected === actual;
  if (ok) correct++;
  else misses.push({ m, v, expected });

  console.log(
    `${ok ? '  ✓' : '  ✗'} [${actual ? 'TASK' : 'skip'}] ${String(v?.confidence ?? '-').padEnd(5)} ${m.text.slice(0, 60)}`
  );
  if (actual) console.log(`         → ${v.title}  due=${v.dueDate ?? '-'}  ${v.priority}`);
}

console.log(`\n${correct}/${batch.length} correct in ${Date.now() - started}ms`);

if (misses.length) {
  console.log('\nMisclassified:');
  for (const { m, v, expected } of misses) {
    console.log(`  ${m.id}  expected ${expected ? 'TASK' : 'skip'}, got confidence ${v?.confidence ?? 'none'}`);
    console.log(`     ${m.text}`);
  }
  process.exit(1);
}
