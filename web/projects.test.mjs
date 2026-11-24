import { test } from 'node:test';
import assert from 'node:assert/strict';
import { familyGroup, familyStep, families, mergeSessions, pinLimit, pinnedGroup, placeText, sessionGroups, shownChildren, welcomeText } from './dist/projects.js';

const projects = [
  { id: 'notes', name: 'Notes', workspace: '/work/notes' },
  { id: 'repo', name: 'bbflow', workspace: '/work/bbflow' },
];
const session = (id, projectId, extra = {}) => ({ id, projectId, parentId: '', title: id, autoTitle: '', workspace: '/w', ...extra });
const sessions = [
  { id: 'a', projectId: 'repo', parentId: '', title: 'Authentication', workspace: '/work/bbflow' },
  { id: 'b', projectId: 'notes', parentId: '', title: 'Research', workspace: '/work/notes' },
  { id: 'c', projectId: '', parentId: '', title: 'Scratch', workspace: '/work/scratch' },
];
const ids = groups => groups.map(g => g.families.map(f => [f.root.id, ...f.children.map(c => c.id)]));

test('a project without sessions remains available, and projects group by stable identity', () => {
  assert.deepEqual(sessionGroups(projects, [], '').map(g => g.project.id), ['notes', 'repo']);
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
  const recent = { sessions: [session('r1', 'repo'), session('r1a', 'repo', { parentId: 'r1' }), session('g1', 'notes'), session('r2', 'repo'), session('r9', 'repo'), session('x1', 'removed')], more: ['repo', ''] };
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

test('pinned families form the first group and leave the group of their project', () => {
  assert.equal(pinnedGroup, 'pinned');
  assert.equal(pinLimit, 20);
  const list = [
    session('p2', 'notes', { pinned: true, title: 'Pinned research' }),
    session('p1', 'repo', { pinned: true, title: 'Pinned work' }),
    session('p1a', 'repo', { parentId: 'p1', title: 'Reviewer' }),
    session('ps', 'gone', { pinned: true, title: 'Pinned scratch' }),
    session('a', 'repo', { title: 'Authentication' }),
    session('c', '', { title: 'Scratch' }),
  ];
  const groups = sessionGroups(projects, list, '');
  assert.deepEqual(groups.map(g => g.pinned ? 'Pinned' : g.project?.name ?? 'Standalone'), ['Pinned', 'Notes', 'bbflow', 'Standalone']);
  // Pinned keeps the order of the server. A pinned family keeps its sub-sessions. A pin
  // of a session without a saved project is in Pinned too.
  assert.deepEqual(ids(groups), [[['p2'], ['p1', 'p1a'], ['ps']], [], [['a']], [['c']]]);
  // A search filters Pinned like a project group. A project name matches its families.
  assert.deepEqual(ids(sessionGroups(projects, list, 'reviewer')), [[['p1', 'p1a']]]);
  assert.equal(sessionGroups(projects, list, 'reviewer')[0].families[0].context, true);
  assert.deepEqual(ids(sessionGroups(projects, list, 'notes')), [[['p2']], []]);
  // Without a pinned family, Pinned does not show.
  assert.equal(sessionGroups(projects, list.filter(item => !item.pinned && item.parentId !== 'p1'), '').some(g => g.pinned), false);
  // Archived ignores pins.
  assert.deepEqual(sessionGroups(projects, list, '', true).map(g => g.pinned ? 'Pinned' : g.project?.name ?? 'Standalone'), ['Notes', 'bbflow', 'Standalone']);
  const known = new Set(projects.map(project => project.id));
  assert.equal(familyGroup(list[0], known, false), 'pinned');
  assert.equal(familyGroup(list[0], known, true), 'notes');
  assert.equal(familyGroup(list[3], known, true), '');
});

test('a merge keeps the pinned families out of the group step of their project', () => {
  // The Pinned page comes first. The repo group shows 2 recent families and a window at
  // offset 2. The pinned families do not count against the step of repo.
  const recent = { sessions: [session('p1', 'repo', { pinned: true }), session('p2', 'repo', { pinned: true }), session('p3', 'repo', { pinned: true }), session('r1', 'repo'), session('r2', 'repo')], more: ['repo'] };
  const windows = [{ group: 'repo', offset: 2, page: { sessions: [session('r3', 'repo')], more: [] } }];
  const merged = mergeSessions(projects, recent, windows, 2);
  assert.deepEqual(merged.sessions.map(s => s.id), ['p1', 'p2', 'p3', 'r1', 'r2', 'r3']);
  assert.deepEqual(merged.more, []);
  assert.deepEqual(ids(sessionGroups(projects, merged.sessions, '')), [[['p1'], ['p2'], ['p3']], [], [['r1'], ['r2'], ['r3']]]);
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

test('the welcome text tells how to add the first project, and then how to start a session', () => {
  assert.equal(welcomeText([]), 'Click ＋ Project to add a folder. Then click ＋ beside the project to start a session.');
  assert.equal(welcomeText(projects), 'Select a session in the sidebar, or click ＋ beside a project to start one.');
});
