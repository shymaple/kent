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
  attachments: [{ url: 'https://example.slack.com/files/U1/F1/report.pdf', label: 'PDF · report.pdf', kind: 'file' }],
  description_html: 'Before <b>Thursday</b>',
  list_id: 1,
  position: 1,
  channel_id: 'C1',
  channel_name: 'eng',
  message_ts: '1700000000.000100',
  permalink: 'https://example.slack.com/archives/C1/p1700000000000100',
  assigner_name: 'Alex',
  comment_count: 2,
  replied_in_slack: true,
  can_reply: true,
  stale_days: 9,
  is_snoozed: false,
  is_broadcast: false,
};

const lists = [
  { id: 1, name: 'Open', semantic: 'backlog', position: 1 },
  { id: 2, name: 'Completed', semantic: 'done', position: 2 },
];

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

// The card preview must link back into Slack; that is the one thing people
// reach for most and it is easy to lose in a card rewrite.
const card = renderToString(<TaskCard task={task} onOpen={noop} onComplete={noop} />);
if (!card.includes(task.permalink) || !card.includes('Slack')) {
  failed++;
  console.error('  ✗ the card preview lost its Slack link');
} else {
  console.log('  ✓ card preview links to Slack');
}

// The modal titles the task once, in the header, and that header is editable.
const modalHtml = renderToString(
  <TaskModal task={task} lists={lists} onClose={noop} onSaved={noop} onDeleted={noop} onError={noop} />
);
// One editable title, in the header — not a header heading plus a Title field
// in the body, which is what it used to be.
const titleInputs = (modalHtml.match(/class="title-input"/g) || []).length;
const titleLabels = (modalHtml.match(/>Title</g) || []).length;
if (titleInputs !== 1 || titleLabels !== 0) {
  failed++;
  console.error(
    `  ✗ expected one editable header title and no Title field; found ${titleInputs} input(s), ${titleLabels} label(s)`
  );
} else {
  console.log('  ✓ modal has a single editable title in its header');
}
if (modalHtml.includes('>List<')) {
  failed++;
  console.error('  ✗ the list dropdown is back in the task modal');
} else {
  console.log('  ✓ no list dropdown in the modal');
}
// Opening a card must not drop straight into editing its title.
if (modalHtml.includes('autofocus') || modalHtml.includes('data-autofocus')) {
  failed++;
  console.error('  ✗ the task modal grabs focus into a field on open');
} else {
  console.log('  ✓ opening a card does not start editing the title');
}

// Slack is the most-used action, so it sits last in the header row.
const headMeta = modalHtml.slice(modalHtml.indexOf('head-meta'));
const slackAt = headMeta.indexOf('Slack');
const channelAt = headMeta.indexOf(task.channel_name);
if (slackAt === -1 || channelAt === -1 || slackAt < channelAt) {
  failed++;
  console.error('  ✗ the Slack link should come last in the header');
} else {
  console.log('  ✓ Slack link sits last in the header row');
}

if (modalHtml.includes('>Save<')) {
  failed++;
  console.error('  ✗ a Save button came back; fields are supposed to autosave');
} else {
  console.log('  ✓ no Save button — fields autosave');
}

// Finishing a task must never require a drag: on a narrow window the Completed
// column is off-screen, and before this the dialog had no way to close a task.
if (!modalHtml.includes('Mark done') || !card.includes('card-check')) {
  failed++;
  console.error('  ✗ a task can no longer be finished from its dialog or its card');
} else {
  console.log('  ✓ a task can be finished from the dialog and from the card');
}
if (!modalHtml.includes('Subtasks')) {
  failed++;
  console.error('  ✗ the task modal lost its subtasks');
} else {
  console.log('  ✓ the task modal lists subtasks');
}

// A finished task shows Reopen, not a second Mark done.
const doneHtml = renderToString(
  <TaskModal task={{ ...task, list_id: 2, is_done: true }} lists={lists} onClose={noop} onSaved={noop} onDeleted={noop} onError={noop} />
);
if (doneHtml.includes('Mark done') || !doneHtml.includes('Reopen')) {
  failed++;
  console.error('  ✗ a finished task should offer Reopen instead of Mark done');
} else {
  console.log('  ✓ a finished task offers Reopen');
}

// Uploaded files and written links are looked for separately, so they are
// listed separately - one merged "Attachments and links" block hid both.
if (!modalHtml.includes('>Attachments<') || !modalHtml.includes('>Links<') || modalHtml.includes('Attachments and links')) {
  failed++;
  console.error('  ✗ attachments and links should be two separate sections');
} else {
  console.log('  ✓ attachments and links are listed separately');
}
// The description is a formatted editor, and shows formatting that was saved.
if (!/contenteditable/i.test(modalHtml) || !modalHtml.includes('<b>Thursday</b>') || modalHtml.includes('<textarea id="task-desc"')) {
  failed++;
  console.error('  ✗ the description is no longer a rich-text editor');
} else {
  console.log('  ✓ the description is a rich-text editor');
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
