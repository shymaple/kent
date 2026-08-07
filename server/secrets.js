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
