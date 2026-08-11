/**
 * Render smoke test for the client.
 *
 * The UI has no unit tests, so this is the safety net: it server-renders the
 * screens once and fails loudly on anything that stops them mounting — an
 * undefined variable, a bad import, a hook called wrongly, malformed JSX.
 * It does not test behaviour; drag, clicks and network all need a real browser.
 *
 *   npm run smoke
 */
import { renderToString } from 'react-dom/server';
import Board from './src/Board.jsx';
import Inbox from './src/Inbox.jsx';
import Settings from './src/Settings.jsx';
import TaskModal from './src/TaskModal.jsx';
import CommandBar from './src/CommandBar.jsx';
import TaskCard from './src/TaskCard.jsx';

const noop = () => {};
const settings = {
  show_completed: 'true',
  show_miscellaneous: 'true',
  sort_mode: 'smart',
  comment_templates: [],
};

const task = {
  id: 1,
  title: 'Review the deck',
  description: 'Before Thursday',
  priority: 'high',
  due_date: '2026-08-20',
  days_until_due: 3,
  category: 'review',
  links: [{ url: 'https://example.com', label: 'Doc' }],
  list_id: 1,
  position: 1,
  channel_id: 'C1',
  channel_name: 'eng',
  message_ts: '1700000000.000100',
  assigner_name: 'Alex',
  comment_count: 2,
  replied_in_slack: true,
  can_reply: true,
  stale_days: 9,
  is_snoozed: false,
  is_broadcast: false,
};

const lists = [{ id: 1, name: 'Open', semantic: 'backlog', position: 1 }];

const screens = [
  ['Board', <Board refreshKey={0} onError={noop} settings={settings} onSettings={noop} newTaskNonce={0} />],
  ['Inbox', <Inbox refreshKey={0} onError={noop} onChange={noop} />],
  ['Settings', <Settings onError={noop} onChange={noop} />],
  ['CommandBar', <CommandBar onPick={noop} onClose={noop} onError={noop} />],
  ['TaskModal', <TaskModal task={task} lists={lists} onClose={noop} onSaved={noop} onDeleted={noop} onError={noop} />],
  ['TaskCard', <TaskCard task={task} onOpen={noop} />],
  ['TaskCard (broadcast)', <TaskCard task={{ ...task, is_broadcast: true, priority: 'low' }} onOpen={noop} />],
];

let failed = 0;
for (const [name, element] of screens) {
  try {
    const html = renderToString(element);
    console.log(`  ✓ ${name.padEnd(22)} ${String(html.length).padStart(5)} chars`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

// A broadcast card must be visibly different, since that tint is the only thing
// marking it now that it sits among ordinary cards.
const plain = renderToString(<TaskCard task={task} onOpen={noop} />);
const broadcast = renderToString(<TaskCard task={{ ...task, is_broadcast: true }} onOpen={noop} />);
if (!broadcast.includes('misc') || plain.includes('misc')) {
  failed++;
  console.error('  ✗ broadcast cards are no longer visually distinct');
} else if (!broadcast.includes('channel-wide')) {
  failed++;
  console.error('  ✗ broadcast cards lost their explanatory label');
} else {
  console.log('  ✓ broadcast cards are tinted and labelled');
}

if (failed) {
  console.error(`\n${failed} screen(s) failed to render`);
  process.exit(1);
}
console.log('\nall screens render');
