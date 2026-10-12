# Kent — notes for Claude Code

A local Slack→Kanban task bot. Reads the user's Slack (and, optionally, Gmail), turns messages
that genuinely ask *them* to do something into cards, discards the rest. Server + UI on `http://localhost:4317`.

Classification shells out to the local `claude` CLI using the user's own Claude Code login.
There is no API key anywhere in this project, by design.

README.md is the feature tour, SETUP.md the Slack app setup, SECURITY.md the trust model.
This file is what you need to change code here safely.

## Commands

| | |
|---|---|
| `npm run dev` | server `--watch` on :4317 + Vite on :5317 — **use :5317 while editing** |
| `npm start` | serves the built `client/dist` on :4317 (run `npm run build` first) |
| `npm test` | `node --test server/*.test.js` — 292 tests, no network, no model calls |
| `npm run smoke` | esbuild-bundles `client/smoke.jsx`, server-renders every screen |
| `npm run triage-check` | grades `prompts/classify.md` against labelled fixtures, exits 1 on a miss |
| `npm run probe` · `dry-run` · `classify-once` | need a real Slack token / real model — not for CI |

**Before any commit: `npm test` and `npm run smoke`. Add `npm run triage-check` if you
touched `prompts/classify.md`.**

## Architecture

The cost shape *is* the design. The model is the last step, never the first:

```
slack.js fetch → prefilter.js (pure, free)  → queue.js enqueue (durable, PRE-model)
              → classify.js (ONE claude call per batch, only if candidates exist)
              → enrich.js → inbox_items → user approves → tasks
```

A sync over a quiet workspace makes zero model calls.

Email is a second source into the *same* queue: `gmail.js → mailfilter.js → enqueue`, done by
`collectMail` inside `runSync`. From the queue on there is one path, so email gets the same
confidence floor and backstops. Email rows use `channel_id = 'gmail'`, `message_ts` = Gmail
message id, `thread_ts` = thread id, `source = 'email'`, and carry their own `sent_at` — a
Gmail id is **not** a timestamp, so never parse `message_ts` as one without checking `source`.

### server/

| | |
|---|---|
| `index.js` | Express 5, all `/api/*` routes, loopback + CSRF guards, serves the client |
| `sync.js` | the sync loop **and** the scheduler — `runSync`, `startScheduler`, `nextSyncDelay` |
| `prefilter.js` | deterministic candidate detection, pure, no I/O — `classifyCandidate` |
| `queue.js` | durable `pending_candidates` queue — `enqueueCandidate`, `dropCandidate`, `queueStats` |
| `classify.js` | the only LLM caller; spawns `claude` — `classifyBatch`, `draftComment`, `chunk` |
| `enrich.js` | verdict → storable card: priority overrides, links, deadline sanity — `enrich` |
| `deadline.js` | rule-based date parsing, fallback for the model — `parseDeadline` |
| `handled.js` | "I already dealt with this in Slack" (✅ or a reply) — `handledInSlack` |
| `ephemeral.js` | drops asks that expired before you read them — `looksEphemeral` |
| `social.js` | drops mentions that are chat, not work ("how are you", "lunch?") — `looksSocial` |
| `gmail.js` | Gmail API over `fetch`, no SDK, `gmail.readonly` only — `listMessageIds`, `parseMessage`, `stripQuoted` |
| `mailfilter.js` | deterministic candidate detection for email, pure — `classifyMail` |
| `mailsync.js` | reads new mail and enqueues candidates on the shared queue — `collectMail` |
| `richtext.js` | allowlist sanitiser for description HTML, plus its plain rendering — `sanitizeHtml`, `htmlToText` |
| `slacklink.js` | recognises a link to one Slack message, pure — `parseSlackLink` |
| `importslack.js` | builds a task from a pasted message link — `importSlackMessage` |
| `render.js` | Slack markup → readable text — `renderSlackText`, `invalidateDirectory` |
| `slack.js` | Slack Web API over `fetch`, no SDK — `fetchHistory`, `postThreadReply`, `diagnose` |
| `secrets.js` | token in the macOS Keychain, else `0600 .slack-token` — `maskToken` |
| `db.js` | better-sqlite3 handle, schema, additive migrations, `DEFAULT_SETTINGS` |

**There is no `scheduler.js`.** The scheduler is the `// --- scheduling` section at the
bottom of `sync.js`; `scheduler.test.js` tests `nextSyncDelay` from there. It compares wall
clock rather than trusting timer firing, because a shut laptop freezes timers.

`server/scripts/` holds the operator tools behind the npm scripts above, plus `seed-demo.js`
(`MYBOT_DB=/tmp/demo.db node server/scripts/seed-demo.js`) for UI work with no live Slack.

### client/

React 19 + Vite, `@dnd-kit` for the board. **No state library and no data-fetching library** —
`App.jsx` holds the only lifted state, and a `refreshKey` counter is the global reload signal.
Every call goes through the single `request()` wrapper in `client/src/api.js`.

One hand-written `styles.css`: `:root` custom-property tokens with a
`prefers-color-scheme: dark` override. No framework, no CSS modules.

`Modal.jsx` runs its setup effect **once** and reads `onClose` through a ref. Do not put
`onClose` back in the dependency list: callers pass inline arrows, so the effect would re-run on
every parent render and move focus mid-keystroke (this shipped; it is why typing in Description
jumped to Title). Closing a dialog blurs the active field first, because fields save on blur and
an unmounting field never gets one. A field that wants Escape for itself sets `data-own-escape`.

The description is `RichText.jsx`, a contentEditable box. Its `dangerouslySetInnerHTML` object is
held in state on purpose: React compares that prop by identity and re-applies `innerHTML` when
it differs, so a fresh `{ __html }` per render wipes the box on every keystroke.

Date inputs go through `AutoSaveDate` (commit on blur) — a date typed by keyboard fires a change
per digit, and saving each one wrote years like `0002`.

`TaskModal` autosaves on blur and deliberately has no Save button — `smoke.jsx` asserts that,
so adding one fails the smoke test on purpose. It asserts several other UI contracts the same
way; read its failure messages before "fixing" one.

## Conventions

- **ESM only** (`"type": "module"`). `.js` extension required on relative imports;
  `fileURLToPath(import.meta.url)` for paths.
- Node ≥ 20. Runtime deps are exactly `better-sqlite3` and `express`. Adding a third is a
  real decision, not a convenience.
- camelCase in JS, snake_case in SQL — convert at the boundary (`toCandidate` in `queue.js`,
  `parseTask` in `index.js`). Prepared statements are module-level consts; multi-statement
  writes go through `db.transaction(...)()`.
- Errors carry `userMessage` (safe for the browser) and `detail` (terminal only). The `h()`
  route wrapper in `index.js` logs `detail` and returns only `userMessage`. **Never let a
  stack, SQL string or command line reach the client.**
- Migrations are additive and run at import time in `db.js`: add one idempotent
  `addColumn(table, col, def)` call. No migration files, no version table.
- **Comment style is a real convention here.** Every module opens with a block comment
  explaining *why it exists*, usually citing the failure that caused it — see `handled.js`,
  `ephemeral.js`, `queue.js`. Match it. Don't write a summary of what the function does.

## Tests

`node:test` + `node:assert/strict`. Never Jest or Vitest.

Every DB-touching test opens with this preamble, and the import **must** be dynamic — a
static `import './db.js'` binds the real database before the env var is set:

```js
process.env.MYBOT_DB = join(mkdtempSync(join(tmpdir(), 'kent-<area>-')), 'test.db');
process.env.MYBOT_NO_KEYCHAIN = '1';
const { db } = await import('./db.js');
```

Slack is stubbed by replacing `globalThis.fetch` and switching on the URL, so `slack.js`
still runs for real over a fake HTTP layer. The model is avoided by injecting
`runSync({ classifier })`. `api.test.js` is the one true integration test — it spawns
`index.js` on a pid-derived port. Test names are full sentences.

Env vars: `MYBOT_DB`, `MYBOT_NO_KEYCHAIN`, `MYBOT_TZ`, `MYBOT_MODEL`, `SLACK_USER_TOKEN`, `MYBOT_GMAIL_OAUTH` (tests only), `PORT`.

## Invariants — do not break these

- **Enqueue before the model.** `enqueueCandidate` runs the moment the prefilter matches. A
  row leaves `pending_candidates` only via the `settle` transaction, which pairs `markSeen`
  with `dropCandidate`. Splitting those two loses a message or triages it twice.
- **Never inbox an unclassified message.** On classifier failure, leave rows queued and call
  `markAttemptFailed`. Dumping raw Slack text onto the board is an explicit anti-goal.
- **Never poll or loop the sync.** One `/api/sync/run` per user request. The server already
  schedules itself; adding a cron or watch loop breaks the cost design.
- **Cursors are written last.** `pendingCursors` flushes only after queueing; advancing
  earlier strands messages. `backfill_days` defaults to `'0'` and 0 is *meaningful* ("start
  from now") — `Number(x) || 7` would silently swallow it.
- **A task with an open subtask cannot be completed.** Enforced in `PATCH /api/tasks/:id`, the
  one door every way of closing goes through (drag, card tick, Mark done). It answers 409 with
  `code: 'open_subtasks'`; only an explicit `complete_subtasks: true` closes them all. The reverse
  holds too: adding or unticking a subtask on a finished task moves it out of the done list
  (`reopenIfDone`). `subtasks.test.js` covers both directions.
- **Description HTML is never stored as it arrived.** Every write goes through `sanitizeHtml`,
  which rebuilds the markup from an allowlist and emits no attribute except a checked `href`.
  `description` is always the plain rendering of `description_html`; write them together.
- **Nothing but a Slack message link reaches Slack.** `parseSlackLink` runs before any I/O in
  both `POST /api/tasks` and `/api/tasks/from-slack`.
- **Lists are keyed by `semantic`, never by name** (`statusForList`, `isDoneList`). Users
  rename and delete them.
- **No `ANTHROPIC_API_KEY`, no second provider.** `classify.js` runs `claude -p` with
  `--allowed-tools ''` and `--strict-mcp-config`, cwd a scratch tmpdir. `--bare` is avoided
  because it forces an API key, and `--permission-mode bypassPermissions` was deliberately
  removed. Slack text is untrusted prompt input.
- **Never log or return the raw Slack token** — `maskToken` only.
- **Don't relax the loopback guards** in `index.js`: Host allowlist (DNS rebinding) plus
  Origin/`Sec-Fetch-Site` check (CSRF), bound to `127.0.0.1`. `POST /api/comments/:id/send`
  takes no body, so a cross-site "simple request" would otherwise reach it. `security.test.js`
  covers this.
- **`postThreadReply` is the only write Kent ever performs**, and only after the user
  presses Send. Kent never posts, edits or deletes in Slack on its own. Gmail is
  `gmail.readonly` — do not add a broader scope or any send/modify call.
- **`GET /api/gmail/callback` is the single exemption from the cross-site check**, as a
  top-level navigation only, and it must keep refusing any request without the one-time
  `state` from `pendingConsent`. Don't widen it to other paths or methods.
- **Thread follow-ups are proposed, never applied.** A new ask in a thread that has a card
  goes to the Inbox with `parent_task_id`; only approving it adds the subtask.
- `render.js` caches the user/channel directory for 60s — call `invalidateDirectory()` after
  a directory refresh or new names won't appear.
- `index.html` must stay `no-cache` while hashed assets stay `immutable`. The alternative
  already shipped a stale bundle once.
