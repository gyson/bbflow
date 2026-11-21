import type { DiffPane } from './diff-pane.js';
import type { SideTerminal } from './side-terminal.js';
import { dragDivider } from './divider-drag.js';
import { element } from './dom.js';

export type PaneView = 'changes' | 'files' | 'terminal';

const views: PaneView[] = ['changes', 'files', 'terminal'];

// WorkspacePane is the pane to the right of the session. It shows one view at a time.
// Changes shows the changed files and their diffs. Files shows the folders of the
// workspace and the current files. Terminal shows the side terminal. Each view has an
// icon in the session toolbar. The icon of the shown view closes the pane. Each session
// has its own open state and view. A session that this view of the page has not shown
// yet starts with a closed pane. All sessions use the same width. This view of the page
// keeps the state. Other browser tabs keep their own state.
//
// The CSS keeps the minimum widths of the session and the pane. A narrower window makes
// the pane narrower first, and a wider window gives back the preferred width. When the
// main area cannot hold both minimum widths, the pane goes below the session.
export class WorkspacePane {
  private readonly sessionView = element('session-view', HTMLElement);
  private readonly pane = element('workspace-pane', HTMLElement);
  private readonly divider = element('workspace-divider', HTMLElement);
  private readonly diffPanel = element('diff-pane', HTMLElement);
  private readonly terminalPanel = element('side-terminal', HTMLElement);
  private readonly icons: Record<PaneView, HTMLButtonElement> = {
    changes: element('pane-changes', HTMLButtonElement),
    files: element('pane-files', HTMLButtonElement),
    terminal: element('pane-terminal', HTMLButtonElement),
  };

  private session = '';
  // The shown view of each session with an open pane. A closed pane has no entry.
  private readonly views = new Map<string, PaneView>();

  constructor(private readonly changes: DiffPane, private readonly terminal: SideTerminal) {
    for (const view of views) {
      this.icons[view].onclick = () => this.open(this.views.get(this.session) === view ? null : view);
    }
    changes.close = () => this.open(null);
    changes.openChanges = () => this.open('changes');
    element('side-close', HTMLButtonElement).onclick = () => this.open(null);
    dragDivider(this.divider, 'x', 'resizing-diff', {
      start: () => this.pane.getBoundingClientRect().width,
      // A drag to the left makes the pane wider.
      move: (width, offset) => this.resize(width - offset),
    });
    this.divider.onkeydown = event => {
      const width = this.pane.getBoundingClientRect().width;
      if (event.key === 'ArrowLeft') this.resize(width + 20);
      else if (event.key === 'ArrowRight') this.resize(width - 20);
      else return;
      event.preventDefault();
    };
    this.apply(false);
  }

  // Select the session of this view. An empty session, for a draft, Settings, or the
  // home page, hides the pane and its icons. The pane shows the state of the selected
  // session.
  select(session: string): void {
    this.session = session;
    // Hide the views first. Then they do not load or join anything with the state of
    // the previous session. apply shows the view of the selected session.
    this.changes.setShown(false);
    this.terminal.setShown(false, false);
    this.changes.select(session);
    this.terminal.select(session);
    this.apply(false);
  }

  // Show a view, or close the pane with null. A click starts a shell in Terminal when
  // the session has none.
  private open(view: PaneView | null): void {
    if (!this.session) return;
    if (view) this.views.set(this.session, view);
    else this.views.delete(this.session);
    this.apply(!!view);
  }

  private apply(click: boolean): void {
    const view = this.views.get(this.session);
    this.pane.hidden = this.divider.hidden = !view;
    for (const name of views) {
      const icon = this.icons[name];
      const current = view === name;
      const label = `${current ? 'Hide' : 'Show'} ${name}`;
      icon.hidden = !this.session;
      icon.setAttribute('aria-pressed', String(current));
      icon.setAttribute('aria-label', label);
      icon.dataset.tip = label;
    }
    // A closed pane keeps its panel and its scope until it shows a view again.
    if (view) {
      this.diffPanel.hidden = view === 'terminal';
      this.terminalPanel.hidden = view !== 'terminal';
    }
    // Show the panel before its content measures its size.
    const scope = view === 'files' ? 'files' : view === 'changes' ? 'changed' : undefined;
    this.changes.setShown(!!view && view !== 'terminal', scope);
    this.terminal.setShown(view === 'terminal', click);
  }

  // Set the preferred width. Limit it to the widths that the row can show now, so that
  // the pane never gets wider than a width that the user saw.
  private resize(width: number): void {
    const min = parseFloat(getComputedStyle(this.pane).minWidth);
    const spare = this.sessionView.getBoundingClientRect().width - parseFloat(getComputedStyle(this.sessionView).minWidth);
    const max = Math.max(min, this.pane.getBoundingClientRect().width + spare);
    this.pane.style.setProperty('--pane-width', `${Math.round(Math.max(min, Math.min(max, width)))}px`);
  }
}
