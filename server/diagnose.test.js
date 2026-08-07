/**
 * Regression tests for Slack connection diagnostics.
 *
 * These cover the two ways setup actually goes wrong: pasting a bot token, and
 * changing scopes in the Slack app without reinstalling it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mybot-diag-'));
process.env.MYBOT_DB = join(dir, 'test.db');
process.env.SLACK_USER_TOKEN = 'xoxb-test';
process.env.MYBOT_NO_KEYCHAIN = '1';

const { diagnose, REQUIRED_SCOPES } = await import('./slack.js');

const ALL_SCOPES = Object.keys(REQUIRED_SCOPES).join(',');

/** Fake Slack: `scopes` drives the x-oauth-scopes header, `body` the payload. */
function stubSlack({ scopes, body }) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (h) => (h.toLowerCase() === 'x-oauth-scopes' ? scopes : null) },
    json: async () => body,
  });
}

test('a bot token is called out as the wrong identity', async () => {
  stubSlack({
    scopes: ALL_SCOPES,
    body: { ok: true, user: 'mybot', user_id: 'U0BOT', bot_id: 'B01', team: 'acme', url: 'https://x.slack.com/' },
  });

  const health = await diagnose();
  assert.equal(health.ok, false);
  assert.equal(health.tokenType, 'bot');
  assert.equal(health.isBotToken, true);
  assert.match(health.problems[0], /bot token/i);
  assert.match(health.problems[0], /cannot detect @mentions of you/i);
});

test('missing scopes are named individually', async () => {
  stubSlack({
    scopes: 'channels:history,chat:write',
    body: { ok: true, user: 'sam', user_id: 'U0ME', team: 'acme', url: 'https://x.slack.com/' },
  });

  const health = await diagnose();
  assert.equal(health.ok, false);
  assert.equal(health.tokenType, 'user');
  assert.ok(health.missingScopes.includes('users:read'), 'users:read flagged');
  assert.ok(health.missingScopes.includes('channels:read'), 'channels:read flagged');
  assert.ok(!health.missingScopes.includes('channels:history'), 'granted scope not flagged');
  assert.match(health.problems.join(' '), /reinstall/i, 'tells the user a reinstall is required');
});

test('a correctly configured user token is clean', async () => {
  stubSlack({
    scopes: ALL_SCOPES,
    body: { ok: true, user: 'sam', user_id: 'U0ME', team: 'acme', url: 'https://x.slack.com/' },
  });

  const health = await diagnose();
  assert.equal(health.ok, true);
  assert.equal(health.tokenType, 'user');
  assert.deepEqual(health.missingScopes, []);
  assert.deepEqual(health.problems, []);
  assert.equal(health.identity.userId, 'U0ME');
});

test('a rejected token reports rather than throwing', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ ok: false, error: 'invalid_auth' }),
  });

  const health = await diagnose();
  assert.equal(health.ok, false);
  assert.equal(health.identity, null);
  assert.match(health.problems[0], /invalid_auth/);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
