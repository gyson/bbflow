import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Watch } from './dist/watch.js';
import { VERSION } from './dist/protocol.js';

const server = { protocol: VERSION, instance: 'fixture', dataDir: '/fixture', port: 1234 };

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sockets = [], messages = [], failures = [];
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
  const watch = new Watch(server, { operation: 'status-watch' }, {
    message: message => messages.push(message),
    failed: (error, retrying) => failures.push({ error, retrying }),
  });
  t.after(() => watch.close());
  return { watch, sockets, messages, failures };
}

test('a status watch gets each pushed set of statuses and keeps its connection alive', t => {
  const { sockets, messages } = fixture(t);
  sockets[0].receive({ type: 'server', server });
  assert.deepEqual(sockets[0].sent[0], { type: 'request', request: { operation: 'status-watch', protocol: VERSION } });
  // The server omits an empty set of statuses.
  sockets[0].receive({ type: 'statuses' });
  sockets[0].receive({ type: 'statuses', statuses: { one: 'running' } });
  assert.deepEqual(messages, [{ type: 'statuses' }, { type: 'statuses', statuses: { one: 'running' } }]);
  t.mock.timers.tick(5000);
  assert.deepEqual(sockets[0].sent.at(-1), { type: 'ping' });
});

test('a lost status watch reconnects and gets the statuses again', t => {
  const { sockets, messages, failures } = fixture(t);
  sockets[0].receive({ type: 'server', server });
  sockets[0].receive({ type: 'statuses', statuses: { one: 'running' } });
  sockets[0].close();
  assert.deepEqual(failures.map(failure => failure.retrying), [true]);
  t.mock.timers.tick(500);
  assert.equal(sockets.length, 2);
  sockets[1].receive({ type: 'server', server });
  sockets[1].receive({ type: 'statuses', statuses: { one: 'idle' } });
  assert.deepEqual(messages.at(-1), { type: 'statuses', statuses: { one: 'idle' } });
});

test('a closed status watch does not reconnect', t => {
  const { watch, sockets, failures } = fixture(t);
  sockets[0].receive({ type: 'server', server });
  watch.close();
  t.mock.timers.tick(60000);
  assert.equal(sockets.length, 1);
  assert.deepEqual(failures, []);
});
