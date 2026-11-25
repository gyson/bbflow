import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionConnection } from './dist/session-connection.js';
import { VERSION } from './dist/protocol.js';

const server = { protocol: VERSION, instance: 'fixture', dataDir: '/fixture', port: 1234 };
const size = { cols: 80, rows: 24 };
const resume = { operation: 'session-resume', session: 'one', size };

function fixture(t, request = resume) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sockets = [], frames = [], errors = [];
  class Socket {
    readyState = 1;
    bufferedAmount = 0;
    sent = [];
    constructor() { sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  for (const [name, value] of Object.entries({ WebSocket: Socket, location: { host: 'localhost:1234' } })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
  const connection = new SessionConnection(server, {
    options: {}, resize() {}, write(_bytes, parsed) { frames.push(parsed); },
  }, request, {
    size: () => size, message() {}, ready() {},
    disconnected(error, retrying) { errors.push({ error, retrying }); },
  });
  t.after(() => connection.close());
  const greet = socket => socket.receive({ type: 'server', server });
  const attach = (socket, extra = {}) => {
    greet(socket);
    socket.receive({ type: 'session', session: 'one', active: true, ...extra });
    socket.receive({ type: 'frame', revision: 1, full: true, size });
  };
  // xterm.js parses the queued writes of the outstanding frame and calls their callbacks
  // in order. A callback can queue another write.
  const parse = () => { while (frames.length) frames.shift()(); };
  return { connection, sockets, frames, errors, greet, attach, parse };
}

test('reconnect joins the known session, waits for a fresh frame, and never repeats input', async t => {
  const { connection, sockets, attach, parse } = fixture(t, {
    operation: 'session-start', session: 'one', revision: 1, size,
  });
  const opened = connection.connect();
  attach(sockets[0]);
  await opened;
  assert.equal(connection.ready, false);
  parse();
  assert.equal(connection.ready, true);
  const input = connection.peer.writeInput('eA==', 'one');
  const rejected = assert.rejects(input, /delivery was not confirmed/);
  sockets[0].close();
  await rejected;
  assert.equal(connection.ready, false);
  t.mock.timers.tick(500);
  assert.equal(sockets.length, 2);
  attach(sockets[1]);
  assert.deepEqual(sockets[1].sent, [{ type: 'request', request: { ...resume, protocol: VERSION } }]);
  assert.equal(connection.ready, false);
  parse();
  assert.equal(connection.ready, true);
});

test('a view asks for each size once, also before the frame of that size arrives', async t => {
  const { connection, sockets, attach, parse } = fixture(t);
  const resizes = () => sockets.at(-1).sent.filter(message => message.type === 'resize').map(message => message.size);
  const opened = connection.connect();
  attach(sockets[0]);
  await opened;
  parse();
  // The request already asked for this size.
  assert.equal(connection.resize(size), false);
  const lower = { cols: 80, rows: 20 };
  assert.equal(connection.resize(lower), true);
  // The frames still have the old size. Another fit gives the same size again.
  assert.equal(connection.resize(lower), false);
  assert.deepEqual(resizes(), [lower]);
  // The area grows again before the frame of the lower size arrives.
  assert.equal(connection.resize(size), true);
  assert.deepEqual(resizes(), [lower, size]);
  // A new connection asks again with the size of its request.
  sockets[0].close();
  t.mock.timers.tick(500);
  attach(sockets[1]);
  assert.equal(connection.resize(size), false);
  assert.equal(connection.resize(lower), true);
  assert.deepEqual(resizes(), [lower]);
});

test('leaving a session cancels retries and pending frame callbacks', async t => {
  const { connection, sockets, attach, parse } = fixture(t);
  const opened = connection.connect();
  attach(sockets[0]);
  await opened;
  sockets[0].close();
  connection.close();
  parse();
  t.mock.timers.tick(30000);
  assert.equal(sockets.length, 1);
  assert.equal(connection.ready, false);
  assert.equal(sockets[0].sent.some(message => message.type === 'frame-ack'), false);
});

test('reconnect backs off on transport errors but stops on identity mismatch', async t => {
  const { connection, sockets, errors } = fixture(t);
  const opened = assert.rejects(connection.connect(), /Connection lost/);
  sockets[0].close();
  await opened;
  t.mock.timers.tick(500);
  sockets[1].close();
  t.mock.timers.tick(999);
  assert.equal(sockets.length, 2);
  t.mock.timers.tick(1);
  sockets[2].receive({ type: 'server', server: { ...server, instance: 'replacement' } });
  t.mock.timers.tick(30000);
  assert.equal(sockets.length, 3);
  assert.equal(errors.at(-1).retrying, false);
  assert.equal(sockets[2].sent.length, 0);
});

test('an uncertain prepared session start is never submitted twice', async t => {
  const request = { operation: 'session-start', session: 'one', revision: 3, size };
  const { connection, sockets, errors, greet } = fixture(t, request);
  const opened = assert.rejects(connection.connect(), /Connection lost/);
  greet(sockets[0]);
  sockets[0].close();
  await opened;
  t.mock.timers.tick(30000);
  assert.equal(sockets.length, 1);
  assert.equal(errors[0].retrying, false);
  assert.deepEqual(sockets[0].sent[0].request, { ...request, protocol: VERSION });
});

test('a lost view of an earlier terminal reconnects to the same terminal', async t => {
  const earlier = { ...resume, run: 'run-1' };
  const { connection, sockets, frames, greet } = fixture(t, earlier);
  const opened = connection.connect();
  greet(sockets[0]);
  sockets[0].receive({ type: 'session', session: 'one', status: 'exited' });
  await opened;
  sockets[0].close();
  t.mock.timers.tick(500);
  assert.equal(sockets.length, 2);
  greet(sockets[1]);
  assert.deepEqual(sockets[1].sent, [{ type: 'request', request: { ...earlier, protocol: VERSION } }]);
  assert.equal(frames.length, 0);
});

test('a lost side terminal rejoins its shell and never starts another shell', async t => {
  const open = { operation: 'side-terminal-open', session: 'one', size };
  const { connection, sockets, attach, greet, parse } = fixture(t, open);
  const opened = connection.connect();
  attach(sockets[0], { shell: 'first' });
  await opened;
  parse();
  sockets[0].close();
  t.mock.timers.tick(500);
  assert.equal(sockets.length, 2);
  greet(sockets[1]);
  const rejoin = { type: 'request', request: { operation: 'side-terminal-resume', session: 'one', size, shell: 'first', protocol: VERSION } };
  assert.deepEqual(sockets[1].sent, [rejoin]);
  // A later retry still names the first shell. It cannot join a shell of another view.
  sockets[1].close();
  t.mock.timers.tick(1000);
  assert.equal(sockets.length, 3);
  greet(sockets[2]);
  assert.deepEqual(sockets[2].sent, [rejoin]);
});

test('a lost side terminal open before its session message is not retried', async t => {
  const open = { operation: 'side-terminal-open', session: 'one', size };
  const { connection, sockets, errors, greet } = fixture(t, open);
  const opened = assert.rejects(connection.connect(), /Connection lost/);
  greet(sockets[0]);
  sockets[0].close();
  await opened;
  t.mock.timers.tick(30000);
  assert.equal(sockets.length, 1);
  assert.equal(errors[0].retrying, false);
});
