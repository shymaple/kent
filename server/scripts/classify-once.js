#!/usr/bin/env node
/**
 * Run one real classification through the local `claude` CLI and print the
 * parsed result. Proves the auth path works with no API key set.
 *
 *   node server/scripts/classify-once.js [fixtures/messages.json]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyBatch } from '../classify.js';

const file = process.argv[2] ?? 'fixtures/messages.json';
const candidates = JSON.parse(readFileSync(resolve(file), 'utf8'));
const timezone = process.env.MYBOT_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

if (process.env.ANTHROPIC_API_KEY) {
  console.warn('note: ANTHROPIC_API_KEY is set in this shell. Kent does not use it.');
}

console.log(`Classifying ${candidates.length} messages via the claude CLI (tz=${timezone})…\n`);
const started = Date.now();

const { verdicts, calls } = await classifyBatch(candidates, {
  model: process.env.MYBOT_MODEL,
  timezone,
});

console.log(`${calls} LLM call(s), ${Date.now() - started}ms\n`);
for (const c of candidates) {
  const v = verdicts.get(c.id);
  if (!v) {
    console.log(`  ${c.id}  (no verdict returned)`);
    continue;
  }
  if (!v.isTask) {
    console.log(`  ${c.id}  not a task`);
    continue;
  }
  console.log(
    `  ${c.id}  [${v.priority.padEnd(6)}] ${v.title}\n` +
      `        due=${v.dueDate ?? '-'}  category=${v.category}  confidence=${v.confidence}\n` +
      (v.description ? `        ${v.description}\n` : '')
  );
}
