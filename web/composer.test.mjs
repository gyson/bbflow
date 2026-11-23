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
  const saved = [];
  class Socket {
    readyState = 1;
    bufferedAmount = 0;
    constructor() { queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: 'server', server }) })); }
    reply(message) { queueMicrotask(() => { if (this.readyState === 1) this.onmessage({ data: JSON.stringify(message) }); }); }
    send(text) {
      const { request } = JSON.parse(text);
      if (!request) return;
      const empty = { revision, text: '', attachments: [], pending: false };
      if (request.operation === 'composer-watch') this.reply({ type: 'draft', session: request.session, composer: { draft: empty, attachments: [] } });
      if (request.operation !== 'composer-draft') return;
      const draft = { ...request.draft, revision: ++revision };
      saved.push(draft);
      this.reply({ type: 'result', result: { draft, attachments: [] } });
    }
    close() { this.readyState = 3; }
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
  return { nodes, saved, writes, send, reports: () => reports };
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
