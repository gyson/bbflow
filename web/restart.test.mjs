import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Peer, VERSION } from './dist/protocol.js';
import { onServerReplaced, reloadInterval, reloadPlan, replaces, restartedMessage } from './dist/restart.js';

class Socket {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; }
  receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
}
const server = { protocol: VERSION, instance: 'old', pid: 1, dataDir: '/instance', port: 1234, executable: '/bbflow' };
const request = { operation: 'status-watch' };

test('a new server for the same directory replaces the old one', () => {
  assert.equal(replaces(server, { ...server, instance: 'new', pid: 2 }), true);
  assert.equal(replaces(server, { ...server, instance: 'new', protocol: 'bbflow/99' }), true);
  assert.equal(replaces(server, server), false);
  assert.equal(replaces(server, { ...server, instance: 'other', dataDir: '/other' }), false);
  assert.equal(replaces(server, undefined), false);
});

test('only the greeting of a replacement server starts the reload', t => {
  let calls = 0;
  onServerReplaced(() => { calls++; });
  t.after(() => onServerReplaced(() => {}));
  for (const [next, want, message] of [
    [{ ...server, instance: 'new' }, 1, restartedMessage],
    [{ ...server, instance: 'other', dataDir: '/other' }, 1, 'The server changed or uses a different protocol. Reload this page.'],
    [server, 1, undefined],
  ]) {
    let error;
    const peer = new Peer(server, request, { error: e => { error = e; } }, Socket, 'localhost:1234');
    peer.socket.receive({ type: 'server', server: next });
    assert.equal(calls, want);
    assert.equal(error?.message, message);
    assert.equal(peer.socket.sent.length, message ? 0 : 1);
  }
});

test('a reload never drops unsaved edits and stops after a recent reload', () => {
  const now = 100000;
  assert.equal(reloadPlan(false, 0, now), 'reload');
  assert.equal(reloadPlan(true, 0, now), 'unsaved');
  assert.equal(reloadPlan(true, now - 1, now), 'unsaved');
  assert.equal(reloadPlan(false, now - 1, now), 'repeated');
  assert.equal(reloadPlan(false, now - reloadInterval, now), 'reload');
  // A clock that moved back must not block reloads.
  assert.equal(reloadPlan(false, now + 1, now), 'reload');
});
