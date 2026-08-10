---
name: kent
description: Drive Kent, the local Slack-to-Kanban task bot in this repo. Use when the user asks to sync Slack, check their board or inbox, see what's due or overdue, triage or approve tasks, dry-run a channel, check why something wasn't picked up, verify the Slack connection, or tune detection (aliases, priority people, watched channels, strictness). Trigger words include "kent", "my board", "my tasks", "what's due", "sync slack", "inbox", "triage".
---

# Kent

Kent watches the user's Slack, turns the messages that genuinely ask *them* to do
something into Kanban cards, and throws away everything else. It runs locally on
`http://localhost:4317` and uses the user's own Claude Code login — never an API key.

## Before anything else

Kent's server must be running. Check, and start it if not:

```bash
curl -s -o /dev/null -w '%{http_code}' localhost:4317/api/sync/status   # 200 = up
cd <repo> && nohup node server/index.js > /tmp/kent.log 2>&1 &          # if it isn't
```

Read state through the API rather than the SQLite file — the API renders Slack
markup (`<@U123>` → `@Name`) and computes due-day counts. Query the database
directly only for aggregates the API has no endpoint for.

## The cost rule — do not break it

Kent is deliberately cheap: plain code fetches and filters, and the model is
called **once per sync, only when candidate messages exist**. A quiet sync costs
zero model calls.

- **Never** loop or poll `/api/sync/run`. One call per user request.
- **Never** add a scheduler, cron or watch loop. The server already syncs on its
  own interval (Settings → Sync).
- A sync over a busy backlog can take minutes. Run it once and wait.

## Common tasks

**Sync now** — `curl -s -X POST localhost:4317/api/sync/run`
Returns `{channels, messages, candidates, rejected, inboxed, llmCalls, errors}`.
Report `inboxed` and `llmCalls`; mention `rejected` (messages the model judged not
to be tasks) when the user asks why so little appeared.

**Board / what's due** — `GET /api/tasks`, `GET /api/lists`
Each task carries `days_until_due` (negative = overdue), `priority`, `list_id`.
Group by list name; lead with overdue and due-today.

**Inbox** — `GET /api/inbox`, then `POST /api/inbox/:id/approve` (optionally with
edited fields in the body) or `POST /api/inbox/:id/dismiss`.
**Ask before approving or dismissing on the user's behalf** — a dismissal is
permanent for that Slack message.

**Search** — `GET /api/search?q=...` over titles, descriptions, original message
text, channels and people. Local SQL, no model call.

**Create a task** — `POST /api/tasks` with `{title, description, priority,
due_date, category, list_id}`.

**Comment / reply in Slack** — `POST /api/tasks/:id/comment-draft {intent}` where
intent is `done|progress|blocked` returns 2–3 drafts (one model call).
`POST /api/tasks/:id/comments {body, kind}` logs one.
`POST /api/comments/:id/send` posts it into the original Slack thread.
**Always show the text and get explicit confirmation before sending** — this
posts publicly as the user, and needs the `chat:write` scope.

## Diagnosing "why didn't Kent pick this up?"

Work through it in this order — most problems are the first two.

1. **Is the conversation watched?** `GET /api/channels` → check `is_excluded`.
2. **Does the message clear the bar?** A message becomes a candidate only if it
   @mentions the user, uses a configured alias, replies in a thread they're in,
   is an `@channel`/`@here` broadcast, or comes from someone on the priority
   list. This is identical in DMs — ordinary chat never qualifies. Bot messages
   only count if they @mention the user.
3. **Did the model reject it?** Non-tasks are recorded in `seen_messages` with
   outcome `not_task`. Being @mentioned isn't enough: questions answerable in one
   reply, FYIs and thanks are all rejected by design.
4. **Below the confidence floor?** Settings `min_confidence` (default 0.5).
5. **Older than the cursor?** Backfill defaults to 0 — only messages sent after
   setup are considered.

To see the whole pipeline over a real channel without writing anything:

```bash
node server/scripts/dry-run.js <#channel-or-ID> [days]
```

It prints what was ignored, what became a candidate, and what the model made of
each — one model call, nothing persisted.

## Tuning detection

All under `PUT /api/settings` unless noted:

- `aliases` (array) — names people type instead of @-mentioning.
- `min_confidence` — `0.3` loose, `0.5` balanced, `0.7` strict.
- `backfill_days` — `0` means only new messages.
- Priority people — `PUT /api/people/:id {is_priority}`; anything from them is
  forced to **high**, in code, regardless of the model. Their messages are also
  read in full even without a mention (setting `watch_priority_people`), and the
  model is told the sender is a priority person so an unaddressed "we need X by
  Thursday" reads as work rather than as ambiguous chatter.
- Watched conversations — `PUT /api/channels/:id {is_excluded}`.

The classification prompt is `prompts/classify.md`; the reply prompt is
`prompts/comment.md`. Keep both short — they run on every batch. After editing
either, re-score with `npm run triage-check`, which grades the prompt against
labelled fixtures and exits non-zero on a regression.

## Checking the Slack connection

`GET /api/slack/diagnose` reports token type, identity, granted scopes, missing
scopes and `canReply`. A bot token (`xoxb-`) cannot work: Slack sees it as the
app, so mentions of the user are invisible. Kent needs a **user** token (`xoxp-`).
Scope changes require reinstalling the Slack app, then re-pasting the token.

## Don'ts

- Don't set `ANTHROPIC_API_KEY` or add another model provider. Kent shells out to
  `claude -p` and uses the existing login on purpose.
- Don't read or print the Slack token. It lives in the macOS Keychain
  (`kent-slack`); `GET /api/settings` returns only a masked form.
- Don't post to Slack, approve, dismiss or delete without asking first.
- Don't edit `data/app.db` by hand while the server is running.
