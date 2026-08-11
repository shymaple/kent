# Kent

Kent reads your Slack, turns the messages that genuinely ask **you** to do
something into Kanban cards, and throws away everything else.

Runs entirely on your machine. Uses your existing **Claude Code login** — no
`ANTHROPIC_API_KEY`, no other provider, no cloud service, no account to create.

→ **[SETUP.md](SETUP.md)** for the 5-minute install.

---

## Why it exists

Being @mentioned is not the same as being given work. Most tools that watch Slack
hand you everything you were tagged in; you end up triaging a second inbox.

Kent's whole job is the opposite: **be strict about what earns your attention.**
A message becomes a task only if it asks you to produce, change, send, review, fix
or attend something. "What happened with the deploy?", "any update?", "tagging you
for context", "nice work" — all rejected, even though they mention you by name.

On a real workspace sync: **69 messages → 15 candidates → 14 rejected → 1 task.**

---

## What it does

- Watches the conversations you're in and catches a message only when it:
  - **@mentions you**, or
  - uses **your name** without an @-mention (configurable aliases), or
  - **replies in a thread** you're part of, or
  - is an **`@channel` / `@here` broadcast** → captured as a low-priority card,
    tinted so you can see at a glance it was not addressed to you, or
  - comes from a **priority person** — anyone on that short list is read in full,
    mention or not, because people who matter often just say "this needs updating"
    without tagging anyone

  The same bar applies inside DMs. Ordinary conversation never becomes a task and
  never reaches the model.
- Fills in title, description, priority, deadline, category and every link —
  including files uploaded to Slack, stored as the **Slack permalink**, never the
  document itself.
- Puts everything in a **triage Inbox** first. You approve, edit, or dismiss.
- **Custom lists** — add, rename, reorder, delete. Deleting a list moves its tasks;
  it never deletes work.
- **Reply from the board.** Finish a task, generate a short reply in your own
  writing style, and post it straight into the original Slack thread — after you
  press Send, never before.
- **Finishing a task offers the reply.** Drag a card into Completed and Kent
  drafts a short update for whoever asked — you read it and press Send, or don't.
- **Snooze** a card until a date, and see at a glance which in-progress work has
  gone quiet.
- **⌘K** search, **⌘⇧N** new task, **Esc** closes anything.

Board columns start as **Open → In Progress → In Review → Completed**, drag and
drop, and are yours to change.

---

## The cost design

The model is the last step, not the first.

```
Slack fetch  →  string matching  →  [only if candidates exist]  →  one batched claude call
   (free)         (free, local)                                      per sync, not per message
```

A sync over a quiet workspace makes **zero** model calls — the status bar shows the
count for the last run, so you can watch it stay honest.

Rules that don't need judgement never reach the prompt: priority-people escalation,
broadcast demotion, link extraction and deadline sanity are all plain code in
`server/enrich.js` and `server/deadline.js`. `prompts/classify.md` is about twenty lines, and
`npm run triage-check` grades it against labelled fixtures so a "small tweak"
can't quietly wreck it.

---

## Layout

```
server/
  prefilter.js   deterministic candidate detection  ← the cost control
  classify.js    batched `claude -p` calls + JSON validation
  enrich.js      priority overrides, links, deadline sanity
  deadline.js    weekday/relative date parsing, as a fallback for the model
  render.js      Slack markup → readable text (<@U123> → @Name)
  slack.js       Slack Web API (fetch, no SDK)
  sync.js        the poll loop
  index.js       REST API + serves the UI
  secrets.js     Slack token in the macOS Keychain
  db.js          SQLite schema and migrations
client/          React board, inbox, settings, command bar
prompts/
  classify.md    is this a task? — runs on every batch, keep it short
  comment.md     drafting Slack replies
.claude/skills/kent/
  SKILL.md       lets Claude Code drive Kent in plain language
```

## Commands

```bash
npm start                          # server + UI on http://localhost:4317
npm run dev                        # server --watch + Vite dev server on :5317
npm test                           # 114 tests, no network and no model calls
npm run probe                      # verify the Slack token, list your conversations
npm run dry-run <#channel> [days]  # full pipeline over a real channel, writes nothing
npm run smoke                      # render every screen once, catch mount errors
npm run triage-check               # grade the prompt against labelled fixtures
npm run classify-once              # one real classification against fixtures/
```

## Using it from Claude Code

`.claude/skills/kent/SKILL.md` teaches Claude Code how to drive Kent, so you can
just ask:

> "sync my Slack" · "what's due today?" · "why didn't Kent pick up Alex's message?"
> · "dry-run #team-marketing" · "draft a done reply for the pricing page task"

It knows never to poll the sync endpoint, and to ask before anything is posted to
Slack, approved or dismissed.

## Your data stays yours

Everything Kent learns about your Slack — messages, tasks, channels, colleagues,
your token — lives on your machine and is **gitignored**. Nothing in this
repository comes from a real workspace: the fixtures, tests and examples all use
invented names and IDs.

- **Slack token**: macOS Keychain (service `kent-slack`), or a `0600` file
  elsewhere. Never in the repo; the API returns only `xoxp-…1234`.
- **Everything else**: SQLite at `data/app.db`. `data/` and `*.db` are gitignored.
- **What reaches Claude**: only messages that already matched you. Everything else
  is discarded locally, before any model call. It goes the same way anything you
  paste into Claude Code does.
- **Slack permissions**: every scope is read-only except `chat:write`, used for one
  thing only — posting a reply you wrote and pressed Send on. Kent never posts
  automatically, and never edits or deletes anything in Slack. Leave that scope out
  and everything else still works.
- **The server** binds to `127.0.0.1`, checks the Host header and rejects
  cross-site requests, and has no login. Don't expose the port beyond loopback.

Full detail, including the trust model and how to report a vulnerability:
**[SECURITY.md](SECURITY.md)**.

## Contributing

Before opening a PR, run `npm test` (118 tests, no network and no model calls),
`npm run smoke` (renders every screen) and
`npm run triage-check`. If you touch `prompts/classify.md`, the triage score is the
thing to watch — it's what keeps Kent from becoming another noisy inbox.

## Licence

MIT — see [LICENSE](LICENSE).
