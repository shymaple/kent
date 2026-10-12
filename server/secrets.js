/**
 * Slack token storage.
 *
 * macOS  -> the login Keychain via the `security` CLI (never touches disk in plaintext).
 * others -> a 0600 file at <repo>/.slack-token, with a warning logged once.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FALLBACK_FILE = join(root, '.slack-token');
const SERVICE = 'kent-slack';
const ACCOUNT = 'slack-user-token';

// Keychain entries written before the tool was named. Read once, migrated to the
// current service name, so a rename never makes anyone re-paste their token.
const LEGACY_SERVICES = ['my-bot-slack'];

const useKeychain = process.platform === 'darwin' && !process.env.MYBOT_NO_KEYCHAIN;
let warned = false;

function warnOnce() {
  if (warned) return;
  warned = true;
  console.warn(
    `[secrets] Keychain unavailable; storing the Slack token at ${FALLBACK_FILE} with 0600 permissions.`
  );
}

function readKeychain(service) {
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', service, '-a', ACCOUNT, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return out.trim() || null;
  } catch {
    return null;   // no entry under this service
  }
}

export function getSlackToken() {
  if (process.env.SLACK_USER_TOKEN) return process.env.SLACK_USER_TOKEN;

  if (useKeychain) {
    const token = readKeychain(SERVICE);
    if (token) return token;

    // Carry a pre-rename token over, once, without bothering the user.
    for (const legacy of LEGACY_SERVICES) {
      const old = readKeychain(legacy);
      if (!old) continue;
      try {
        execFileSync(
          'security',
          ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', old],
          { stdio: 'ignore' }
        );
        console.log(`[secrets] migrated your Slack token from "${legacy}" to "${SERVICE}".`);
      } catch {
        // couldn't write the new entry; the old value still works for this run
      }
      return old;
    }
  }

  if (existsSync(FALLBACK_FILE)) {
    const token = readFileSync(FALLBACK_FILE, 'utf8').trim();
    if (token) return token;
  }
  return null;
}

export function setSlackToken(token) {
  const value = String(token ?? '').trim();
  if (!value) return clearSlackToken();

  if (useKeychain) {
    try {
      // -U updates in place if the entry already exists.
      execFileSync(
        'security',
        ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', value],
        { stdio: 'ignore' }
      );
      return { stored: 'keychain' };
    } catch (err) {
      warnOnce();
    }
  } else {
    warnOnce();
  }

  writeFileSync(FALLBACK_FILE, value, { mode: 0o600 });
  chmodSync(FALLBACK_FILE, 0o600);
  return { stored: 'file' };
}

export function clearSlackToken() {
  if (useKeychain) {
    for (const service of [SERVICE, ...LEGACY_SERVICES]) {
      try {
        execFileSync('security', ['delete-generic-password', '-s', service, '-a', ACCOUNT], {
          stdio: 'ignore',
        });
      } catch {
        // nothing stored under this service
      }
    }
  }
  if (existsSync(FALLBACK_FILE)) unlinkSync(FALLBACK_FILE);
  return { stored: 'none' };
}

export function hasSlackToken() {
  return Boolean(getSlackToken());
}

/**
 * For display in Settings - never send the whole token to the client.
 * Shows only the token type prefix and the last four, enough to tell two tokens
 * apart without putting a usable fragment on screen or in a screenshot.
 */
export function maskToken(token) {
  if (!token) return null;
  const prefix = /^xox[a-z]-/.test(token) ? token.slice(0, 5) : '';
  return `${prefix}…${token.slice(-4)}`;
}

// ------------------------------------------------------------------- Gmail

/**
 * Gmail's OAuth material: the client id and secret you created in Google Cloud,
 * and the refresh token Google issued for them. Kept as one entry because none
 * of the three is any use without the other two, and stored exactly like the
 * Slack token - Keychain on macOS, a 0600 file elsewhere, never the database.
 */
const GMAIL_FILE = join(root, '.gmail-oauth');
const GMAIL_SERVICE = 'kent-gmail';
const GMAIL_ACCOUNT = 'gmail-oauth';

export function getGmailSecrets() {
  let raw = process.env.MYBOT_GMAIL_OAUTH || null;

  if (!raw && useKeychain) {
    try {
      raw = execFileSync(
        'security',
        ['find-generic-password', '-s', GMAIL_SERVICE, '-a', GMAIL_ACCOUNT, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
    } catch {
      raw = null;
    }
  }
  if (!raw && existsSync(GMAIL_FILE)) raw = readFileSync(GMAIL_FILE, 'utf8').trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return parsed?.clientId && parsed?.clientSecret && parsed?.refreshToken ? parsed : null;
  } catch {
    return null;
  }
}

export function setGmailSecrets({ clientId, clientSecret, refreshToken }) {
  const value = JSON.stringify({ clientId, clientSecret, refreshToken });

  if (useKeychain) {
    try {
      execFileSync(
        'security',
        ['add-generic-password', '-U', '-s', GMAIL_SERVICE, '-a', GMAIL_ACCOUNT, '-w', value],
        { stdio: 'ignore' }
      );
      return { stored: 'keychain' };
    } catch {
      // fall through to the file
    }
  }
  writeFileSync(GMAIL_FILE, value, { mode: 0o600 });
  chmodSync(GMAIL_FILE, 0o600);
  return { stored: 'file' };
}

export function clearGmailSecrets() {
  if (useKeychain) {
    try {
      execFileSync('security', ['delete-generic-password', '-s', GMAIL_SERVICE, '-a', GMAIL_ACCOUNT], {
        stdio: 'ignore',
      });
    } catch {
      // nothing stored
    }
  }
  if (existsSync(GMAIL_FILE)) unlinkSync(GMAIL_FILE);
}

export const hasGmail = () => Boolean(getGmailSecrets());
