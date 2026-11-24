import { test } from 'node:test';
import assert from 'node:assert/strict';
import xterm from '@xterm/xterm';
import { MessageNav } from './dist/message-nav.js';
import { MessageJump } from './dist/message-jump.js';
import { VERSION } from './dist/protocol.js';

const server = { protocol: VERSION, instance: 'fixture', dataDir: '/fixture', port: 1234 };
const write = (view, data) => new Promise(resolve => view.write(data, resolve));
// Wait for the replies of the fake server and for the search timer of the view.
const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setTimeout(resolve, 5)); };
const sent = (revision, text, created = '2026-11-23T10:10:00Z') => ({ revision, created, text, attachments: [], confirmed: true });

// A small fake DOM and a fake server. pages returns the page of sent messages for a
// request, or an Error for a failed request. The terminal is a real xterm.js terminal
// without a page.
function fixture(t, pages) {
  class Node { hidden = false; disabled = false; textContent = ''; title = ''; }
  const ids = ['message-bar', 'message-open', 'message-previous', 'message-next', 'message-latest'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Node()]));
  const requests = [];
  class Socket {
    readyState = 1;
    bufferedAmount = 0;
    constructor() { queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: 'server', server }) })); }
    send(text) {
      const { request } = JSON.parse(text);
      requests.push(request);
      const reply = pages(request);
      const message = reply instanceof Error ? { type: 'error', error: reply.message } : { type: 'result', result: reply };
      queueMicrotask(() => this.onmessage({ data: JSON.stringify(message) }));
    }
    close() { this.readyState = 3; }
  }
  const globals = { WebSocket: Socket, location: { host: 'localhost:1234' }, HTMLElement: Node, HTMLButtonElement: Node,
    document: { getElementById: id => nodes[id] }, matchMedia: () => ({ matches: false }) };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
  const view = new xterm.Terminal({ cols: 40, rows: 5, scrollback: 20, allowProposedApi: true });
  t.after(() => view.dispose());
  let changes = 0;
  // moves counts the moves of the user. A test can set hooks.moved.
  const hooks = { moves: 0, moved() {} };
  const nav = new MessageNav({ server: () => server, color: () => '#8bbcff', reveal() {}, list() {}, changed() {}, sent() { changes++; },
    moved() { hooks.moves++; hooks.moved(); } });
  nav.attach(view);
  return { nav, view, nodes, requests, hooks, changes: () => changes };
}

const lines = (count, name = 'output') => Array.from({ length: count }, (_, index) => `${name} ${index}\r\n`).join('');
const top = view => view.buffer.active.viewportY;
const text = (view, row) => view.buffer.active.getLine(row).translateToString(true);

test('a step uses the new row of a message after the scrollback drops rows', async t => {
  const { nav, view } = fixture(t, () => ({ messages: [sent(2, 'second question'), sent(1, 'first question')], more: false }));
  // The buffer holds 25 rows. The messages are on rows 6 and 12, and row 24 has the cursor.
  await write(view, lines(6) + '> first question\r\n' + lines(5) + '> second question\r\n' + lines(11));
  nav.select('one');
  await settle();
  nav.step(-1);
  assert.equal(top(view), 12);
  // Two more rows drop the two oldest rows. The messages are now on rows 4 and 10.
  view.scrollToBottom();
  await write(view, lines(2, 'later'));
  nav.step(-1);
  assert.equal(top(view), 10);
  assert.equal(text(view, top(view)), '> second question');
  nav.step(-1);
  assert.equal(text(view, top(view)), '> first question');
  assert.equal(top(view), 4);
});

test('Earlier message turns on when the view moves from the first message into its response', async t => {
  const { nav, view, nodes } = fixture(t, () => ({ messages: [sent(1, 'first question')], more: false }));
  await write(view, lines(6) + '> first question\r\n' + lines(17));
  nav.select('one');
  await settle();
  view.scrollToLine(6);
  assert.match(nodes['message-open'].textContent, /^Message 1 of 1 · /);
  assert.equal(nodes['message-previous'].disabled, true);
  view.scrollToLine(7);
  assert.equal(nodes['message-previous'].disabled, false);
  view.scrollToLine(6);
  assert.equal(nodes['message-previous'].disabled, true);
  view.scrollToLine(2);
  assert.equal(nodes['message-open'].textContent, '1 sent message below');
  assert.deepEqual([nodes['message-previous'].disabled, nodes['message-next'].disabled, nodes['message-latest'].disabled], [true, false, false]);
});

test('an earlier terminal gets its message when a later terminal fills the newest page', async t => {
  // Revisions 2 to 21 are from the second terminal. Revision 1 is from the first.
  const later = Array.from({ length: 20 }, (_, index) => sent(21 - index, `later message ${21 - index}`, '2026-11-23T11:00:00Z'));
  const { nav, view, nodes, requests } = fixture(t, request => request.revision
    ? { messages: [sent(1, 'the message of terminal one')], more: false }
    : { messages: later, more: true });
  await write(view, lines(3) + '> the message of terminal one\r\n' + lines(2));
  nav.select('one');
  nav.window({ number: 1, run: 'a', tool: 'Demo agent', status: 'stopped', started: '2026-11-23T10:00:00Z', ended: '2026-11-23T10:30:00Z' });
  await settle();
  await settle();
  assert.deepEqual(requests.map(request => [request.operation, request.revision]), [['composer-sent', undefined], ['composer-sent', undefined], ['composer-sent', 2]]);
  assert.equal(nodes['message-open'].textContent, '1 sent message below');
  assert.equal(nav.state(1), 'found');
  assert.equal(nav.state(21), 'missing');
  assert.equal(nav.go(1), true);
  assert.match(nodes['message-open'].textContent, /^Message 1 of 1 · /);
});

test('a jump target near the end does not return after the view scrolls away and back', async t => {
  const { nav, view, nodes } = fixture(t, () => ({ messages: [sent(2, 'second question'), sent(1, 'first question')], more: false }));
  // The buffer has 14 rows and the view has 5. The lowest view position is row 9.
  await write(view, lines(3) + '> first question\r\n' + lines(8) + '> second question\r\n' + lines(1).trimEnd());
  nav.select('one');
  await settle();
  assert.equal(nav.go(2), true);
  assert.equal(top(view), 9, 'the row of the message cannot reach the top');
  assert.match(nodes['message-open'].textContent, /^Message 2 of 2 · /);
  view.scrollToLine(8);
  assert.match(nodes['message-open'].textContent, /^Message 1 of 2 · /);
  view.scrollToLine(9);
  assert.match(nodes['message-open'].textContent, /^Message 1 of 2 · /, 'the row of message 2 is below the top');
  assert.equal(nav.state(2), 'found');
  // The next step goes to the message below the top row.
  nav.step(1);
  assert.match(nodes['message-open'].textContent, /^Message 2 of 2 · /);
});

test('a reload reports a change only when the newest sent messages differ', async t => {
  let page = { messages: [sent(1, 'first question')], more: false };
  const { nav, view, nodes, requests, changes } = fixture(t, () => page);
  await write(view, '> first question\r\n' + lines(2) + '> second question\r\n' + lines(1).trimEnd());
  nav.select('one');
  await settle();
  assert.equal(changes(), 0, 'the first read reports nothing');
  // Another view saved a draft, but no message was sent.
  nav.reload();
  await settle();
  assert.equal(changes(), 0);
  // Another view sent a message. Its receipt is not saved yet.
  page = { messages: [{ ...sent(3, 'second question'), confirmed: false }, sent(1, 'first question')], more: false };
  nav.reload();
  nav.reload();
  nav.reload();
  await settle();
  assert.equal(changes(), 1);
  assert.equal(requests.length, 4, 'reloads during a read cause one more read');
  assert.equal(nav.state(3), 'found');
  // The receipt changes the status of the message in the list.
  page = { messages: [sent(3, 'second question'), sent(1, 'first question')], more: false };
  nav.reload();
  await settle();
  assert.equal(changes(), 2);
  // A change of the shown terminal reads the same page and reports nothing.
  nav.window({ number: 1, run: 'a', tool: 'Demo agent', status: 'running', started: '2026-11-23T10:00:00Z', ended: '' });
  await settle();
  assert.equal(changes(), 2);
  assert.match(nodes['message-open'].textContent, /^(Message \d of 2|2 sent messages below)/);
});

test('a detached view hides the bar, stops its search, and reads nothing more', async t => {
  const { nav, view, nodes, requests } = fixture(t, () => ({ messages: [sent(1, 'first question')], more: false }));
  await write(view, lines(2) + '> first question\r\n' + lines(1).trimEnd());
  nav.select('one');
  await settle();
  assert.equal(nav.state(1), 'found');
  assert.equal(nodes['message-bar'].hidden, false);
  // A frame and a reload are waiting when the host leaves the session and disposes the terminal.
  nav.rendered();
  nav.reload();
  nav.detach();
  view.dispose();
  await new Promise(resolve => setTimeout(resolve, 400));
  await settle();
  // The reload from before the detach reached the server. Its reply has no effect.
  const count = requests.length;
  assert.equal(nodes['message-bar'].hidden, true);
  assert.equal(nav.state(1), 'missing');
  nav.reload();
  nav.rendered();
  nav.step(-1);
  assert.equal(nav.go(1), false);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(requests.length, count, 'no request after the view left the session');
});

const earlier = { number: 1, run: 'a', tool: 'Demo agent', status: 'stopped', started: '2026-11-23T10:00:00Z', ended: '2026-11-23T10:30:00Z' };

test('a seek waits for the first frame of the opened terminal, then jumps to its message', async t => {
  const { nav, view, nodes } = fixture(t, () => ({ messages: [sent(2, 'later question', '2026-11-23T11:00:00Z'), sent(1, 'first question')], more: false }));
  nav.select('one');
  nav.window(earlier);
  let result;
  const seek = nav.seek(1).then(value => { result = value; });
  await settle();
  assert.equal(result, undefined, 'the terminal has drawn no frame yet');
  await write(view, lines(6) + '> first question\r\n' + lines(17));
  nav.rendered();
  await seek;
  assert.equal(result, 'found');
  assert.equal(top(view), 6);
  assert.match(nodes['message-open'].textContent, /^Message 1 of 1 · /);
});

test('a seek ends without a jump when the opened terminal does not show the message', async t => {
  const { nav, view } = fixture(t, () => ({ messages: [sent(1, 'first question')], more: false }));
  await write(view, lines(30));
  nav.select('one');
  nav.window(earlier);
  nav.rendered();
  view.scrollToLine(3);
  assert.equal(await nav.seek(1), 'missing');
  assert.equal(top(view), 3, 'the view stays where it was');
});

test('a change of the terminal or a step cancels a seek', async t => {
  const { nav, view } = fixture(t, () => ({ messages: [sent(1, 'first question')], more: false }));
  nav.select('one');
  nav.window(earlier);
  const first = nav.seek(1);
  nav.window({ ...earlier, number: 2, run: 'b', started: '2026-11-23T10:40:00Z', ended: '' });
  assert.equal(await first, 'cancelled');
  const second = nav.seek(1);
  nav.step(-1);
  assert.equal(await second, 'cancelled');
  // A later frame does not jump.
  await write(view, '> first question\r\n' + lines(20));
  nav.rendered();
  await settle();
  assert.notEqual(top(view), 0);
});

test('a seek reads a failed newest page again, and a failed read ends it without a later jump', async t => {
  let fail = true;
  const { nav, view, requests } = fixture(t, () => fail ? new Error('database is locked') : { messages: [sent(1, 'first question')], more: false });
  await write(view, lines(3) + '> first question\r\n' + lines(20));
  nav.select('one');
  nav.window(earlier);
  nav.rendered();
  await settle();
  // The read failed before the seek. The seek reads the newest page again.
  const count = requests.length;
  assert.equal(await nav.seek(1), 'failed');
  assert.equal(requests.length, count + 1);
  assert.match(nav.readError, /database is locked/);
  // A later read, for example after a draft change, does not complete the old click.
  const bottom = top(view);
  fail = false;
  nav.reload();
  await settle();
  assert.notEqual(nav.state(1), 'missing', 'the view found the message');
  assert.equal(top(view), bottom, 'the view did not jump');
  assert.equal(nav.readError, '');
  assert.equal(await nav.seek(1), 'found');
  assert.equal(top(view), 3);
});

test('a seek ends with failed when an older page of sent messages cannot be read', async t => {
  // The newest page has only messages of a later terminal. The message is older.
  const later = Array.from({ length: 20 }, (_, index) => sent(21 - index, `later message ${21 - index}`, '2026-11-23T11:00:00Z'));
  const { nav, view, requests } = fixture(t, request => request.revision ? new Error('older page failed') : { messages: later, more: true });
  await write(view, lines(3) + '> the message of terminal one\r\n' + lines(2));
  nav.select('one');
  nav.window(earlier);
  nav.rendered();
  assert.equal(await nav.seek(1), 'failed');
  assert.match(nav.readError, /older page failed/);
  assert.equal(requests.at(-1).revision, 2);
});

test('a jump, a step, and Latest output report a move of the user', async t => {
  const { nav, view, nodes, hooks } = fixture(t, () => ({ messages: [sent(2, 'second question'), sent(1, 'first question')], more: false }));
  await write(view, lines(3) + '> first question\r\n' + lines(8) + '> second question\r\n' + lines(12));
  nav.select('one');
  await settle();
  nav.go(1);
  nav.step(1);
  nodes['message-latest'].onclick();
  assert.ok(hooks.moves >= 3);
  // A seek jumps without a report, because the jump is not a move of the user.
  const moves = hooks.moves;
  view.scrollToBottom();
  assert.equal(await nav.seek(1), 'found');
  assert.equal(hooks.moves, moves);
});

test('a jump in the shown terminal stops a pending jump to another terminal', async t => {
  // A real MessageNav and a MessageJump, wired as app.ts wires them. The terminal list
  // read of the jump waits until the test releases it.
  const { nav, view, hooks } = fixture(t, () => ({ messages: [sent(1, 'first question')], more: false }));
  await write(view, lines(3) + '> first question\r\n' + lines(20));
  nav.select('one');
  nav.rendered();
  await settle();
  let release;
  const opened = [];
  const jump = new MessageJump({
    session: () => 'one', busy: () => false, opens: () => 0,
    loadTerminals: () => new Promise(done => { release = done; }),
    terminals: () => [{ number: 2, run: 'run-2', tool: 'Demo agent', status: 'stopped', started: '2026-11-23T11:00:00Z', ended: '2026-11-23T11:30:00Z' }],
    shownRun: () => 'run-1', reveal() {},
    async open(session, run) { opened.push(run); return 0; },
    seek: revision => nav.seek(revision), readError: () => nav.readError, failed() {},
  });
  hooks.moved = () => jump.cancel();
  // Show in terminal 2 on a message of terminal 2, then Show in terminal on a message of
  // the shown terminal.
  const remote = jump.show(9, { number: 2, run: 'run-2', tool: 'Demo agent', status: 'stopped', started: '2026-11-23T11:00:00Z', ended: '2026-11-23T11:30:00Z' });
  assert.equal(nav.go(1), true);
  assert.equal(top(view), 3);
  release();
  await remote;
  assert.deepEqual(opened, [], 'the older click does not open terminal 2');
  assert.equal(top(view), 3);
});
