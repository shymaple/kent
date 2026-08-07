import { useEffect, useState } from 'react';
import { api } from './api.js';

export default function Settings({ onError, onChange }) {
  const [settings, setSettings] = useState(null);
  const [channels, setChannels] = useState([]);
  const [priorityPeople, setPriorityPeople] = useState([]);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [peopleResults, setPeopleResults] = useState([]);
  const [token, setToken] = useState('');
  const [aliasDraft, setAliasDraft] = useState('');
  const [saved, setSaved] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [health, setHealth] = useState(null);
  const [connectError, setConnectError] = useState(null);
  const [channelQuery, setChannelQuery] = useState('');
  const [channelTab, setChannelTab] = useState('channel');   // channel | mpim | im
  const [channelView, setChannelView] = useState('all');     // all | watched | ignored
  const [templateDraft, setTemplateDraft] = useState('');
  const [toneBusy, setToneBusy] = useState(false);

  async function loadAll() {
    try {
      const s = await api.settings();
      setSettings(s);
      if (s.slack_connected) {
        setHealth(await api.diagnoseSlack());
        // These fail when scopes are missing; the diagnostics panel explains why,
        // so an empty list here is never left unexplained.
        try {
          setChannels(await api.channels());
          setPriorityPeople(await api.people());
        } catch {
          setChannels([]);
          setPriorityPeople([]);
        }
      } else {
        setHealth(null);
      }
    } catch (e) {
      onError(e.message);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  // Debounced people search - only fires once the user pauses typing.
  useEffect(() => {
    if (!peopleQuery.trim()) {
      setPeopleResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        setPeopleResults(await api.people(peopleQuery.trim()));
      } catch (e) {
        onError(e.message);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [peopleQuery, onError]);

  if (!settings) return <p className="empty">Loading…</p>;

  const patch = (p) => setSettings((s) => ({ ...s, ...p }));

  async function save(extra = {}) {
    try {
      await api.saveSettings({
        poll_interval_minutes: settings.poll_interval_minutes,
        backfill_days: settings.backfill_days,
        model: settings.model,
        timezone: settings.timezone,
        batch_size: settings.batch_size,
        auto_sync: settings.auto_sync,
        aliases: settings.aliases,
        slack_user_id_override: settings.slack_user_id_override ?? '',
        min_confidence: settings.min_confidence,
        ...extra,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      onError(e.message);
    }
  }

  async function connect() {
    setConnecting(true);
    setConnectError(null);
    try {
      const result = await api.connectSlack(token.trim());
      setToken('');
      setHealth(result.health);
      await loadAll();
      onChange();
    } catch (e) {
      setConnectError(e.message);
      onError(e.message);
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    await api.disconnectSlack();
    setChannels([]);
    setPriorityPeople([]);
    setHealth(null);
    setConnectError(null);
    await loadAll();
  }

  async function recheck() {
    try {
      setHealth(await api.diagnoseSlack());
      await loadAll();
    } catch (e) {
      onError(e.message);
    }
  }

  // Private channels sit with public ones - both are "channels" to a user.
  const KINDS = [
    { key: 'channel', label: 'Channels', match: (c) => c.kind === 'channel' || c.kind === 'private' },
    { key: 'mpim', label: 'Group DMs', match: (c) => c.kind === 'mpim' },
    { key: 'im', label: 'DMs', match: (c) => c.kind === 'im' },
  ];

  const inTab = channels.filter(KINDS.find((k) => k.key === channelTab).match);
  const query = channelQuery.trim().toLowerCase();
  const visibleChannels = inTab
    .filter((c) => (query ? c.name.toLowerCase().includes(query) : true))
    .filter((c) =>
      channelView === 'watched' ? !c.is_excluded : channelView === 'ignored' ? c.is_excluded : true
    );

  /** Apply one state to everything currently listed. Named by effect, not by tick. */
  async function setAllExcluded(list, excluded) {
    const changed = list.filter((c) => Boolean(c.is_excluded) !== excluded);
    if (!changed.length) return;
    const ids = new Set(changed.map((c) => c.id));
    setChannels((prev) => prev.map((c) => (ids.has(c.id) ? { ...c, is_excluded: excluded } : c)));
    try {
      await Promise.all(changed.map((c) => api.setChannelExcluded(c.id, excluded)));
    } catch (e) {
      onError(e.message);
      loadAll();
    }
  }

  async function toggleChannel(channel) {
    const next = !channel.is_excluded;
    setChannels((prev) => prev.map((c) => (c.id === channel.id ? { ...c, is_excluded: next } : c)));
    try {
      await api.setChannelExcluded(channel.id, next);
    } catch (e) {
      onError(e.message);
      loadAll();
    }
  }

  async function togglePerson(person, isPriority) {
    try {
      await api.setPriorityPerson(person.slack_user_id, isPriority);
      setPriorityPeople(await api.people());
      if (peopleQuery.trim()) setPeopleResults(await api.people(peopleQuery.trim()));
    } catch (e) {
      onError(e.message);
    }
  }

  function addAlias() {
    const value = aliasDraft.trim();
    if (!value || settings.aliases.includes(value)) return setAliasDraft('');
    const aliases = [...settings.aliases, value];
    patch({ aliases });
    setAliasDraft('');
    save({ aliases });
  }

  function removeAlias(value) {
    const aliases = settings.aliases.filter((a) => a !== value);
    patch({ aliases });
    save({ aliases });
  }

  return (
    <div className="settings">
      {/* ----------------------------------------------------------- Slack */}
      <section className="panel">
        <h2>Slack connection</h2>
        <p className="hint">
          A user token (<code>xoxp-…</code>) sees exactly the channels you're already in — no bot to
          invite anywhere. See <code>SETUP.md</code> for the 2-minute app setup. The token is stored in
          your macOS Keychain, never in this project.
        </p>

        {settings.slack_connected ? (
          <>
            <div className="row">
              <span className={`chip ${health?.ok ? 'low' : 'high'}`}>
                {health?.ok ? 'Connected' : 'Connected — needs attention'}
              </span>
              <span className="chip">{settings.slack_token_masked}</span>
              {health?.identity && (
                <span className="chip">
                  {health.tokenType === 'bot' ? '🤖 bot: ' : ''}
                  {health.identity.user} · {health.identity.team}
                </span>
              )}
              <span className="chip">{channels.length} conversations</span>
              <div style={{ flex: 1 }} />
              <button onClick={recheck}>Re-check</button>
              <button
                onClick={async () => {
                  try {
                    await api.refreshChannels();
                  } catch (e) {
                    onError(e.message);
                  }
                  loadAll();
                }}
              >
                Refresh list
              </button>
              <button className="ghost" onClick={disconnect}>
                Disconnect
              </button>
            </div>

            {health?.problems?.length > 0 && (
              <div className="problems">
                <strong>Slack isn't set up correctly yet:</strong>
                <ul>
                  {health.problems.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
                <p className="hint" style={{ margin: '6px 0 0' }}>
                  Fix these in <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">your Slack app</a>,
                  reinstall it, paste the new token here, then hit Re-check. Scope changes only take
                  effect on reinstall.
                </p>
              </div>
            )}

            {health?.tokenType === 'bot' && (
              <div className="field" style={{ marginTop: 12 }}>
                <label>Your own Slack member ID (needed with a bot token)</label>
                <div className="row">
                  <input
                    placeholder="U01ABC23DEF"
                    value={settings.slack_user_id_override ?? ''}
                    onChange={(e) => patch({ slack_user_id_override: e.target.value })}
                  />
                  <button onClick={() => save()}>Save</button>
                </div>
                <p className="hint" style={{ margin: '6px 0 0' }}>
                  Slack sees a bot token as the bot, so mention detection would watch for the bot
                  instead of you. Find yours in Slack: your profile → ⋮ → Copy member ID.
                </p>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="row">
              <input
                type="password"
                placeholder="xoxp-…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && connect()}
              />
              <button className="primary" onClick={connect} disabled={!token.trim() || connecting}>
                {connecting ? 'Checking…' : 'Connect'}
              </button>
            </div>
            {connectError && <div className="problems">{connectError}</div>}
            {token.trim().startsWith('xoxb-') && (
              <div className="problems">
                That's a <strong>bot</strong> token. Kent needs the <strong>User</strong> OAuth
                Token (<code>xoxp-…</code>) — a bot token can't see @mentions of you or your DMs.
              </div>
            )}
          </>
        )}
      </section>

      {/* --------------------------------------------------------- aliases */}
      <section className="panel">
        <h2>Your names and keywords</h2>
        <p className="hint">
          Catches messages where someone types your name instead of @-mentioning you. Matched
          case-insensitively on word boundaries, ignoring code blocks and link URLs.
        </p>
        <div className="tag-input">
          {settings.aliases.map((a) => (
            <span className="tag" key={a}>
              {a}
              <button onClick={() => removeAlias(a)} aria-label={`Remove ${a}`}>
                ×
              </button>
            </span>
          ))}
          <input
            style={{ width: 180 }}
            placeholder="Add a name…"
            value={aliasDraft}
            onChange={(e) => setAliasDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addAlias()}
            onBlur={addAlias}
          />
        </div>
      </section>

      {/* ---------------------------------------------------- priority people */}
      <section className="panel">
        <h2>Priority people</h2>
        <p className="hint">
          Anything from these people is marked <strong>High</strong> automatically, whatever the
          message says.
        </p>

        {priorityPeople.length > 0 && (
          <div className="list" style={{ marginBottom: 10 }}>
            {priorityPeople.map((p) => (
              <div className="list-row" key={p.slack_user_id}>
                <input type="checkbox" checked readOnly onChange={() => togglePerson(p, false)} />
                <span>{p.display_name}</span>
                <span className="kind">{p.real_name}</span>
                <button className="ghost small" onClick={() => togglePerson(p, false)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        <input
          placeholder={settings.slack_connected ? 'Search teammates…' : 'Connect Slack first'}
          disabled={!settings.slack_connected}
          value={peopleQuery}
          onChange={(e) => setPeopleQuery(e.target.value)}
        />
        {settings.slack_connected && health?.missingScopes?.includes('users:read') && (
          <p className="hint" style={{ marginTop: 8 }}>
            Teammate search needs the <code>users:read</code> scope — see the problems above.
          </p>
        )}
        {peopleQuery.trim() && peopleResults.length === 0 && !health?.missingScopes?.includes('users:read') && (
          <p className="hint" style={{ marginTop: 8 }}>No teammate matches “{peopleQuery}”.</p>
        )}
        {peopleResults.length > 0 && (
          <div className="list" style={{ marginTop: 8 }}>
            {peopleResults.slice(0, 30).map((p) => (
              <div className="list-row" key={p.slack_user_id}>
                <input
                  type="checkbox"
                  checked={p.is_priority}
                  onChange={(e) => togglePerson(p, e.target.checked)}
                />
                <span>{p.display_name}</span>
                <span className="kind">{p.real_name}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* -------------------------------------------------------- channels */}
      <section className="panel">
        <h2>Conversations</h2>
        <p className="hint">
          Everything you're a member of is watched by default. A message only becomes a task if it
          @mentions you, uses one of your names, replies in your thread, or is a channel-wide
          broadcast — that applies to DMs too, so ordinary chat never reaches the model.
        </p>
        {channels.length > 0 && (
          <>
            <div className="subtabs">
              {KINDS.map((k) => {
                const all = channels.filter(k.match);
                return (
                  <button
                    key={k.key}
                    className={`subtab ${channelTab === k.key ? 'active' : ''}`}
                    onClick={() => setChannelTab(k.key)}
                  >
                    {k.label}
                    <span className="count">
                      {all.filter((c) => !c.is_excluded).length}/{all.length}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="row" style={{ marginBottom: 10 }}>
              <input
                placeholder={`Search ${inTab.length} conversation${inTab.length === 1 ? '' : 's'}…`}
                value={channelQuery}
                onChange={(e) => setChannelQuery(e.target.value)}
              />
              <select
                value={channelView}
                onChange={(e) => setChannelView(e.target.value)}
                style={{ width: 'auto', flex: '0 0 auto' }}
                aria-label="Show"
              >
                <option value="all">Show all</option>
                <option value="watched">Show watched</option>
                <option value="ignored">Show ignored</option>
              </select>
            </div>

            <div className="row" style={{ marginBottom: 10 }}>
              <span className="hint" style={{ margin: 0 }}>
                {visibleChannels.length} shown
              </span>
              <div style={{ flex: 1 }} />
              <button onClick={() => setAllExcluded(visibleChannels, false)}>Watch all shown</button>
              <button onClick={() => setAllExcluded(visibleChannels, true)}>Ignore all shown</button>
            </div>
          </>
        )}

        {channels.length === 0 ? (
          <p className="empty">
            {!settings.slack_connected
              ? 'Connect Slack to see your channels.'
              : health?.missingScopes?.length
                ? `Slack won't list your channels without the ${health.missingScopes.join(', ')} scope(s). See the problems above.`
                : 'No channels found. Hit Refresh list.'}
          </p>
        ) : (
          <div className="list">
            {visibleChannels.length === 0 ? (
              <div className="list-row">
                <span className="kind" style={{ marginLeft: 0 }}>
                  {channelQuery.trim()
                    ? `No conversation matches “${channelQuery}”.`
                    : `Nothing ${channelView === 'all' ? 'here' : channelView} in this tab.`}
                </span>
              </div>
            ) : (
              visibleChannels.map((c) => (
                <label className={`list-row ${c.is_excluded ? 'excluded' : ''}`} key={c.id}>
                  <input type="checkbox" checked={!c.is_excluded} onChange={() => toggleChannel(c)} />
                  <span>{c.kind === 'channel' ? `#${c.name}` : c.name}</span>
                  <span className="kind">{c.kind}</span>
                </label>
              ))
            )}
          </div>
        )}
      </section>

      {/* ------------------------------------------------- replies & comments */}
      <section className="panel">
        <h2>Replies and comments</h2>
        <p className="hint">
          Comments are logged on the card, and can be posted straight into the original Slack thread
          as you — but never without you pressing Send. Posting needs the <code>chat:write</code>{' '}
          user scope; add it to your app, reinstall, and re-paste the token.
        </p>

        <div className="field">
          <label>Writing style</label>
          {settings.tone_note ? (
            <>
              <div className="source-quote" style={{ margin: '0 0 8px' }}>{settings.tone_note}</div>
              <div className="row">
                <button
                  disabled={toneBusy}
                  onClick={async () => {
                    setToneBusy(true);
                    try {
                      const r = await api.learnTone();
                      patch({ tone_note: r.tone_note });
                    } catch (e) {
                      onError(e.message);
                    } finally {
                      setToneBusy(false);
                    }
                  }}
                >
                  {toneBusy ? 'Reading your messages…' : 'Re-learn'}
                </button>
                <button
                  className="ghost"
                  onClick={async () => {
                    await api.forgetTone();
                    patch({ tone_note: '' });
                  }}
                >
                  Forget
                </button>
              </div>
            </>
          ) : (
            <div className="row">
              <button
                disabled={toneBusy || !settings.slack_connected}
                onClick={async () => {
                  setToneBusy(true);
                  try {
                    const r = await api.learnTone();
                    patch({ tone_note: r.tone_note });
                  } catch (e) {
                    onError(e.message);
                  } finally {
                    setToneBusy(false);
                  }
                }}
              >
                {toneBusy ? 'Reading your messages…' : 'Learn from my Slack messages'}
              </button>
              <span className="hint" style={{ margin: 0 }}>
                One model call. Drafts then sound like you.
              </span>
            </div>
          )}
        </div>

        <div className="field">
          <label>Saved replies</label>
          <div className="tag-input">
            {(settings.comment_templates ?? []).map((t) => (
              <span className="tag" key={t}>
                {t}
                <button
                  aria-label={`Remove ${t}`}
                  onClick={() => {
                    const comment_templates = settings.comment_templates.filter((x) => x !== t);
                    patch({ comment_templates });
                    save({ comment_templates });
                  }}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              style={{ width: 220 }}
              placeholder="e.g. Done, please review"
              value={templateDraft}
              onChange={(e) => setTemplateDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                const v = templateDraft.trim();
                if (!v || (settings.comment_templates ?? []).includes(v)) return setTemplateDraft('');
                const comment_templates = [...(settings.comment_templates ?? []), v];
                patch({ comment_templates });
                save({ comment_templates });
                setTemplateDraft('');
              }}
            />
          </div>
          <p className="hint" style={{ marginTop: 6 }}>
            One-click replies that cost no model call at all.
          </p>
        </div>
      </section>

      {/* ------------------------------------------------------ sync config */}
      <section className="panel">
        <h2>Sync</h2>
        <p className="hint">
          Slack is polled on this interval by plain code. The model is only called when new messages
          actually match you — a quiet interval costs nothing.
        </p>

        <div className="field-row">
          <div>
            <label>Check every (minutes)</label>
            <input
              type="number"
              min="1"
              value={settings.poll_interval_minutes}
              onChange={(e) => patch({ poll_interval_minutes: e.target.value })}
            />
          </div>
          <div>
            <label>On a new channel, look back</label>
            <select
              value={settings.backfill_days}
              onChange={(e) => patch({ backfill_days: e.target.value })}
            >
              <option value="0">Nothing — only new messages (recommended)</option>
              <option value="1">1 day</option>
              <option value="3">3 days</option>
              <option value="7">7 days</option>
            </select>
          </div>
          <div>
            <label>Messages per model call</label>
            <input
              type="number"
              min="1"
              max="40"
              value={settings.batch_size}
              onChange={(e) => patch({ batch_size: e.target.value })}
            />
          </div>
        </div>

        <div className="field-row">
          <div>
            <label>Model</label>
            <select value={settings.model} onChange={(e) => patch({ model: e.target.value })}>
              <option value="claude-sonnet-5">Sonnet 5 (recommended)</option>
              <option value="claude-opus-5">Opus 5</option>
              <option value="claude-haiku-4-5-20251001">Haiku 4.5 (cheapest)</option>
            </select>
          </div>
          <div>
            <label>Timezone</label>
            <input value={settings.timezone} onChange={(e) => patch({ timezone: e.target.value })} />
          </div>
          <div>
            <label>Strictness</label>
            <select
              value={settings.min_confidence}
              onChange={(e) => patch({ min_confidence: e.target.value })}
            >
              <option value="0.3">Loose — show anything that might be a task</option>
              <option value="0.5">Balanced (recommended)</option>
              <option value="0.7">Strict — only clear, unambiguous asks</option>
            </select>
          </div>
          <div>
            <label>Background sync</label>
            <select value={settings.auto_sync} onChange={(e) => patch({ auto_sync: e.target.value })}>
              <option value="true">On</option>
              <option value="false">Off — manual only</option>
            </select>
          </div>
        </div>

        <div className="row end">
          {saved && <span className="chip low">Saved</span>}
          <button className="primary" onClick={() => save()}>
            Save settings
          </button>
        </div>
      </section>
    </div>
  );
}
