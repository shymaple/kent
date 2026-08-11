/**
 * Batched classification via the local `claude` CLI.
 *
 * Uses the user's existing Claude Code login - no ANTHROPIC_API_KEY, no other
 * provider. Tools are disabled and cwd is a scratch dir, so this is a pure
 * text-in / JSON-out call with no project context leaking in.
 *
 * Deliberately NOT using `--bare`: that mode forces ANTHROPIC_API_KEY and
 * refuses to read the OAuth session we want.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_PATH = join(root, 'prompts', 'classify.md');
const COMMENT_PROMPT_PATH = join(root, 'prompts', 'comment.md');

let scratchDir;
function getScratchDir() {
  scratchDir ??= mkdtempSync(join(tmpdir(), 'kent-'));
  return scratchDir;
}

export function readPrompt() {
  return readFileSync(PROMPT_PATH, 'utf8');
}

/**
 * Turn a CLI failure into something with a cause attached.
 *
 * On failure the CLI usually still prints its JSON envelope to *stdout* and
 * exits non-zero, so reading only stderr threw the reason away and left us
 * echoing the whole command line — useless to a user and leaking internals.
 *
 * Returns an Error carrying `userMessage` (safe to show) and `detail` (for the
 * terminal).
 */
function cliError(err, stdout, stderr, timeoutMs) {
  let detail = stderr?.trim() || '';

  if (!detail && stdout) {
    try {
      const envelope = JSON.parse(stdout);
      detail = envelope.result || envelope.error || '';
    } catch {
      detail = String(stdout).trim().slice(0, 500);
    }
  }
  if (!detail) detail = err.message;

  const lower = detail.toLowerCase();
  let userMessage;
  if (err.killed) {
    userMessage = `Claude took longer than ${Math.round(timeoutMs / 1000)}s to answer. It will be retried on the next sync.`;
  } else if (lower.includes('usage limit') || lower.includes('rate limit') || lower.includes('429')) {
    userMessage = 'Claude is rate limited right now. Kent will retry shortly.';
  } else if (lower.includes('not logged in') || lower.includes('unauthor') || lower.includes('authentication')) {
    userMessage = 'Claude Code is not signed in. Run `claude` in a terminal and log in.';
  } else if (lower.includes('enoent')) {
    userMessage = 'The `claude` command was not found. Install Claude Code and make sure it is on your PATH.';
  } else {
    userMessage = 'Claude could not be reached. Check the terminal running Kent for the reason.';
  }

  const error = new Error(`claude CLI failed: ${detail}`);
  error.userMessage = userMessage;
  error.detail = detail;
  return error;
}

/** Run `claude -p` and return its result text. */
function runClaude(prompt, { model, timeoutMs = 300_000 } = {}) {
  // Slack message text goes into this prompt, so treat it as untrusted input:
  // a message could try to talk the model into doing something. No tools are
  // allowed and no MCP servers are loaded, so there is nothing for an injected
  // instruction to reach - the worst it can do is produce a bad card, which the
  // triage Inbox and schema validation both catch.
  //
  // `--permission-mode bypassPermissions` was deliberately removed: with no
  // tools there is nothing to approve, and leaving it set would silently arm any
  // tool a future edit re-enabled.
  const args = [
    '-p',
    '--output-format', 'json',
    '--allowed-tools', '',
    // No MCP servers: they add startup latency, system-prompt tokens, and reach.
    '--strict-mcp-config',
  ];
  if (model) args.push('--model', model);

  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      args,
      { cwd: getScratchDir(), timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(cliError(err, stdout, stderr, timeoutMs));
        try {
          const envelope = JSON.parse(stdout);
          if (envelope.is_error) return reject(new Error(`claude returned an error: ${envelope.result}`));
          resolve(envelope.result ?? '');
        } catch {
          resolve(stdout); // not the JSON envelope we expected; let the parser try
        }
      }
    );
    child.stdin.end(prompt);
  });
}

/** Pull the first JSON array out of a model response, tolerating stray prose. */
export function parseJsonArray(text) {
  const trimmed = String(text ?? '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : trimmed;

  const attempts = [body];
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start !== -1 && end > start) attempts.push(body.slice(start, end + 1));

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // try the next shape
    }
  }
  throw new Error(`could not parse a JSON array from model output: ${body.slice(0, 300)}`);
}

const PRIORITIES = new Set(['high', 'medium', 'low']);
const CATEGORIES = new Set(['bug', 'review', 'meeting', 'admin', 'doc', 'followup', 'other']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Coerce one model object into a shape we are willing to store. */
export function validateVerdict(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;

  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 120) : '';
  const priority = PRIORITIES.has(raw.priority) ? raw.priority : 'medium';
  const category = CATEGORIES.has(raw.category) ? raw.category : 'other';

  let dueDate = null;
  if (typeof raw.due_date === 'string' && ISO_DATE.test(raw.due_date.trim())) {
    const candidate = raw.due_date.trim();
    if (!Number.isNaN(Date.parse(candidate))) dueDate = candidate;
  }

  let confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.min(1, Math.max(0, confidence));

  return {
    id: String(raw.id),
    isTask: raw.is_task !== false && Boolean(title),
    title,
    description:
      typeof raw.description === 'string' && raw.description.trim()
        ? raw.description.trim().slice(0, 600)
        : null,
    priority,
    dueDate,
    category,
    confidence,
  };
}

/**
 * Classify a batch of candidates.
 *
 * @param candidates [{ id, channel, from, sentAt, text, threadContext? }]
 * @returns { verdicts: Map<id, verdict>, calls: number, raw: string }
 */
export async function classifyBatch(candidates, { model, timezone } = {}) {
  if (!candidates.length) return { verdicts: new Map(), calls: 0, raw: '' };

  const payload = candidates.map((c) => ({
    id: c.id,
    channel: c.channel,
    from: c.from,
    sent_at: c.sentAt,
    text: c.text,
    ...(c.threadContext ? { thread_context: c.threadContext } : {}),
    ...(c.isBroadcast ? { broadcast_to_channel: true } : {}),
    ...(c.fromPriorityPerson ? { from_priority_person: true } : {}),
  }));

  const prompt = [
    readPrompt(),
    '',
    `User timezone: ${timezone || 'UTC'}.`,
    '',
    'Messages:',
    JSON.stringify(payload),
  ].join('\n');

  // Classification time scales with batch size; a fixed ceiling silently killed
  // larger batches mid-flight. Budget generously and retry once - a lost batch
  // is far more expensive than a slow one.
  const timeoutMs = Math.min(600_000, 120_000 + candidates.length * 20_000);

  let raw;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      raw = await runClaude(prompt, { model, timeoutMs });
      break;
    } catch (err) {
      lastError = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (raw === undefined) throw lastError;

  const parsed = parseJsonArray(raw);

  const verdicts = new Map();
  for (const item of parsed) {
    const v = validateVerdict(item);
    if (v) verdicts.set(v.id, v);
  }
  return { verdicts, calls: 1, raw };
}

/**
 * Draft Slack reply variants for a task. One call, made only when the user asks
 * for a draft - never as part of a sync.
 *
 * @returns string[] of 2-3 variants
 */
export async function draftComment(task, intent, { model, toneNote } = {}) {
  const prompt = [
    readFileSync(COMMENT_PROMPT_PATH, 'utf8'),
    '',
    toneNote ? `Match this person's usual writing style: ${toneNote}` : '',
    '',
    `Task: ${task.title}`,
    task.description ? `Context: ${task.description}` : '',
    task.source_text ? `Original Slack message: ${task.source_text}` : '',
    `Intent: ${intent}`,
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await runClaude(prompt, { model, timeoutMs: 120_000 });
  const parsed = parseJsonArray(raw);

  const variants = parsed
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim().slice(0, 500))
    .slice(0, 3);

  if (!variants.length) throw new Error('the model returned no usable drafts');
  return variants;
}

/**
 * Distil a sample of the user's own messages into a short style note, stored
 * once in settings so per-comment drafting costs nothing extra.
 */
export async function summariseTone(samples, { model } = {}) {
  if (!samples.length) throw new Error('no messages to learn from');

  const prompt = [
    'Below are Slack messages written by one person.',
    'Describe their writing style in at most two short sentences: sentence length, formality, punctuation and emoji habits, and any recurring phrasing.',
    'Reply with the description only - no preamble, no quotes, no list.',
    '',
    ...samples.slice(0, 30).map((s) => `- ${s}`),
  ].join('\n');

  const raw = await runClaude(prompt, { model, timeoutMs: 120_000 });
  return String(raw).trim().replace(/^["']|["']$/g, '').slice(0, 400);
}

/** Split into batches so one huge sync doesn't blow the context window. */
export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
