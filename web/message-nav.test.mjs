import { test } from 'node:test';
import assert from 'node:assert/strict';
import xterm from '@xterm/xterm';
import { MessageNav } from './dist/message-nav.js';
import { VERSION } from './dist/protocol.js';

const server = { protocol: VERSION, instance: 'fixture', dataDir: '/fixture', port: 1234 };
const write = (view, data) => new Promise(resolve => view.write(data, resolve));
// Wait for the replies of the fake server and for the search timer of the view.
const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setTimeout(resolve, 5)); };
const sent = (revision, text, created = '2026-11-23T10:10:00Z') => ({ revision, created, text, attachments: [], confirmed: true });

// A small fake DOM and a fake server. pages returns the page of sent messages for a
// request. The terminal is a real xterm.js terminal without a page.
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
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: 'result', result: pages(request) }) }));
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
  const nav = new MessageNav({ server: () => server, color: () => '#8bbcff', reveal() {}, list() {}, changed() {} });
  nav.attach(view);
  return { nav, view, nodes, requests };
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
