/**
 * Lists migration and semantics.
 *
 * The important guarantees: an existing board survives the migration intact,
 * completion behaviour follows the 'done' semantic rather than a list's name,
 * and deleting a list never deletes work.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const dir = mkdtempSync(join(tmpdir(), 'mybot-lists-'));
const dbPath = join(dir, 'test.db');

// Build a pre-lists database first, so the migration has something to convert.
const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'medium',
    position REAL NOT NULL DEFAULT 0,
    is_broadcast INTEGER NOT NULL DEFAULT 0,
    links TEXT NOT NULL DEFAULT '[]',
    channel_id TEXT,
    thread_ts TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    archived_at TEXT
  );
  INSERT INTO tasks (title, status) VALUES
    ('an open one', 'open'),
    ('in flight', 'in_progress'),
    ('under review', 'in_review'),
    ('finished', 'completed'),
    ('bogus status', 'nonsense');
`);
legacy.close();

process.env.MYBOT_DB = dbPath;
process.env.MYBOT_NO_KEYCHAIN = '1';
const { db, statusForList, isDoneList, listIdForStatus } = await import('./db.js');

const listNamed = (name) => db.prepare('SELECT * FROM lists WHERE name = ?').get(name);
const taskNamed = (title) => db.prepare('SELECT * FROM tasks WHERE title = ?').get(title);

test('migration seeds four lists and keeps every existing task', () => {
  const lists = db.prepare('SELECT * FROM lists ORDER BY position').all();
  assert.deepEqual(lists.map((l) => l.name), ['Open', 'In Progress', 'In Review', 'Completed']);
  assert.deepEqual(lists.map((l) => l.semantic), ['backlog', 'active', 'review', 'done']);

  assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n, 5, 'no task lost');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks WHERE list_id IS NULL').get().n, 0);
});

test('each task lands in the list matching its old status', () => {
  assert.equal(taskNamed('an open one').list_id, listNamed('Open').id);
  assert.equal(taskNamed('in flight').list_id, listNamed('In Progress').id);
  assert.equal(taskNamed('under review').list_id, listNamed('In Review').id);
  assert.equal(taskNamed('finished').list_id, listNamed('Completed').id);
});

test('an unrecognised status falls into the first list rather than nowhere', () => {
  assert.equal(taskNamed('bogus status').list_id, listNamed('Open').id);
});

test('completion follows the done semantic, not the list name', () => {
  const done = listNamed('Completed');
  assert.equal(isDoneList(done.id), true);
  assert.equal(statusForList(done.id), 'completed');

  // Renaming must not break it - this is why nothing keys off the name.
  db.prepare('UPDATE lists SET name = ? WHERE id = ?').run('Shipped 🎉', done.id);
  assert.equal(isDoneList(done.id), true, 'a renamed done list is still a done list');
  assert.equal(statusForList(done.id), 'completed');
});

test('a custom list is not a done list and reads as open', () => {
  const info = db
    .prepare("INSERT INTO lists (name, position, semantic) VALUES ('Waiting on others', 5, 'custom')")
    .run();
  assert.equal(isDoneList(info.lastInsertRowid), false);
  assert.equal(statusForList(info.lastInsertRowid), 'open');
});

test('listIdForStatus maps legacy statuses onto real lists', () => {
  assert.equal(listIdForStatus('in_review'), listNamed('In Review').id);
  assert.equal(listIdForStatus('completed'), db.prepare("SELECT id FROM lists WHERE semantic='done'").get().id);
  assert.equal(listIdForStatus('gibberish'), listNamed('Open').id, 'unknown falls back to the first list');
});

test('a second boot does not duplicate lists or reassign tasks', async () => {
  const before = db.prepare('SELECT id, list_id FROM tasks ORDER BY id').all();
  const listCount = db.prepare('SELECT COUNT(*) n FROM lists').get().n;

  db.close();
  const reopened = await import(`./db.js?cachebust=${Date.now()}`);

  assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM lists').get().n, listCount);
  assert.deepEqual(reopened.db.prepare('SELECT id, list_id FROM tasks ORDER BY id').all(), before);
  reopened.db.close();
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
