import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.MYBOT_DB ?? join(root, 'data', 'app.db');

mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL,              -- channel | private | im | mpim
  is_member      INTEGER NOT NULL DEFAULT 1,
  is_excluded    INTEGER NOT NULL DEFAULT 0,
  last_synced_ts TEXT,                       -- Slack ts cursor; NULL = never synced
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS people (
  slack_user_id TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  real_name     TEXT,
  is_priority   INTEGER NOT NULL DEFAULT 0
);

-- Every Slack message we have already made a decision about, so we never
-- reprocess or re-surface it. Covers dismissed items too.
CREATE TABLE IF NOT EXISTS seen_messages (
  channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  outcome    TEXT NOT NULL,                  -- inboxed | dismissed | not_task | merged
  seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel_id, message_ts)
);

CREATE TABLE IF NOT EXISTS inbox_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  state         TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | dismissed
  title         TEXT NOT NULL,
  description   TEXT,
  priority      TEXT NOT NULL DEFAULT 'medium',
  due_date      TEXT,
  category      TEXT,
  is_broadcast  INTEGER NOT NULL DEFAULT 0,
  reason        TEXT,                              -- why we caught it: mention|dm|thread|broadcast|alias
  confidence    REAL,
  channel_id    TEXT NOT NULL,
  channel_name  TEXT NOT NULL,
  message_ts    TEXT NOT NULL,
  thread_ts     TEXT,
  permalink     TEXT,
  assigner_id   TEXT,
  assigner_name TEXT,
  links         TEXT NOT NULL DEFAULT '[]',        -- JSON array of {url,label}
  source_text   TEXT NOT NULL,
  llm_verdict   TEXT,                              -- raw JSON from the model
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel_id, message_ts)
);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'open',      -- open | in_progress | in_review | completed
  priority      TEXT NOT NULL DEFAULT 'medium',    -- high | medium | low
  due_date      TEXT,
  category      TEXT,
  is_broadcast  INTEGER NOT NULL DEFAULT 0,        -- -> Miscellaneous lane
  position      REAL NOT NULL DEFAULT 0,           -- ordering within a column
  channel_id    TEXT,
  channel_name  TEXT,
  message_ts    TEXT,
  thread_ts     TEXT,
  permalink     TEXT,
  assigner_id   TEXT,
  assigner_name TEXT,
  links         TEXT NOT NULL DEFAULT '[]',
  source_text   TEXT,
  confidence    REAL,
  snooze_until  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT,
  archived_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status, archived_at);
CREATE INDEX IF NOT EXISTS idx_tasks_thread  ON tasks(channel_id, thread_ts);
CREATE INDEX IF NOT EXISTS idx_inbox_state   ON inbox_items(state);

-- Board columns. Users can add, rename, reorder and delete these, so nothing
-- may key off a list's name. The semantic column carries the meaning instead:
-- a list with semantic 'done' triggers completion behaviour even if renamed.
CREATE TABLE IF NOT EXISTS lists (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  position   REAL NOT NULL,
  semantic   TEXT NOT NULL DEFAULT 'custom',   -- backlog | active | review | done | custom
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every comment is logged locally whether or not it was sent to Slack, so the
-- card shows what you said and when. slack_ts is set only once posted.
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'manual',   -- manual | generated | template
  slack_ts   TEXT,
  permalink  TEXT,
  posted_at  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id, id);

CREATE TABLE IF NOT EXISTS sync_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  channels_seen INTEGER NOT NULL DEFAULT 0,
  messages_seen INTEGER NOT NULL DEFAULT 0,
  candidates    INTEGER NOT NULL DEFAULT 0,
  llm_calls     INTEGER NOT NULL DEFAULT 0,
  inboxed       INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);
`);

/** Add a column only if it isn't there yet - safe to run on every boot. */
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumn('tasks', 'list_id', 'INTEGER REFERENCES lists(id)');

export const DEFAULT_LISTS = [
  { name: 'Open', semantic: 'backlog', status: 'open' },
  { name: 'In Progress', semantic: 'active', status: 'in_progress' },
  { name: 'In Review', semantic: 'review', status: 'in_review' },
  { name: 'Completed', semantic: 'done', status: 'completed' },
];

/**
 * Seed the four default lists on a fresh database, then attach any task that
 * predates lists to the list matching its old `status`. Idempotent: existing
 * lists are left alone, and tasks that already have a list_id are untouched.
 */
function migrateTasksToLists() {
  const existing = db.prepare('SELECT COUNT(*) n FROM lists').get().n;
  if (existing === 0) {
    const insert = db.prepare('INSERT INTO lists (name, position, semantic) VALUES (?, ?, ?)');
    db.transaction(() => {
      DEFAULT_LISTS.forEach((l, i) => insert.run(l.name, i + 1, l.semantic));
    })();
  }

  const orphans = db.prepare('SELECT COUNT(*) n FROM tasks WHERE list_id IS NULL').get().n;
  if (orphans === 0) return;

  const bySemantic = new Map(
    db.prepare('SELECT id, semantic FROM lists').all().map((l) => [l.semantic, l.id])
  );
  const firstList = db.prepare('SELECT id FROM lists ORDER BY position, id LIMIT 1').get()?.id;
  if (!firstList) return;

  const update = db.prepare('UPDATE tasks SET list_id = ? WHERE id = ?');
  db.transaction(() => {
    for (const t of db.prepare('SELECT id, status FROM tasks WHERE list_id IS NULL').all()) {
      const target = DEFAULT_LISTS.find((l) => l.status === t.status);
      // Anything unrecognised lands in the first list rather than nowhere.
      update.run(bySemantic.get(target?.semantic) ?? firstList, t.id);
    }
  })();
}

migrateTasksToLists();

/**
 * The legacy `status` value implied by a list, so anything still reading status
 * (the Miscellaneous lane, old rows, the API surface) stays consistent when a
 * task is dragged between custom lists.
 */
export function statusForList(listId) {
  const list = db.prepare('SELECT semantic FROM lists WHERE id = ?').get(listId);
  const match = DEFAULT_LISTS.find((l) => l.semantic === list?.semantic);
  return match?.status ?? 'open';
}

export const isDoneList = (listId) =>
  db.prepare('SELECT semantic FROM lists WHERE id = ?').get(listId)?.semantic === 'done';

/** The list a task should land in when its status is set programmatically. */
export function listIdForStatus(status) {
  const target = DEFAULT_LISTS.find((l) => l.status === status);
  const row = target
    ? db.prepare('SELECT id FROM lists WHERE semantic = ? ORDER BY position LIMIT 1').get(target.semantic)
    : null;
  return row?.id ?? db.prepare('SELECT id FROM lists ORDER BY position, id LIMIT 1').get()?.id ?? null;
}

export const DEFAULT_SETTINGS = {
  poll_interval_minutes: '15',
  backfill_days: '0',   // 0 = start from now; only messages sent after setup
  aliases: '[]',
  model: 'claude-sonnet-5',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  slack_user_id: '',              // discovered from auth.test
  slack_user_id_override: '',     // set manually when auth.test is not you (bot token)
  slack_team_domain: '',
  batch_size: '15',
  auto_sync: 'true',
  min_confidence: '0.5',   // below this the model's "task" call is not trusted
  show_completed: 'true',
  show_miscellaneous: 'true',
  comment_templates: '[]',
  tone_note: '',           // distilled from a sample of your own Slack messages
};

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULT_SETTINGS[key];
}

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const { key, value } of rows) out[key] = value;
  return out;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export function setSettings(obj) {
  const tx = db.transaction((entries) => {
    for (const [k, v] of entries) setSetting(k, v);
  });
  tx(Object.entries(obj));
}

/** Aliases are stored as a JSON array of strings. */
export function getAliases() {
  try {
    const parsed = JSON.parse(getSetting('aliases') ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((a) => typeof a === 'string' && a.trim()) : [];
  } catch {
    return [];
  }
}
