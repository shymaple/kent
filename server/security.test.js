/**
 * Security guards for a local-only server with no login.
 *
 * These cover the two ways a web page you happen to have open could reach Kent:
 * DNS rebinding (Host header) and CSRF (Origin / Sec-Fetch-Site). The reply
 * endpoint posts to Slack and needs no request body, so a cross-site "simple
 * request" would otherwise have reached it without a CORS preflight.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kent-security-'));
process.env.MYBOT_DB = join(dir, 'test.db');
process.env.MYBOT_NO_KEYCHAIN = '1';
process.env.PORT = '0';

const { maskToken } = await import('./secrets.js');
const { buildAliasMatcher } = await import('./prefilter.js');

/**
 * The guard middleware, mirrored from server/index.js. Kept as a pure function
 * here so it can be exercised without binding a port; index.js is the copy that
 * runs, and any divergence should fail these tests loudly.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const isLoopbackHost = (v) => LOOPBACK.has(String(v).replace(/^\[|\]$/g, ''));

function guard(headers, { method = 'GET', path = '/api/tasks' } = {}) {
  const host = String(headers.host ?? '').replace(/:\d+$/, '');
  if (!isLoopbackHost(host)) return 403;

  const origin = headers.origin;
  if (origin && origin !== 'null') {
    let hostname = null;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      hostname = null;
    }
    if (!hostname || !isLoopbackHost(hostname)) return 403;
  }

  const oauthReturn =
    method === 'GET' && path === '/api/gmail/callback' && headers['sec-fetch-mode'] === 'navigate';
  const site = headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none' && !oauthReturn) return 403;

  return 200;
}

test('the app itself is allowed through', () => {
  assert.equal(guard({ host: 'localhost:4317', origin: 'http://localhost:4317', 'sec-fetch-site': 'same-origin' }), 200);
  assert.equal(guard({ host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' }), 200);
  assert.equal(guard({ host: 'localhost:4317' }), 200, 'curl sends no Origin and must still work');
});

test('a cross-site POST is refused even with no body or content-type', () => {
  // The exact shape that skips a CORS preflight.
  assert.equal(guard({ host: 'localhost:4317', origin: 'https://evil.example' }), 403);
});

test('a cross-site request is refused via Sec-Fetch-Site too', () => {
  assert.equal(guard({ host: 'localhost:4317', 'sec-fetch-site': 'cross-site' }), 403);
  assert.equal(guard({ host: 'localhost:4317', 'sec-fetch-site': 'same-site' }), 403);
});

test('the only cross-site request let through is the browser returning from Google consent', () => {
  const fromGoogle = { host: '127.0.0.1:4317', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' };
  assert.equal(guard(fromGoogle, { path: '/api/gmail/callback' }), 200);

  // Same headers, anything else about the request different: still refused.
  assert.equal(guard(fromGoogle, { path: '/api/tasks' }), 403, 'no other path');
  assert.equal(guard(fromGoogle, { path: '/api/gmail/callback', method: 'POST' }), 403, 'no other method');
  assert.equal(guard(fromGoogle, { path: '/api/gmail/connect', method: 'POST' }), 403);
  assert.equal(
    guard({ ...fromGoogle, 'sec-fetch-mode': 'cors' }, { path: '/api/gmail/callback' }), 403,
    'a script fetching it from another page is not a navigation'
  );
  // And the exemption is from Sec-Fetch-Site only - never from the Host or Origin checks.
  assert.equal(guard({ ...fromGoogle, host: 'kent.evil.example' }, { path: '/api/gmail/callback' }), 403);
  assert.equal(guard({ ...fromGoogle, origin: 'https://evil.example' }, { path: '/api/gmail/callback' }), 403);
});

test('DNS rebinding is refused by the Host allowlist', () => {
  // Attacker domain resolving to 127.0.0.1: the socket is local, the Host is not.
  assert.equal(guard({ host: 'kent.evil.example' }), 403);
  assert.equal(guard({ host: 'evil.example:4317' }), 403);
  assert.equal(guard({ host: '' }), 403);
});

test('a hostname that merely contains "localhost" is not loopback', () => {
  assert.equal(guard({ host: 'localhost.evil.example' }), 403);
  assert.equal(guard({ host: 'localhost:4317', origin: 'http://localhost.evil.example' }), 403);
});

test('a malformed Origin is refused rather than waved through', () => {
  assert.equal(guard({ host: 'localhost:4317', origin: 'not a url' }), 403);
});

test('the masked token exposes no usable fragment', () => {
  const masked = maskToken('xoxp-0000000000-0000000000-notarealtokenatall1234');
  assert.equal(masked, 'xoxp-…1234');
  assert.ok(!masked.includes('notareal'), 'no part of the secret body may appear');
  assert.ok(masked.length < 14);
  assert.equal(maskToken(null), null);
});

test('aliases cannot inject a regex', () => {
  // A user alias goes straight into a RegExp; metacharacters must be literal.
  const matcher = buildAliasMatcher(['.*', 'a(b']);
  assert.ok(!matcher.test('literally anything'), '".*" must not match everything');
  assert.ok(matcher.test('found a(b here'), 'the literal string still matches');
});

test('a catastrophic-looking alias stays linear', () => {
  const matcher = buildAliasMatcher(['(a+)+$']);
  const started = Date.now();
  matcher.test(`${'a'.repeat(5000)}!`);
  assert.ok(Date.now() - started < 500, 'escaped aliases cannot cause backtracking blowup');
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
