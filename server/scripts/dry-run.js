#!/usr/bin/env node
/**
 * Dry-run the whole pipeline against one real channel and print what WOULD be
 * created. Touches Slack read-only and never writes to the database.
 *
 *   node server/scripts/dry-run.js ms-marketing-testing [days]
 *   node server/scripts/dry-run.js C0123ABCDEF 3
 */
import { getAliases, getSetting } from '../db.js';
import { hasSlackToken } from '../secrets.js';
import * as slack from '../slack.js';
import { buildAliasMatcher, classifyCandidate } from '../prefilter.js';
import { classifyBatch } from '../classify.js';
import { enrich } from '../enrich.js';

const target = process.argv[2];
const days = Number(process.argv[3] ?? 7);

if (!target) {
  console.error('usage: node server/scripts/dry-run.js <#channel-name|CHANNELID> [days]');
  process.exit(1);
}
if (!hasSlackToken()) {
  console.error('No Slack token stored. Connect Slack in Settings first.');
  process.exit(1);
}

const me = await slack.authTest();
const myUserId = getSetting('slack_user_id_override')?.trim() || me.userId;
const aliases = getAliases();
const timezone = getSetting('timezone');

// Resolve a channel name to an id if needed.
let channel;
if (/^[CDG][A-Z0-9]+$/.test(target)) {
  const all = await slack.listMyConversations();
  channel = all.find((c) => c.id === target) ?? { id: target, name: target, kind: 'channel' };
} else {
  const wanted = target.replace(/^#/, '').toLowerCase();
  const all = await slack.listMyConversations();
  channel = all.find((c) => c.name.toLowerCase() === wanted);
  if (!channel) {
    console.error(`No conversation named "${target}" that you're a member of.`);
    process.exit(1);
  }
}

console.log(`\nYou:       ${me.user} (${myUserId})`);
console.log(`Channel:   ${channel.name} (${channel.id}, ${channel.kind})`);
console.log(`Aliases:   ${aliases.length ? aliases.join(', ') : '(none configured)'}`);
console.log(`Window:    last ${days} day(s)\n`);

const oldest = slack.dateToTs(new Date(Date.now() - days * 86_400_000));
const messages = await slack.fetchHistory(channel.id, { oldest });
console.log(`Fetched ${messages.length} message(s).\n`);

// Threads I posted in, so replies to me are caught the same way sync does it.
const myThreadTs = new Set();
for (const m of messages) if (m.user === myUserId) myThreadTs.add(m.thread_ts ?? m.ts);

const aliasMatcher = buildAliasMatcher(aliases);
const candidates = [];
const skipped = [];

for (const m of messages) {
  const hit = classifyCandidate(m, { myUserId, channelKind: channel.kind, aliasMatcher, myThreadTs });
  if (hit) candidates.push({ m, hit });
  else skipped.push(m);
}

console.log(`Prefilter: ${candidates.length} candidate(s), ${skipped.length} ignored (no LLM cost).\n`);

if (skipped.length) {
  console.log('Ignored:');
  for (const m of skipped.slice(0, 12)) {
    console.log(`  · ${(m.text ?? '').replace(/\n/g, ' ').slice(0, 90)}`);
  }
  if (skipped.length > 12) console.log(`  … and ${skipped.length - 12} more`);
  console.log();
}

if (!candidates.length) {
  console.log('Nothing addressed to you in this window — zero LLM calls made.\n');
  process.exit(0);
}

console.log('Candidates going to the model:');
for (const { m, hit } of candidates) {
  console.log(`  [${hit.reason}] ${(m.text ?? '').replace(/\n/g, ' ').slice(0, 100)}`);
}

const users = await slack.listUsers();
const names = new Map(users.map((u) => [u.id, u.displayName]));

const payload = candidates.map(({ m, hit }) => ({
  id: `${channel.id}:${m.ts}`,
  channel: channel.name,
  from: names.get(m.user) ?? m.user,
  sentAt: slack.tsToDate(m.ts).toISOString(),
  text: m.text,
  isBroadcast: hit.isBroadcast,
}));

console.log(`\nCalling the model once with ${payload.length} message(s)…\n`);
const started = Date.now();
const { verdicts, calls } = await classifyBatch(payload, { model: getSetting('model'), timezone });
console.log(`${calls} LLM call, ${Date.now() - started}ms\n`);
console.log('─'.repeat(72));

for (const { m, hit } of candidates) {
  const id = `${channel.id}:${m.ts}`;
  const verdict = verdicts.get(id);

  if (verdict && !verdict.isTask) {
    console.log(`\n✗ NOT A TASK  ${(m.text ?? '').replace(/\n/g, ' ').slice(0, 70)}`);
    continue;
  }

  const card = enrich(
    {
      text: m.text,
      files: m.files,
      attachments: m.attachments,
      sentAt: slack.tsToDate(m.ts),
      reason: hit.reason,
      isBroadcast: hit.isBroadcast,
      assignerName: names.get(m.user) ?? m.user,
    },
    verdict,
    { timezone }
  );

  console.log(`\n✓ ${card.title}`);
  if (card.description) console.log(`   ${card.description}`);
  console.log(
    `   priority=${card.priority}  due=${card.dueDate ?? '-'}  category=${card.category}` +
      `  caught-by=${card.reason}${card.isBroadcast ? '  → MISCELLANEOUS' : ''}`
  );
  console.log(`   from ${names.get(m.user) ?? m.user}  ·  confidence ${card.confidence}`);
  for (const l of card.links) console.log(`   link: ${l.label} → ${l.url}`);
}

console.log(`\n${'─'.repeat(72)}\nDry run only — nothing was written to the board.\n`);
