import type { Project, SessionInfo, SessionPage } from './protocol.js';

// A family is a top-level session and its sub-sessions in the list. A context family
// shows its top-level session only as the parent of matching sub-sessions.
export interface Family { root: SessionInfo; children: SessionInfo[]; context: boolean }
export interface SessionGroup { project: Project | null; families: Family[] }

const familyKey = (session: SessionInfo) => session.parentId || session.id;

// Join the sessions of the list into families, in list order. The server lists a
// top-level session before its sub-sessions. A sub-session without its top-level session
// in the list does not show. The next refresh lists it again.
export function families(sessions: SessionInfo[]): Family[] {
  const result: Family[] = [];
  const byRoot = new Map<string, Family>();
  for (const session of sessions) {
    if (!session.parentId) {
      if (byRoot.has(session.id)) continue;
      const family = { root: session, children: [], context: !!session.context };
      byRoot.set(session.id, family);
      result.push(family);
    } else {
      const family = byRoot.get(session.parentId);
      if (family && !family.children.some(child => child.id === session.id)) family.children.push(session);
    }
  }
  return result;
}

// Group the page filtered by the server. Keep empty matching projects available for new
// drafts. The filter applies at once, before the server reply for a new search. A match
// of a top-level session shows its family. A match of a sub-session shows its top-level
// session as context.
export function sessionGroups(projects: Project[], sessions: SessionInfo[], filter: string): SessionGroup[] {
  const query = filter.trim().toLowerCase();
  const matches = (session: SessionInfo) => `${session.title} ${session.autoTitle} ${session.workspace} ${session.id}`.toLowerCase().includes(query);
  const filtered = (list: Family[], projectMatches: boolean) => list.flatMap(family => {
    if (!query || projectMatches || matches(family.root)) return [family];
    const children = family.children.filter(matches);
    return children.length ? [{ root: family.root, children, context: true }] : [];
  });
  const all = families(sessions);
  const groups: SessionGroup[] = projects.map(project => {
    const projectMatches = `${project.name} ${project.workspace}`.toLowerCase().includes(query);
    return { project, families: filtered(all.filter(family => family.root.projectId === project.id), projectMatches) };
  }).filter(group => !query || group.families.length || `${group.project!.name} ${group.project!.workspace}`.toLowerCase().includes(query));
  const known = new Set(projects.map(project => project.id));
  const standalone = filtered(all.filter(family => !known.has(family.root.projectId)), false);
  if (standalone.length) groups.push({ project: null, families: standalone });
  return groups;
}

// Tell where a sub-session works, for its row in the list.
export function placeText(session: SessionInfo, parent: SessionInfo): string {
  if (session.status === 'draft') return session.preparation?.worktree ? 'new worktree' : 'parent workspace';
  if (session.worktree) return 'own worktree';
  return session.workspace === parent.workspace ? 'parent workspace' : 'own folder';
}

// The sidebar shows this many sub-sessions of a family before Show more.
export const familyStep = 5;

// Return the sub-sessions that a family shows, and the count of the others. all shows
// every sub-session, for a search or after Show more. A selected sub-session after the
// first ones shows too.
export function shownChildren(children: SessionInfo[], all: boolean, selected = ''): { shown: SessionInfo[]; hidden: number } {
  const shown = all ? children : children.filter((child, index) => index < familyStep || child.id === selected);
  return { shown, hidden: children.length - shown.length };
}

// One reply lists at most this many families of one group.
export const sessionWindow = 100;

// A window lists the families of one group after offset. The recent page lists the first
// step families of each group, and the family of the selected session also when it is
// older.
export interface SessionWindow { group: string; offset: number; page: SessionPage }

// Split a list into families. Each family keeps its sessions in list order.
function familyRuns(sessions: SessionInfo[]): SessionInfo[][] {
  const runs: SessionInfo[][] = [];
  for (const session of sessions) {
    const last = runs.at(-1);
    if (last && session.parentId && familyKey(last[0]!) === session.parentId) last.push(session);
    else runs.push([session]);
  }
  return runs;
}

// Join the recent page and the windows of each group into one list. Separate replies can
// see different activity. Thus the merge drops a repeated family. A skipped family shows
// again at the next refresh.
export function mergeSessions(projects: Project[], recent: SessionPage, windows: SessionWindow[], step: number): SessionPage {
  const known = new Set(projects.map(project => project.id));
  const groupOf = (session: SessionInfo) => known.has(session.projectId) ? session.projectId : '';
  const groups = new Map<string, { top: SessionInfo[][]; extra: SessionInfo[][]; more: boolean }>();
  const entry = (group: string) => {
    let value = groups.get(group);
    if (!value) groups.set(group, value = { top: [], extra: [], more: recent.more.includes(group) });
    return value;
  };
  for (const run of familyRuns(recent.sessions)) {
    const value = entry(groupOf(run[0]!));
    (value.top.length < step ? value.top : value.extra).push(run);
  }
  const ordered = [...windows].sort((a, b) => a.offset - b.offset);
  for (const window of ordered) entry(window.group).more = window.page.more.includes(window.group);
  const sessions: SessionInfo[] = [], more: string[] = [], seen = new Set<string>();
  for (const [group, value] of groups) {
    const listed = [...value.top, ...ordered.filter(window => window.group === group).flatMap(window => familyRuns(window.page.sessions)), ...value.extra];
    for (const run of listed) {
      const key = familyKey(run[0]!);
      if (seen.has(key)) continue;
      seen.add(key);
      sessions.push(...run);
    }
    if (value.more) more.push(group);
  }
  return { sessions, more };
}
