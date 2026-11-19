import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Peer, VERSION } from './dist/protocol.js';
import { DialogEdits, onServerReplaced, reloadInterval, reloadPlan, replaces, restartedMessage } from './dist/restart.js';

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

test('a new server for the same directory and port replaces the old one', () => {
  assert.equal(replaces(server, { ...server, instance: 'new', pid: 2 }), true);
  assert.equal(replaces(server, { ...server, instance: 'new', protocol: 'bbflow/99' }), true);
});

test('an incomplete or inconsistent greeting needs manual recovery', () => {
  const { instance: _instance, ...noInstance } = { ...server, instance: 'new' };
  const { protocol: _protocol, ...noProtocol } = { ...server, instance: 'new' };
  const { dataDir: _dataDir, ...noDirectory } = { ...server, instance: 'new' };
  const { port: _port, ...noPort } = { ...server, instance: 'new' };
  for (const next of [
    undefined, {}, server, noInstance, noProtocol, noDirectory, noPort,
    { ...server, instance: '' },
    { ...server, instance: 'new', protocol: '' },
    { ...server, instance: 7 },
    { ...server, protocol: 'bbflow/99' },
    { ...server, port: 4321 },
    { ...server, instance: 'new', port: 4321 },
    { ...server, instance: 'new', port: '1234' },
    { ...server, instance: 'other', dataDir: '/other' },
  ]) assert.equal(replaces(server, next), false, JSON.stringify(next));
});

test('only an open dialog with a changed field blocks the reload', () => {
  const project = { open: false }, rename = { open: false };
  const name = { value: '' }, folder = { value: '' }, title = { value: 'Old title' };
  const edits = new DialogEdits([{ dialog: project, fields: [name, folder] }, { dialog: rename, fields: [title] }]);
  assert.equal(edits.changed(), undefined);
  project.open = true;
  edits.opened(project);
  assert.equal(edits.changed(), undefined);
  folder.value = '~/work';
  assert.equal(edits.changed(), project);
  // A closed dialog has no edits to keep. A new open records the fields again.
  project.open = false;
  assert.equal(edits.changed(), undefined);
  project.open = true;
  edits.opened(project);
  assert.equal(edits.changed(), undefined);
  project.open = false;
  rename.open = true;
  edits.opened(rename);
  title.value = 'New title';
  assert.equal(edits.changed(), rename);
  title.value = 'Old title';
  assert.equal(edits.changed(), undefined);
  // An open dialog without a record is treated as changed.
  const unknown = new DialogEdits([{ dialog: { open: true }, fields: [] }]);
  assert.notEqual(unknown.changed(), undefined);
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
