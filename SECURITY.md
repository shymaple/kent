# Security

## What Kent holds, and where

| Thing | Where it lives | In the repo? |
| --- | --- | --- |
| Slack user token | macOS Keychain, service `kent-slack`. Elsewhere, `.slack-token` with `0600` | **No** — gitignored, and the API only ever returns `xoxp-…1234` |
| Your messages, tasks, channels, people | SQLite at `data/app.db` | **No** — `data/` and `*.db` are gitignored |
| Your settings, aliases, priority people | The same database | **No** |

Nothing in this repository is derived from a real workspace. The fixtures, tests
and examples use invented names and IDs. After you set Kent up, everything about
your Slack stays in `data/app.db` on your machine.

Before your first commit, confirm it for yourself:

```bash
git status --porcelain          # data/ and .slack-token must not appear
git check-ignore -v data/app.db # should print the matching .gitignore rule
```

## Trust model

Kent binds to `127.0.0.1` and has **no login**. Anything running as your user can
talk to it. That is the normal trade-off for a local single-user tool, and it is
worth knowing rather than assuming otherwise. Don't expose the port beyond
loopback — no reverse proxy, no `--host`, no port forwarding.

The browser-facing paths are closed:

- **Host allowlist** — requests are only served when addressed to `localhost`,
  `127.0.0.1` or `::1`. This blocks DNS rebinding, where an attacker's domain
  resolves to loopback so their page is treated as local.
- **Origin / Sec-Fetch-Site check** — cross-site requests are rejected. This
  blocks CSRF. It matters because `POST /api/comments/:id/send` posts to Slack
  and needs no request body, which makes it a CORS "simple request" that skips
  the preflight; without this check, any page you had open could have reached it.

Both are covered by tests in `server/security.test.js`.

## Slack permissions

Every scope Kent asks for is read-only except one:

- `chat:write` — used for a single action: posting a reply **you wrote and
  pressed Send on** into the thread of the message that created the task. Kent
  never posts on its own, and never edits or deletes anything in Slack.

Leave `chat:write` out of your app and everything else still works; the reply
button reports the missing scope.

Kent uses a **user** token, so it sees exactly the conversations you are already
in. It cannot see anything you cannot see.

## What is sent to the model

Kent shells out to your local `claude` CLI and uses your existing Claude Code
login. There is no API key and no other provider.

Only messages that already matched you — an @mention, a configured alias, a reply
in your thread, or an `@channel` broadcast — are ever sent. Everything else is
discarded locally, before any model call.

Slack message text is untrusted input in that prompt, so a message could try to
talk the model into something. The call runs with **no tools** (`--allowed-tools
""`) and **no MCP servers** (`--strict-mcp-config`), so there is nothing for an
injected instruction to reach. Output is schema-validated, and every result lands
in a triage Inbox you approve by hand. `--permission-mode bypassPermissions` is
deliberately not used.

## Reporting a problem

Open a GitHub issue for anything low-risk. For something exploitable, please
report it privately through GitHub's **Report a vulnerability** button on the
Security tab rather than in a public issue.
