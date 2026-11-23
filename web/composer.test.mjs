import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Composer } from './dist/composer.js';
import { VERSION } from './dist/protocol.js';

const server = { protocol: VERSION, instance: 'fixture', dataDir: '/fixture', port: 1234 };
const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setTimeout(resolve, 2)); };

// A small fake DOM and a fake server. The server saves each draft with the next
// revision. writeInput is the input write of the terminal connection.
async function fixture(t, writeInput) {
  class Node {
    hidden = false; disabled = false; textContent = ''; value = '';
    classList = { toggle() {} };
    focus() {}
    setSelectionRange() {}
    replaceChildren() {}
    querySelectorAll() { return []; }
  }
  const ids = ['composer', 'composer-text', 'composer-status', 'composer-files', 'composer-picker', 'composer-attach',
    'composer-submit', 'composer-review'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Node()]));
  let revision = 0;
  const saved = [], sockets = [];
  let rejection = null; // The reply to the next save, when the server rejects it.
  class Socket {
    readyState = 1;
    bufferedAmount = 0;
    constructor() { sockets.push(this); queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: 'server', server }) })); }
    reply(message) { queueMicrotask(() => { if (this.readyState === 1) this.onmessage({ data: JSON.stringify(message) }); }); }
    send(text) {
      const { request } = JSON.parse(text);
      if (!request) return;
      this.operation = request.operation;
      const empty = { revision, text: '', attachments: [], pending: false };
      if (request.operation === 'composer-watch') this.reply({ type: 'draft', session: request.session, composer: { draft: empty, attachments: [] } });
      if (request.operation !== 'composer-draft') return;
      if (rejection) {
        this.reply({ type: 'result', result: { ...rejection, rejected: true } });
        revision = rejection.draft.revision;
        rejection = null;
        return;
      }
      const draft = { ...request.draft, revision: ++revision };
      saved.push(draft);
      this.reply({ type: 'result', result: { draft, attachments: [] } });
    }
    close() { this.readyState = 3; }
    // The connection ends without a close from this page.
    drop() { this.readyState = 3; this.onclose(); }
  }
  const globals = { WebSocket: Socket, location: { host: 'localhost:1234' }, HTMLElement: Node, HTMLButtonElement: Node,
    HTMLTextAreaElement: Node, HTMLInputElement: Node, window: { addEventListener() {} },
    document: { getElementById: id => nodes[id], activeElement: null } };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
  let reports = 0;
  const writes = [];
  const peer = { active: true, writeInput: (data, id) => { writes.push(id); return writeInput(); } };
  const composer = new Composer({ server: () => server, peer: () => peer, bracketed: () => true, action: work => work(), sent: () => { reports++; } });
  await composer.select('one');
  // Close the draft watch, so that the test process can end.
  t.after(() => composer.select(''));
  composer.controls(false, true);
  const send = async text => {
    nodes['composer-text'].value = text;
    nodes['composer-text'].oninput();
    await nodes['composer-submit'].onclick();
    await settle();
  };
  const watch = () => sockets.findLast(socket => socket.operation === 'composer-watch');
  // advance adds draft revisions that another view saved.
  return { nodes, saved, writes, send, watch, reports: () => reports, advance: count => { revision += count; },
    reject: state => { rejection = state; } };
}

test('a send with a receipt reports one sent message after the draft is clear', async t => {
  const { nodes, saved, writes, send, reports } = await fixture(t, () => Promise.resolve());
  await send('Run the tests.');
  assert.deepEqual(saved.map(draft => [draft.text, draft.pending]), [['Run the tests.', false], ['Run the tests.', true], ['', false]]);
  assert.deepEqual(writes, ['draft-2'], 'the input ID names the pending revision');
  assert.equal(reports(), 1);
  assert.equal(nodes['composer-text'].value, '');
  assert.equal(nodes['composer-review'].hidden, true);
});

test('a send with a lost receipt keeps the pending draft and still reports the message', async t => {
  const { nodes, saved, send, reports } = await fixture(t, () => Promise.reject(new Error('Input delivery was not confirmed.')));
  await send('Run the tests.');
  // The archive has the pending revision. The list then shows the message as not confirmed.
  assert.deepEqual(saved.map(draft => [draft.text, draft.pending]), [['Run the tests.', false], ['Run the tests.', true]]);
  assert.equal(reports(), 1);
  assert.equal(nodes['composer-text'].value, 'Run the tests.');
  assert.equal(nodes['composer-review'].hidden, false, 'the user must check the terminal and unlock the draft');
  assert.equal(nodes['composer-status'].textContent, 'Input delivery was not confirmed.');
});

test('a message that the editor rejects before the pending save reports nothing', async t => {
  const { saved, writes, send, reports } = await fixture(t, () => Promise.resolve());
  await send('one\x07two');
  assert.deepEqual(saved.map(draft => draft.pending), [false]);
  assert.deepEqual(writes, []);
  assert.equal(reports(), 0);
});

// The draft of a send from another view: a clear draft with a newer revision.
const pushed = (revision, text = '') => ({ type: 'draft', session: 'one', composer: { draft: { revision, text, attachments: [], pending: false }, attachments: [] } });

test('a newer draft from a connected watch reports a possible send from another view', async t => {
  const { nodes, watch, reports } = await fixture(t, () => Promise.resolve());
  // The server keeps only the latest draft for a slow view. After a send from another
  // view, this view can get only the clear draft, without the pending draft before it.
  watch().reply(pushed(7));
  await settle();
  assert.equal(reports(), 1);
  // A draft that this view already has reports nothing.
  watch().reply(pushed(7));
  await settle();
  assert.equal(reports(), 1);
  // This view has an edit that is not saved yet. It keeps the edit and still reports.
  nodes['composer-text'].value = 'my edit';
  nodes['composer-text'].oninput();
  watch().reply(pushed(9, 'their next draft'));
  await settle();
  assert.equal(reports(), 2);
  assert.equal(nodes['composer-text'].value, 'my edit');
  // Wait for the save of the edit, so that the test ends with no open request.
  await new Promise(resolve => setTimeout(resolve, 450));
  await settle();
});

test('a draft watch that connects again reports a newer draft, and no report without one', async t => {
  const { watch, reports, advance } = await fixture(t, () => Promise.resolve());
  const first = watch();
  first.drop();
  await new Promise(resolve => setTimeout(resolve, 650));
  await settle();
  assert.notEqual(watch(), first, 'the watch connected again');
  assert.equal(reports(), 0, 'the draft has the same revision, so no view sent a message');
  // Another view sent a message while this watch was offline.
  const second = watch();
  second.drop();
  advance(2);
  await new Promise(resolve => setTimeout(resolve, 1200));
  await settle();
  assert.notEqual(watch(), second);
  assert.equal(reports(), 1);
});

test('a save that the server rejects reports the send from another view', async t => {
  const { nodes, watch, reports, reject } = await fixture(t, () => Promise.resolve());
  // Another view sent a message. The server rejects the save of this view and returns
  // the latest draft, which is clear.
  reject({ draft: { revision: 3, text: '', attachments: [], pending: false }, attachments: [] });
  nodes['composer-text'].value = 'my edit';
  nodes['composer-text'].oninput();
  await new Promise(resolve => setTimeout(resolve, 450));
  await settle();
  assert.equal(nodes['composer-status'].textContent, 'A message was sent from another view. Your last edit here was not saved.');
  assert.equal(nodes['composer-text'].value, '');
  assert.equal(reports(), 1);
  // The watch gives the same draft. This view has it, so it reports nothing more.
  watch().reply(pushed(3));
  await settle();
  assert.equal(reports(), 1);
});
