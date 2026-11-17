import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSessions, sessionGroups } from './dist/projects.js';

const projects = [
  { id: 'general', name: 'General', workspace: '/instance/workspaces/general' },
  { id: 'repo', name: 'bbflow', workspace: '/work/bbflow' },
];
const sessions = [
  { id: 'a', projectId: 'repo', title: 'Authentication', workspace: '/work/bbflow' },
  { id: 'b', projectId: 'general', title: 'Research', workspace: '/instance/workspaces/general' },
  { id: 'c', projectId: '', title: 'Scratch', workspace: '/work/scratch' },
];

test('General remains available without sessions and custom projects group by stable identity', () => {
  assert.deepEqual(sessionGroups(projects, [], '').map(g => g.project.id), ['general', 'repo']);
  assert.deepEqual(sessionGroups(projects, sessions, '').map(g => g.sessions.map(s => s.id)), [['b'], ['a'], ['c']]);
  const renamed = projects.map(p => p.id === 'repo' ? { ...p, name: 'New name' } : p);
  assert.equal(sessionGroups(renamed, sessions, 'new name')[0].sessions[0].id, 'a');
});

test('search matches projects, session titles, and workspace paths', () => {
  assert.equal(sessionGroups(projects, sessions, 'AUTHENTICATION')[0].project.id, 'repo');
  assert.equal(sessionGroups(projects, sessions, '/work/scratch')[0].project, null);
  assert.equal(sessionGroups(projects, sessions, 'unknown').length, 0);
});

test('a removed or concurrently missing project does not hide its sessions', () => {
  const groups = sessionGroups([projects[0]], sessions, '');
  assert.equal(groups.at(-1).project, null);
  assert.deepEqual(groups.at(-1).sessions.map(s => s.id), ['a', 'c']);
});

test('the recent page and the group windows join in order without a repeated session', () => {
  const session = (id, projectId) => ({ id, projectId, title: id, workspace: '/w' });
  // repo shows 2 recent sessions, the selected session r9, and windows at offsets 2 and 4.
  // The window at offset 4 repeats r4, because activity changed between the replies.
  const recent = { sessions: [session('r1', 'repo'), session('g1', 'general'), session('r2', 'repo'), session('r9', 'repo'), session('x1', 'removed')], more: ['repo', ''] };
  const windows = [
    { group: 'repo', offset: 4, page: { sessions: [session('r4', 'repo'), session('r5', 'repo')], more: [] } },
    { group: 'repo', offset: 2, page: { sessions: [session('r3', 'repo'), session('r4', 'repo')], more: ['repo'] } },
  ];
  const merged = mergeSessions(projects, recent, windows, 2);
  assert.deepEqual(merged.sessions.map(s => s.id), ['r1', 'r2', 'r3', 'r4', 'r5', 'r9', 'g1', 'x1']);
  // The last window decides more for its group. Other groups keep the recent page value.
  assert.deepEqual(merged.more, ['']);
  assert.deepEqual(sessionGroups(projects, merged.sessions, '').map(g => g.sessions.map(s => s.id)), [['g1'], ['r1', 'r2', 'r3', 'r4', 'r5', 'r9'], ['x1']]);
});
