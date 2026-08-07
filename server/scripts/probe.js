#!/usr/bin/env node
/**
 * Verify the Slack token and scopes before anything else.
 *
 *   node server/scripts/probe.js            # identity + channel list
 *   node server/scripts/probe.js C0123ABC   # + last 20 messages in that channel
 */
import * as slack from '../slack.js';
import { hasSlackToken } from '../secrets.js';

if (!hasSlackToken()) {
  console.error('No Slack token stored. Set one in the app Settings, or export SLACK_USER_TOKEN.');
  process.exit(1);
}

const me = await slack.authTest();
console.log(`Authenticated as ${me.user} (${me.userId}) in ${me.team} — ${me.url}\n`);

const conversations = await slack.listMyConversations();
const byKind = conversations.reduce((acc, c) => {
  (acc[c.kind] ??= []).push(c);
  return acc;
}, {});

for (const [kind, list] of Object.entries(byKind)) {
  console.log(`${kind} (${list.length}):`);
  for (const c of list.slice(0, 25)) console.log(`  ${c.id}  ${c.name}`);
  if (list.length > 25) console.log(`  … and ${list.length - 25} more`);
  console.log();
}

const target = process.argv[2];
if (target) {
  const oldest = slack.dateToTs(new Date(Date.now() - 7 * 86_400_000));
  const messages = await slack.fetchHistory(target, { oldest, limit: 20, maxPages: 1 });
  console.log(`Last ${messages.length} messages in ${target} (7 days):\n`);
  for (const m of messages.slice(-20)) {
    const when = slack.tsToDate(m.ts).toISOString().replace('T', ' ').slice(0, 16);
    console.log(`  [${when}] ${m.user ?? m.bot_id}: ${(m.text ?? '').replace(/\n/g, ' ').slice(0, 110)}`);
  }
}
