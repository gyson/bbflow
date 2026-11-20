import { test } from 'node:test';
import assert from 'node:assert/strict';
import { familyStep, families, mergeSessions, placeText, sessionGroups, shownChildren } from './dist/projects.js';

const projects = [
  { id: 'general', name: 'General', workspace: '/instance/workspaces/general' },
  { id: 'repo', name: 'bbflow', workspace: '/work/bbflow' },
];
const session = (id, projectId, extra = {}) => ({ id, projectId, parentId: '', title: id, autoTitle: '', workspace: '/w', ...extra });
const sessions = [
  { id: 'a', projectId: 'repo', parentId: '', title: 'Authentication', workspace: '/work/bbflow' },
  { id: 'b', projectId: 'general', parentId: '', title: 'Research', workspace: '/instance/workspaces/general' },
  { id: 'c', projectId: '', parentId: '', title: 'Scratch', workspace: '/work/scratch' },
];
const ids = groups => groups.map(g => g.families.map(f => [f.root.id, ...f.children.map(c => c.id)]));

test('General remains available without sessions and custom projects group by stable identity', () => {
  assert.deepEqual(sessionGroups(projects, [], '').map(g => g.project.id), ['general', 'repo']);
  assert.deepEqual(ids(sessionGroups(projects, sessions, '')), [[['b']], [['a']], [['c']]]);
  const renamed = projects.map(p => p.id === 'repo' ? { ...p, name: 'New name' } : p);
  assert.equal(sessionGroups(renamed, sessions, 'new name')[0].families[0].root.id, 'a');
});

test('search matches projects, session titles, and workspace paths', () => {
  assert.equal(sessionGroups(projects, sessions, 'AUTHENTICATION')[0].project.id, 'repo');
  assert.equal(sessionGroups(projects, sessions, '/work/scratch')[0].project, null);
  assert.equal(sessionGroups(projects, sessions, 'unknown').length, 0);
});

test('a removed or concurrently missing project does not hide its sessions', () => {
  const groups = sessionGroups([projects[0]], sessions, '');
  assert.equal(groups.at(-1).project, null);
  assert.deepEqual(groups.at(-1).families.map(f => f.root.id), ['a', 'c']);
});

test('sub-sessions join the family of their top-level session', () => {
  const list = [
    session('p', 'repo', { title: 'Session grouping' }),
    session('r', 'repo', { parentId: 'p', title: 'review-loop reviewer' }),
    session('d', 'repo', { parentId: 'p', title: 'Docs pass' }),
    session('s', 'repo', { title: 'Solo' }),
    // A sub-session without its top-level session in the list waits for the next refresh.
    session('o', 'repo', { parentId: 'missing' }),
  ];
  assert.deepEqual(families(list).map(f => [f.root.id, ...f.children.map(c => c.id)]), [['p', 'r', 'd'], ['s']]);
  assert.deepEqual(ids(sessionGroups(projects, list, '')), [[], [['p', 'r', 'd'], ['s']]]);
  // A match of a sub-session shows its top-level session as context.
  const review = sessionGroups(projects, list, 'reviewer')[0].families;
  assert.deepEqual(review.map(f => [f.root.id, f.context, f.children.map(c => c.id)]), [['p', true, ['r']]]);
  // A match of the top-level session shows the whole family.
  const grouping = sessionGroups(projects, list, 'grouping')[0].families;
  assert.deepEqual(grouping.map(f => [f.root.id, f.context, f.children.map(c => c.id)]), [['p', false, ['r', 'd']]]);
  // The server marks a top-level session from the other collection as context.
  const archived = families([session('p', 'repo', { context: true }), session('r', 'repo', { parentId: 'p', archived: true })]);
  assert.equal(archived[0].context, true);
});

test('the place of a sub-session names its workspace', () => {
  const parent = session('p', 'repo', { workspace: '/worktrees/parent' });
  assert.equal(placeText(session('d', 'repo', { parentId: 'p', status: 'draft', preparation: { worktree: true } }), parent), 'new worktree');
  assert.equal(placeText(session('d', 'repo', { parentId: 'p', status: 'draft', preparation: { worktree: false } }), parent), 'parent workspace');
  assert.equal(placeText(session('s', 'repo', { parentId: 'p', status: 'idle', workspace: '/worktrees/parent' }), parent), 'parent workspace');
  assert.equal(placeText(session('w', 'repo', { parentId: 'p', status: 'ended', workspace: '/worktrees/own', worktree: { branch: 'b' } }), parent), 'own worktree');
  assert.equal(placeText(session('m', 'repo', { parentId: 'p', status: 'ended', workspace: '/work/bbflow' }), parent), 'own folder');
});

test('the recent page and the group windows join in order without a repeated family', () => {
  // repo shows 2 recent families, the selected family r9, and windows at offsets 2 and 4.
  // The window at offset 4 repeats the family r4, because activity changed between the
  // replies. Each family keeps its sub-sessions.
  const recent = { sessions: [session('r1', 'repo'), session('r1a', 'repo', { parentId: 'r1' }), session('g1', 'general'), session('r2', 'repo'), session('r9', 'repo'), session('x1', 'removed')], more: ['repo', ''] };
  const windows = [
    { group: 'repo', offset: 4, page: { sessions: [session('r4', 'repo'), session('r4a', 'repo', { parentId: 'r4' }), session('r5', 'repo')], more: [] } },
    { group: 'repo', offset: 2, page: { sessions: [session('r3', 'repo'), session('r4', 'repo'), session('r4a', 'repo', { parentId: 'r4' })], more: ['repo'] } },
  ];
  const merged = mergeSessions(projects, recent, windows, 2);
  assert.deepEqual(merged.sessions.map(s => s.id), ['r1', 'r1a', 'r2', 'r3', 'r4', 'r4a', 'r5', 'r9', 'g1', 'x1']);
  // The last window decides more for its group. Other groups keep the recent page value.
  assert.deepEqual(merged.more, ['']);
  assert.deepEqual(ids(sessionGroups(projects, merged.sessions, '')), [[['g1']], [['r1', 'r1a'], ['r2'], ['r3'], ['r4', 'r4a'], ['r5'], ['r9']], [['x1']]]);
});

test('a family shows its first sub-sessions, a selected one, and all of them on request', () => {
  const children = Array.from({ length: 7 }, (_, i) => session(`k${i}`, 'repo', { parentId: 'p' }));
  const ids = result => [result.shown.map(child => child.id), result.hidden];
  assert.equal(familyStep, 5);
  assert.deepEqual(ids(shownChildren(children, false)), [['k0', 'k1', 'k2', 'k3', 'k4'], 2]);
  assert.deepEqual(ids(shownChildren(children, false, 'k6')), [['k0', 'k1', 'k2', 'k3', 'k4', 'k6'], 1]);
  assert.deepEqual(ids(shownChildren(children, true)), [children.map(child => child.id), 0]);
  assert.deepEqual(ids(shownChildren(children.slice(0, 3), false)), [['k0', 'k1', 'k2'], 0]);
});
