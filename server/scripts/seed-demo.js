#!/usr/bin/env node
/**
 * Seed the database with fake inbox items and tasks so the UI can be exercised
 * without a live Slack workspace. Intended for local verification only.
 *
 *   MYBOT_DB=/tmp/demo.db node server/scripts/seed-demo.js
 */
import { db, setSetting } from '../db.js';

setSetting('slack_user_id', 'U0ME');
setSetting('aliases', JSON.stringify(['Alex', 'al']));

db.prepare(
  `INSERT OR IGNORE INTO channels (id, name, kind, is_member) VALUES
   ('C1','design','channel',1), ('C2','general','channel',1), ('C3','eng','channel',1),
   ('D1','@Alex','im',1)`
).run();

db.prepare(
  `INSERT OR IGNORE INTO people (slack_user_id, display_name, real_name, is_priority) VALUES
   ('U1','Alex','Alex Nair',1), ('U2','Jordan','Jordan Lee',0), ('U3','Dana','Dana Cruz',0)`
).run();

const inbox = db.prepare(`
  INSERT OR IGNORE INTO inbox_items
    (title, description, priority, due_date, category, is_broadcast, reason, confidence,
     channel_id, channel_name, message_ts, permalink, assigner_id, assigner_name, links, source_text)
  VALUES (@title,@description,@priority,@due,@category,@bc,@reason,@conf,
          @cid,@cname,@ts,@link,@aid,@aname,@links,@src)
`);

inbox.run({
  title: 'Review onboarding copy', description: 'Alex needs feedback before the Thursday sync.',
  priority: 'high', due: '2026-08-07', category: 'review', bc: 0, reason: 'mention', conf: 0.9,
  cid: 'C1', cname: 'design', ts: '1754380800.000100',
  link: 'https://example.slack.com/archives/C1/p1754380800000100',
  aid: 'U1', aname: 'Alex',
  links: JSON.stringify([{ url: 'https://docs.google.com/document/d/abc', label: 'Onboarding copy' }]),
  src: '<@U0ME> can you review the onboarding copy before the Thursday sync? doc here',
});

inbox.run({
  title: 'Fill office snack preference form', description: 'Channel-wide request, due end of month.',
  priority: 'low', due: '2026-08-31', category: 'broadcast', bc: 1, reason: 'broadcast', conf: 0.6,
  cid: 'C2', cname: 'general', ts: '1754384400.000200',
  link: 'https://example.slack.com/archives/C2/p1754384400000200',
  aid: 'U2', aname: 'Jordan', links: '[]',
  src: '<!channel> please fill the office snack preference form by end of month',
});

inbox.run({
  title: 'Send the quarterly report', description: 'Dana typed your name rather than mentioning you.',
  priority: 'medium', due: null, category: 'admin', bc: 0, reason: 'alias', conf: 0.45,
  cid: 'C3', cname: 'eng', ts: '1754388000.000300',
  link: 'https://example.slack.com/archives/C3/p1754388000000300',
  aid: 'U3', aname: 'Dana', links: '[]',
  src: 'Alex can you send across the the quarterly report when you get a sec',
});

const task = db.prepare(`
  INSERT INTO tasks (title, description, status, priority, due_date, category, is_broadcast,
                     channel_name, assigner_name, permalink, links, position)
  VALUES (@title,@desc,@status,@priority,@due,@category,@bc,@chan,@from,@link,@links,1)
`);

task.run({
  title: 'Fix prod checkout 500s', desc: 'Blocking the release.', status: 'in_progress',
  priority: 'high', due: '2026-08-04', category: 'bug', bc: 0, chan: 'eng', from: 'Dana',
  link: 'https://example.slack.com/archives/C3/p1', links: '[]',
});
task.run({
  title: 'Update the API changelog', desc: null, status: 'in_review', priority: 'medium',
  due: '2026-08-08', category: 'doc', bc: 0, chan: 'eng', from: 'Sam',
  link: 'https://example.slack.com/archives/C3/p2', links: '[]',
});
task.run({
  title: 'Book the offsite venue', desc: null, status: 'open', priority: 'low', due: null,
  category: 'admin', bc: 0, chan: 'general', from: 'Jordan', link: null, links: '[]',
});
task.run({
  title: 'Complete the security training', desc: 'Everyone in the company.', status: 'open',
  priority: 'low', due: '2026-08-20', category: 'broadcast', bc: 1, chan: 'general', from: 'HR Bot',
  link: 'https://example.slack.com/archives/C2/p3', links: '[]',
});

console.log('Seeded demo data.');
