import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageJump } from './dist/message-jump.js';

const terminal = (number, status, ended = '2026-11-23T10:30:00Z') =>
  ({ number, run: `run-${number}`, tool: 'Demo agent', status, started: `2026-11-23T1${number}:00:00Z`, ended });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const turns = async () => { for (let turn = 0; turn < 5; turn++) await Promise.resolve(); };

// A fake host. Each list read waits until the test resolves it. A read can change the
// list first. An open opens the run at once, unless the test holds it.
function fixture(terminals = [terminal(1, 'stopped'), terminal(2, 'stopped'), terminal(3, 'running', '')]) {
  const state = { session: 'one', opens: 0, shown: 'run-3', terminals, reads: [], opened: [], seeks: [], toasts: [], reveals: 0, hold: null, result: 'found' };
  const jump = new MessageJump({
    session: () => state.session,
    opens: () => state.opens,
    loadTerminals() {
      const read = deferred();
      state.reads.push(read);
      return read.promise;
    },
    terminals: () => state.terminals,
    shownRun: () => state.shown,
    reveal() { state.reveals++; },
    async open(session, run) {
      const open = ++state.opens;
      if (state.hold) await state.hold.promise;
      state.opened.push(run);
      state.shown = run;
      return open;
    },
    async seek(revision) { state.seeks.push(revision); return state.result; },
    readError: () => 'database is locked',
    failed(number, detail) { state.toasts.push(`terminal ${number}: ${detail}`); },
  });
  return { jump, state };
}

test('a jump reads the list again, then opens the run of the message, also for the latest terminal', async () => {
  const { jump, state } = fixture([terminal(1, 'stopped'), terminal(2, 'running', '')]);
  state.shown = 'run-1';
  const shown = jump.show(7, terminal(2, 'running', ''));
  assert.equal(state.reads.length, 1);
  assert.deepEqual(state.opened, [], 'the jump waits for the list');
  state.reads[0].resolve();
  await shown;
  assert.deepEqual(state.opened, ['run-2'], 'the request names the run, never an empty run');
  assert.deepEqual(state.seeks, [7]);
  assert.equal(state.reveals, 1);
});

test('an older click stops when a newer click opened its terminal first', async () => {
  const { jump, state } = fixture();
  state.shown = 'run-1';
  const older = jump.show(2, terminal(2, 'stopped'));
  const newer = jump.show(3, terminal(3, 'running', ''));
  // The reply to the newer read arrives first.
  state.reads[1].resolve();
  await newer;
  assert.deepEqual(state.opened, ['run-3']);
  state.reads[0].resolve();
  await older;
  assert.deepEqual(state.opened, ['run-3'], 'the older click does not open its terminal');
  assert.deepEqual(state.seeks, [3]);
});

test('a click stops when another open came during its list read', async () => {
  const { jump, state } = fixture();
  const shown = jump.show(2, terminal(2, 'stopped'));
  // The terminal selector opened terminal 1.
  state.opens++;
  state.shown = 'run-1';
  state.reads[0].resolve();
  await shown;
  assert.deepEqual(state.opened, []);
  assert.equal(state.reveals, 0);
});

test('a newer click during the open stops the seek of the older click', async () => {
  const { jump, state } = fixture();
  state.hold = deferred();
  const older = jump.show(2, terminal(2, 'stopped'));
  state.reads[0].resolve();
  await turns();
  assert.equal(state.opens, 1, 'the open of the older click runs');
  void jump.show(1, terminal(1, 'stopped'));
  state.hold.resolve();
  await older;
  assert.deepEqual(state.seeks, [], 'the older click does not seek');
});

test('a failed list read keeps the target, and the jump completes', async () => {
  // The host keeps the known list when a read fails. The open reads the list again for
  // its session message. Both reads leave the list as it was.
  const { jump, state } = fixture();
  const shown = jump.show(2, terminal(2, 'stopped'));
  state.reads[0].resolve();
  await shown;
  assert.deepEqual(state.opened, ['run-2']);
  assert.deepEqual(state.seeks, [2]);
  assert.deepEqual(state.toasts, []);
});

test('without a terminal list, a click reports it and opens nothing', async () => {
  const { jump, state } = fixture([]);
  const shown = jump.show(2, terminal(2, 'stopped'));
  state.reads[0].resolve();
  await shown;
  assert.deepEqual(state.opened, []);
  assert.deepEqual(state.toasts, ['terminal 2: The list of the terminals of this session is not available.']);
});

test('a jump reports a message that the terminal does not show, and a failed read', async () => {
  for (const [result, toast] of [['missing', /does not show this message/], ['failed', /Cannot read the sent messages: database is locked/], ['cancelled', null]]) {
    const { jump, state } = fixture();
    state.result = result;
    const shown = jump.show(2, terminal(2, 'stopped'));
    state.reads[0].resolve();
    await shown;
    if (toast) assert.match(state.toasts.join('\n'), toast);
    else assert.deepEqual(state.toasts, [], 'a cancelled seek reports nothing');
  }
});

test('no jump starts while another action runs, and a jump stops when the session changes', async () => {
  const { jump, state } = fixture();
  state.session = '';
  await jump.show(2, terminal(2, 'stopped'));
  assert.equal(state.reads.length, 0);
  state.session = 'one';
  const shown = jump.show(2, terminal(2, 'stopped'));
  state.session = 'two';
  state.reads[0].resolve();
  await shown;
  assert.deepEqual(state.opened, []);
});
