# Setting up Kent

Two things to do once: create a Slack app for yourself, and start the server.
Everything runs on your machine. Nothing is sent anywhere except Slack's API and
the Claude calls your own Claude Code login already makes.

---

## 1. Prerequisites

- **Node 20+** — `node --version`
- **Claude Code, logged in** — `claude --version`, then run `claude` once and sign in.
  Kent shells out to the `claude` CLI for classification. It does **not** use
  `ANTHROPIC_API_KEY` or any other provider key.

---

## 2. Create your Slack app (2 minutes)

> ### ⚠️ It must be `user:` scopes, not `bot:`
>
> This is the single most common way to get stuck. A **bot** token is a separate
> identity — Slack sees it as the app, not as you. With one:
>
> - **@mentions of you can't be detected.** `auth.test` returns the *bot's* member
>   ID, so Kent would watch for mentions of the bot.
> - **Your DMs are invisible.** A bot only sees DMs sent to the bot.
> - **Channels don't appear** unless you invite the bot to each one individually.
>
> A **user** token acts as you: it sees exactly the channels you're already in,
> your DMs included, with nothing to invite anywhere. Use `oauth_config.scopes.user`
> as written below, and copy the **User OAuth Token** (`xoxp-…`).

1. Go to <https://api.slack.com/apps> → **Create New App** → **From an app manifest**.
2. Pick your workspace.
3. Paste the manifest below — note the `user:` key under `scopes`.
4. Create the app → **Install to Workspace** → **Allow**.
5. On **OAuth & Permissions**, copy the **User OAuth Token**. It starts with `xoxp-`,
   and it's listed *above* the Bot token on that page.

```yaml
display_information:
  name: Kent task tracker
  description: Turns Slack asks addressed to me into local Kanban cards.
  background_color: "#1c1f26"
oauth_config:
  scopes:
    user:
      - channels:history
      - channels:read
      - groups:history
      - groups:read
      - im:history
      - im:read
      - mpim:history
      - mpim:read
      - users:read
      - team:read
      - chat:write
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

> **Changing scopes on an existing app?** Editing the manifest is not enough —
> you must **reinstall** the app afterwards, and copy the token again. Until you
> reinstall, the old token keeps its old scopes. Settings → **Re-check** will tell
> you exactly which scopes are still missing.

> **About `chat:write`** — this is the only write permission Kent holds, and it
> is used for exactly one thing: posting a reply you have written and pressed Send
> on into the thread of the message that created the task. Nothing is ever posted
> automatically. Leave the scope out if you don't want the feature; the rest of the
> app works without it and the reply button simply reports the missing scope.

> **If your workspace blocks app installs**, ask an admin to approve this app.
> Every other scope is read-only — Kent never edits or deletes anything in Slack.

---

## 3. Run it

```bash
npm install
npm run build      # builds the web UI
npm start          # http://localhost:4317
```

Open <http://localhost:4317>, go to **Settings**, and paste your `xoxp-` token.

On macOS the token goes into your login Keychain (`security` / service
`kent-slack`). Everywhere else it lands in `.slack-token` with `0600`
permissions — that file is gitignored.

### Verify Slack before anything else

```bash
npm run probe                  # identity + every channel you're in
npm run probe -- C0123ABCDEF   # + last 7 days of messages in one channel
```

---

## 4. Configure

In **Settings**:

- **Your names and keywords** — add your first name and any nickname colleagues
  use for you (e.g. "Alex", "al"). Catches asks where someone types your name
  instead of @-mentioning you. Keep them distinctive: a very common word will
  match half the workspace.
- **Priority people** — search for teammates. Anything from them is forced to
  **High**, regardless of what the message says.
- **Channels** — everything you're a member of is watched by default. Untick what
  you want ignored.
- **Sync** — how often to poll Slack (default 15 min), how far back to look on the
  first run (default 7 days), and which model to classify with.

Then hit **Sync now**. New asks land in **Inbox**; approve them into the board.

---

## 5. Keep it running at login (optional, macOS)

Save as `~/Library/LaunchAgents/com.kent.server.plist`, editing the two paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kent.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/kent/server/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/kent</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/Kent.log</string>
  <key>StandardErrorPath</key><string>/tmp/Kent.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.kent.server.plist
```

Use `which node` for the real node path. Note that a launchd process may not be
able to read the Keychain without you unlocking it once per login — if syncs fail
with `not_configured`, open the app and re-paste the token, or export
`SLACK_USER_TOKEN` in the plist instead.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Slack rejected that token: invalid_auth` | The app isn't installed, or the token was truncated on paste. Reinstall and copy the **User** OAuth token again. |
| Settings says "🤖 bot" next to the connection | You pasted a `xoxb-` token. See the warning at the top of step 2 — reinstall with `user:` scopes. |
| Channels and teammates lists are empty | Missing scopes. Settings → **Re-check** names the exact ones. Add them, **reinstall**, re-paste the token. |
| `missing_scope` in the sync log | Same as above — scope changes only apply after a reinstall. |
| `claude CLI failed` | Run `claude` in a terminal and sign in. Confirm with `npm run classify-once`. |
| Nothing appears after a sync | Check the Inbox tab, not the Board. Also confirm the channel isn't excluded in Settings. |
| Too much noise | Remove overly common aliases, exclude busy channels, or turn off `@channel` capture by dismissing broadcasts (dismissals are permanent per message). |
| Want to start clean | Stop the server and delete `data/app.db`. Cursors reset and the next sync backfills. |
