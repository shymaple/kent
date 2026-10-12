/**
 * Catch-up policy for background syncing.
 *
 * The behaviour under test is what happens after a laptop has been shut for a
 * few days: Slack hands back history a page at a time, so one pass is never
 * enough, and waiting a full interval between passes would leave the board
 * hours behind on the morning you most need it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MYBOT_DB = join(mkdtempSync(join(tmpdir(), 'kent-sched-')), 'test.db');
process.env.MYBOT_NO_KEYCHAIN = '1';

const { nextSyncDelay } = await import('./sync.js');

const INTERVAL = 15 * 60_000;

test('a finished sync waits out the normal interval', () => {
  assert.equal(nextSyncDelay({ catchingUp: 0, intervalMs: INTERVAL }), INTERVAL);
});

test('a channel still behind is chased immediately, not on the next tick', () => {
  const delay = nextSyncDelay({ catchingUp: 2, intervalMs: INTERVAL });
  assert.ok(delay < 30_000, `expected a prompt retry, got ${delay}ms`);
});

test('messages captured but not yet judged are chased too', () => {
  // Slack is fully read, but the queue holds more than one pass can judge.
  const delay = nextSyncDelay({ catchingUp: 0, backlog: 240, intervalMs: INTERVAL });
  assert.ok(delay < 30_000, `expected a prompt retry, got ${delay}ms`);
});

test('a backlog stuck behind an unreachable model is not hammered', () => {
  assert.equal(nextSyncDelay({ backlog: 240, errors: 1, intervalMs: INTERVAL }), INTERVAL);
});

test('chasing stops after a bounded number of passes', () => {
  // Otherwise a channel that never drains becomes a hot loop against Slack.
  assert.equal(nextSyncDelay({ catchingUp: 2, passes: 500, intervalMs: INTERVAL }), INTERVAL);
});

test('errors pause the chase instead of hammering a failing API', () => {
  assert.equal(nextSyncDelay({ catchingUp: 2, errors: 1, intervalMs: INTERVAL }), INTERVAL);
});
