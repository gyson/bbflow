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
  const state = { session: 'one', busy: false, opens: 0, shown: 'run-3', terminals, reads: [], opened: [], seeks: [], toasts: [], reveals: 0, hold: null, result: 'found' };
  const jump = new MessageJump({
    session: () => state.session,
    busy: () => state.busy,
    opens: () => state.opens,
    loadTerminals() {
      const read = deferred();
      state.reads.push(read);
      return read.promise;
    },
    terminals: () => state.terminals,
    shownRun: () => state.shown,
    reveal() { state.reveals++; },
    // As in the page, an open is an action. The page refuses an action while another
    // one runs.
    async open(session, run) {
      if (state.busy) return null;
      const open = ++state.opens;
      state.busy = true;
      if (state.hold) await state.hold.promise;
      state.busy = false;
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

test('a newer click during the open of an older click waits for it, and only the newer click seeks', async () => {
  const { jump, state } = fixture();
  state.hold = deferred();
  const older = jump.show(2, terminal(2, 'stopped'));
  state.reads[0].resolve();
  await turns();
  assert.equal(state.opens, 1, 'the open of the older click runs');
  const newer = jump.show(1, terminal(1, 'stopped'));
  state.reads[1].resolve();
  await turns();
  assert.deepEqual(state.opened, [], 'the newer click waits for the open of the older click');
  const hold = state.hold;
  state.hold = null;
  hold.resolve();
  await Promise.all([older, newer]);
  assert.deepEqual(state.opened, ['run-2', 'run-1']);
  assert.deepEqual(state.seeks, [1], 'the older click does not seek');
});

test('a move in the shown terminal stops a click that did not open its terminal yet', async () => {
  const { jump, state } = fixture();
  const shown = jump.show(2, terminal(2, 'stopped'));
  // A jump in the shown terminal, a step, or Latest output.
  jump.cancel();
  state.reads[0].resolve();
  await shown;
  assert.deepEqual(state.opened, []);
  assert.equal(state.reveals, 0);
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

test('a jump stops while another action runs, and when the session changes', async () => {
  const { jump, state } = fixture();
  state.session = '';
  await jump.show(2, terminal(2, 'stopped'));
  assert.equal(state.reads.length, 0, 'without a session, nothing starts');
  state.session = 'one';
  // Another action of the page, for example an archive, runs during the list read.
  const busy = jump.show(2, terminal(2, 'stopped'));
  state.busy = true;
  state.reads[0].resolve();
  await busy;
  state.busy = false;
  assert.deepEqual(state.opened, []);
  assert.equal(state.reveals, 0);
  const shown = jump.show(2, terminal(2, 'stopped'));
  state.session = 'two';
  state.reads[1].resolve();
  await shown;
  assert.deepEqual(state.opened, []);
});

test('a retry reads the sent messages of the shown terminal again and reports a second failure', async () => {
  const { jump, state } = fixture();
  state.shown = 'run-2';
  state.result = 'failed';
  await jump.retry(5);
  assert.deepEqual(state.seeks, [5]);
  assert.deepEqual(state.toasts, ['terminal 2: Cannot read the sent messages: database is locked']);
  state.result = 'found';
  await jump.retry(5);
  assert.equal(state.toasts.length, 1);
  // Without a terminal list, the toast names no terminal.
  const empty = fixture([]);
  empty.state.result = 'missing';
  await empty.jump.retry(5);
  assert.match(empty.state.toasts[0], /^terminal undefined: The terminal does not show this message/);
});
