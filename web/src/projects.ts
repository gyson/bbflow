import type { Project, SessionInfo, SessionPage } from './protocol.js';

// Group the page filtered by the server. Keep empty matching projects available for new
// drafts.
export function sessionGroups(projects: Project[], sessions: SessionInfo[], filter: string) {
  const query = filter.trim().toLowerCase();
  const matches = (session: SessionInfo) => `${session.title} ${session.autoTitle} ${session.workspace} ${session.id}`.toLowerCase().includes(query);
  const groups: { project: Project | null; sessions: SessionInfo[] }[] = projects.map(project => {
    const projectMatches = `${project.name} ${project.workspace}`.toLowerCase().includes(query);
    return { project, sessions: sessions.filter(session => session.projectId === project.id && (projectMatches || matches(session))) };
  }).filter(group => !query || group.sessions.length || `${group.project.name} ${group.project.workspace}`.toLowerCase().includes(query));
  const known = new Set(projects.map(project => project.id));
  const standalone = sessions.filter(session => !known.has(session.projectId) && matches(session));
  if (standalone.length) groups.push({ project: null, sessions: standalone });
  return groups;
}

// One reply lists at most this many sessions of one group.
export const sessionWindow = 100;

// A window lists the sessions of one group after offset. The recent page lists the first
// step sessions of each group, and the selected session also when it is older.
export interface SessionWindow { group: string; offset: number; page: SessionPage }

// Join the recent page and the windows of each group into one list. Separate replies can
// see different activity. Thus the merge drops a repeated session. A skipped session
// shows again at the next refresh.
export function mergeSessions(projects: Project[], recent: SessionPage, windows: SessionWindow[], step: number): SessionPage {
  const known = new Set(projects.map(project => project.id));
  const groupOf = (session: SessionInfo) => known.has(session.projectId) ? session.projectId : '';
  const groups = new Map<string, { top: SessionInfo[]; extra: SessionInfo[]; more: boolean }>();
  const entry = (group: string) => {
    let value = groups.get(group);
    if (!value) groups.set(group, value = { top: [], extra: [], more: recent.more.includes(group) });
    return value;
  };
  for (const session of recent.sessions) {
    const value = entry(groupOf(session));
    (value.top.length < step ? value.top : value.extra).push(session);
  }
  const ordered = [...windows].sort((a, b) => a.offset - b.offset);
  for (const window of ordered) entry(window.group).more = window.page.more.includes(window.group);
  const sessions: SessionInfo[] = [], more: string[] = [], seen = new Set<string>();
  for (const [group, value] of groups) {
    const listed = [...value.top, ...ordered.filter(window => window.group === group).flatMap(window => window.page.sessions), ...value.extra];
    for (const session of listed) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      sessions.push(session);
    }
    if (value.more) more.push(group);
  }
  return { sessions, more };
}
