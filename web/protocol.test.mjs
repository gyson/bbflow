import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, Peer, VERSION, encodeBytes, decodeBytes } from './dist/protocol.js';
import { composeInput, sendShortcut } from './dist/composer.js';

class Socket {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; }
  receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
}
const server = { protocol: VERSION, instance: 'instance', dataDir: '/test', port: 1234 };
const request = { operation: 'session-resume', session: 'one', size: { rows: 24, cols: 80 } };

test('UTF-8, binary control bytes, and large paste round-trip without loss', () => {
  const bytes = new Uint8Array([...new TextEncoder().encode('你好\r\u001b[200~paste\u001b[201~'), 0, 255, 3]);
  assert.deepEqual(decodeBytes(encodeBytes(bytes)), bytes);
  const large = new Uint8Array(100000).fill(255);
  assert.deepEqual(decodeBytes(encodeBytes(large)), large);
});

test('verify identity before sending any request', () => {
  for (const field of ['protocol', 'instance', 'dataDir', 'port']) {
    let error;
    const peer = new Peer(server, request, { error: e => { error = e; } }, Socket, 'localhost:1234');
    peer.socket.receive({ type: 'server', server: { ...server, [field]: 'wrong' } });
    assert.equal(peer.socket.sent.length, 0);
    assert.match(error.message, field === 'instance' ? /bbflow restarted/ : /server changed/);
    assert.equal(peer.socket.readyState, 3);
  }
});

test('every active view can send input and leaves by closing its connection', () => {
  const peer = new Peer(server, request, {}, Socket, 'localhost:1234');
  peer.socket.receive({ type: 'server', server });
  assert.equal(peer.send({ type: 'input', data: 'eA==' }), false);
  peer.socket.receive({ type: 'session', session: 'one', active: true });
  assert.equal(peer.send({ type: 'input', data: 'eA==' }), true);
  assert.equal(peer.send({ type: 'signal', signal: 2 }), true);
  assert.equal(peer.send({ type: 'resize', size: { rows: 24, cols: 80 } }), true);
  const sent = peer.socket.sent.length;
  peer.close();
  assert.equal(peer.send({ type: 'input', data: 'eQ==' }), false);
  assert.equal(peer.socket.sent.length, sent);
  assert.equal(peer.socket.readyState, 3);
});

test('lost connection reports uncertain delivery without sending again', () => {
  const errors = [];
  const peer = new Peer(server, request, { error: e => errors.push(e) }, Socket, 'localhost:1234');
  peer.socket.receive({ type: 'server', server });
  peer.socket.receive({ type: 'session', active: true });
  peer.send({ type: 'input', data: 'eA==' });
  peer.socket.onclose();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Input was not resent/);
  assert.equal(peer.socket.sent.length, 2);
  assert.equal(peer.active, false);
  assert.equal(errors[0].fromServer, false);
});

test('an error reply from the server is marked apart from a transport failure', () => {
  const errors = [];
  const peer = new Peer(server, request, { error: e => errors.push(e) }, Socket, 'localhost:1234');
  peer.socket.receive({ type: 'server', server });
  peer.socket.receive({ type: 'error', error: 'invalid value' });
  assert.equal(errors[0].message, 'invalid value');
  assert.equal(errors[0].fromServer, true);
  assert.equal(errors[0].retryable, false);
});

test('ended-session replay remains read-only and closes without a loss warning', () => {
  const errors = [];
  const peer = new Peer(server, request, { error: e => errors.push(e) }, Socket, 'localhost:1234');
  peer.socket.receive({ type: 'server', server });
  peer.socket.receive({ type: 'session', session: 'one', status: 'exited' });
  assert.equal(peer.send({ type: 'input', data: 'eA==' }), false);
  peer.socket.receive({ type: 'history-end' });
  peer.socket.onclose();
  assert.deepEqual(errors, []);
});

test('slow network detaches without queueing more input', () => {
  let error;
  const messages = [];
  const peer = new Peer(server, request, { error: e => { error = e; }, message: m => messages.push(m) }, Socket, 'localhost:1234');
  peer.socket.receive({ type: 'server', server });
  peer.socket.receive({ type: 'session', active: true });
  peer.socket.bufferedAmount = 2 * 1024 * 1024;
  assert.equal(peer.send({ type: 'input', data: 'eA==' }), false);
  assert.match(error.message, /Some input may have been delivered/);
  assert.equal(peer.socket.sent.length, 1);
  assert.equal(peer.socket.readyState, 3);
  peer.socket.receive({ type: 'frame', revision: 1, full: true, size: { cols: 80, rows: 24 }, data: 'eA==' });
  assert.equal(messages.length, 1); // Drop events queued after failure or closure.
});

test('composer preserves multiline Unicode as one paste followed by Enter', () => {
  assert.equal(composeInput('fix café\r\nsecond\tline', [], true), '\x1b[200~fix café\rsecond\tline\x1b[201~\r');
  assert.equal(composeInput('single line', [], false), 'single line\r');
  assert.throws(() => composeInput('first\nsecond', [], false), /bracketed paste/);
  assert.throws(() => composeInput('tab\there', [], false), /bracketed paste/);
  assert.throws(() => composeInput('escape\x1b[201~bad', [], true), /control characters/);
  assert.throws(() => composeInput('', [], true), /Write a message/);
  assert.throws(() => composeInput('é'.repeat(33000), [], true), /64 KiB/);
});

test('composer references files with quoted paths, preserving shell metacharacters', () => {
  const files = [{ path: "/cache/a'b $(echo hello).txt" }];
  assert.equal(composeInput('Read this', files, true), "\x1b[200~Read this\r\r'/cache/a'\\''b $(echo hello).txt'\x1b[201~\r");
  assert.throws(() => composeInput('Read this', files, false), /bracketed paste/);
  assert.throws(() => composeInput('', [{ path: '/cache/unsafe\x1bpath' }], true), /control characters/);
});

test('Command-Enter or Ctrl+Enter sends, and plain Enter adds a line', () => {
  const key = (options) => ({ key: 'Enter', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...options });
  assert.equal(sendShortcut(key({ metaKey: true })), true);
  assert.equal(sendShortcut(key({ ctrlKey: true })), true);
  assert.equal(sendShortcut(key({})), false, 'plain Enter');
  assert.equal(sendShortcut(key({ metaKey: true, shiftKey: true })), false, 'Shift');
  assert.equal(sendShortcut(key({ ctrlKey: true, altKey: true })), false, 'Alt');
  assert.equal(sendShortcut(key({ metaKey: true, isComposing: true })), false, 'input method composition');
  assert.equal(sendShortcut(key({ key: 'a', metaKey: true })), false, 'another key');
});

test('input receipt is correlated and disconnect or exit never retries a submission', async () => {
  for (const outcome of ['receipt', 'error-receipt', 'disconnect', 'exit', 'close']) {
    const peer = new Peer(server, request, {}, Socket, 'localhost:1234');
    peer.socket.receive({ type: 'server', server });
    peer.socket.receive({ type: 'session', active: true });
    let settled = false;
    const sent = peer.writeInput('eA==', 'receipt-1').then(() => { settled = true; });
    const failed = outcome === 'receipt' ? null : assert.rejects(sent, /delivery|write failed/);
    peer.socket.receive({ type: 'input-ack', id: 'other-receipt' });
    await Promise.resolve();
    assert.equal(settled, false);
    await assert.rejects(peer.writeInput('eQ==', 'receipt-2'), /already in progress/);
    if (outcome === 'receipt') {
      peer.socket.receive({ type: 'input-ack', id: 'receipt-1' });
      await sent;
    } else if (outcome === 'error-receipt') {
      peer.socket.receive({ type: 'input-ack', id: 'receipt-1', error: 'write failed' });
    } else if (outcome === 'disconnect') peer.socket.onclose();
    else if (outcome === 'exit') peer.socket.receive({ type: 'exit' });
    else peer.close();
    if (failed) await failed;
    assert.equal(peer.socket.sent.length, 2);
    assert.deepEqual(peer.socket.sent[1], { type: 'input', id: 'receipt-1', data: 'eA==' });
    peer.close();
  }
});

test('read-only history acknowledges rendered frames without allowing input', () => {
  const peer = new Peer(server, request, {}, Socket, 'localhost:1234');
  peer.acknowledgeFrame(1);
  assert.equal(peer.socket.sent.length, 0);
  peer.socket.receive({ type: 'server', server });
  peer.socket.receive({ type: 'session', session: 'one', status: 'stopped' });
  peer.socket.receive({ type: 'frame', revision: 1, full: true, size: { cols: 80, rows: 24 } });
  assert.equal(peer.send({ type: 'input', data: 'eA==' }), false);
  peer.acknowledgeFrame(1);
  assert.deepEqual(peer.socket.sent.at(-1), { type: 'frame-ack', revision: 1 });
  peer.socket.receive({ type: 'history-end' });
  peer.acknowledgeFrame(1);
  assert.equal(peer.socket.sent.length, 2);
  peer.close();
});

test('canceling a history RPC closes its socket and rejects the pending request', async () => {
  const sockets = [];
  const originalSocket = globalThis.WebSocket, originalLocation = globalThis.location;
  globalThis.WebSocket = class extends Socket { constructor() { super(); sockets.push(this); } };
  globalThis.location = { host: 'localhost:1234' };
  try {
    const controller = new AbortController();
    const result = call(server, { operation: 'history-search', search: { query: 'needle', scope: 'all', matchCase: false } }, controller.signal);
    sockets[0].receive({ type: 'server', server });
    const rejected = assert.rejects(result, { name: 'AbortError' });
    controller.abort();
    await rejected;
    assert.equal(sockets[0].readyState, 3);
    await assert.rejects(call(server, { operation: 'history-context', context: {} }, controller.signal), { name: 'AbortError' });
    assert.equal(sockets.length, 1);
  } finally {
    globalThis.WebSocket = originalSocket;
    globalThis.location = originalLocation;
  }
});

test('a title test waits longer than the server limit, and other requests keep their limit', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const errors = { title: [], list: [] };
  const title = new Peer(server, { operation: 'title-test', settings: { titleTool: 'claude' } }, { error: e => errors.title.push(e) }, Socket, 'localhost:1234');
  const list = new Peer(server, { operation: 'session-list', groups: [''] }, { error: e => errors.list.push(e) }, Socket, 'localhost:1234');
  title.socket.receive({ type: 'server', server });
  list.socket.receive({ type: 'server', server });
  t.mock.timers.tick(13000);
  assert.equal(errors.list.length, 1);
  assert.match(errors.list[0].message, /timed out/);
  // The server stops a title tool after 90 seconds and then replies.
  t.mock.timers.tick(80000);
  assert.equal(errors.title.length, 0);
  let result;
  title.handlers.message = message => { result = message.result; };
  title.socket.receive({ type: 'result', result: { title: 'Fix it' } });
  assert.deepEqual(result, { title: 'Fix it' });
  assert.equal(errors.title.length, 0);
});

for (const operation of ['title-test', 'title-tool-set']) {
  test(`a ${operation} request without a reply times out after the title test limit`, t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const errors = [];
    const peer = new Peer(server, { operation, settings: { titleTool: 'codex' } }, { error: e => errors.push(e) }, Socket, 'localhost:1234');
    peer.socket.receive({ type: 'server', server });
    t.mock.timers.tick(99000);
    assert.equal(errors.length, 0);
    t.mock.timers.tick(2000);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /timed out/);
  });
}

test('running statuses keep a slow session start open until its session message', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const errors = [];
  const messages = [];
  const start = { operation: 'session-start', session: 'one', revision: 1, size: { rows: 24, cols: 80 } };
  const peer = new Peer(server, start, { error: e => errors.push(e), message: m => messages.push(m.type) }, Socket, 'localhost:1234');
  peer.socket.receive({ type: 'server', server });
  // The server fetches the base and creates the worktree for 30 seconds.
  for (let elapsed = 0; elapsed < 30000; elapsed += 5000) {
    t.mock.timers.tick(5000);
    peer.socket.receive({ type: 'status', status: 'running' });
  }
  assert.equal(errors.length, 0);
  peer.socket.receive({ type: 'session', session: 'one', active: true, notice: 'Could not fetch origin/main.' });
  assert.equal(peer.active, true);
  assert.deepEqual(messages.at(-1), 'session');
  // Without statuses, the same start times out.
  const silent = new Peer(server, start, { error: e => errors.push(e) }, Socket, 'localhost:1234');
  silent.socket.receive({ type: 'server', server });
  t.mock.timers.tick(13000);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /timed out/);
});

test('an HTTPS page connects with wss, and an HTTP page with ws', () => {
  const original = globalThis.location;
  const urls = [];
  class Recording extends Socket { constructor(url) { super(); urls.push(url); } }
  try {
    // Remote access through an HTTPS proxy. A browser blocks ws:// on such a page.
    globalThis.location = { host: 'my-mac.example.ts.net', protocol: 'https:' };
    new Peer(server, request, {}, Recording).close();
    globalThis.location = { host: 'localhost:1234', protocol: 'http:' };
    new Peer(server, request, {}, Recording).close();
  } finally {
    globalThis.location = original;
  }
  assert.deepEqual(urls, ['wss://my-mac.example.ts.net/ws', 'ws://localhost:1234/ws']);
});
