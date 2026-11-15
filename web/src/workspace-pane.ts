import type { DiffPane } from './diff-pane.js';
import type { SideTerminal } from './side-terminal.js';
import { dragDivider } from './divider-drag.js';
import { element } from './dom.js';

export type PaneView = 'changes' | 'files' | 'terminal';

const views: PaneView[] = ['changes', 'files', 'terminal'];
const minPaneWidth = 320;
const minSessionWidth = 360;

// WorkspacePane is the pane to the right of the session. It shows one view at a time.
// Changes shows the changed files and their diffs. Files shows the folders of the
// workspace and the current files. Terminal shows the side terminal. Each view has an
// icon in the session toolbar. The icon of the shown view closes the pane. The open
// state, the view, and the width belong to this view of the page. Other browser tabs
// keep their own state.
export class WorkspacePane {
  private readonly row = element('session-row', HTMLElement);
  private readonly pane = element('workspace-pane', HTMLElement);
  private readonly divider = element('workspace-divider', HTMLElement);
  private readonly diffPanel = element('diff-pane', HTMLElement);
  private readonly terminalPanel = element('side-terminal', HTMLElement);
  private readonly icons: Record<PaneView, HTMLButtonElement> = {
    changes: element('pane-changes', HTMLButtonElement),
    files: element('pane-files', HTMLButtonElement),
    terminal: element('pane-terminal', HTMLButtonElement),
  };

  private visible = false;
  private isOpen = false;
  private view: PaneView = 'changes';
  private width = 0;

  constructor(private readonly changes: DiffPane, private readonly terminal: SideTerminal) {
    for (const view of views) {
      this.icons[view].onclick = () => this.open(this.isOpen && this.view === view ? null : view);
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
  // home page, hides the pane and its icons. An open pane stays open for the next
  // session.
  select(session: string): void {
    this.visible = !!session;
    this.changes.select(session);
    this.terminal.select(session);
    this.apply(false);
  }

  // Show a view, or close the pane with null. A click starts a shell in Terminal when
  // the session has none.
  private open(view: PaneView | null): void {
    this.isOpen = !!view;
    if (view) this.view = view;
    this.apply(!!view);
  }

  private apply(click: boolean): void {
    const shown = this.isOpen && this.visible;
    this.pane.hidden = this.divider.hidden = !shown;
    for (const view of views) {
      const icon = this.icons[view];
      const current = shown && this.view === view;
      const label = `${current ? 'Hide' : 'Show'} ${view}`;
      icon.hidden = !this.visible;
      icon.setAttribute('aria-pressed', String(current));
      icon.setAttribute('aria-label', label);
      icon.dataset.tip = label;
    }
    this.diffPanel.hidden = this.view === 'terminal';
    this.terminalPanel.hidden = this.view !== 'terminal';
    // Show the panel before its content measures its size.
    const scope = this.view === 'files' ? 'files' : this.view === 'changes' ? 'changed' : undefined;
    this.changes.setShown(shown && this.view !== 'terminal', scope);
    this.terminal.setShown(shown && this.view === 'terminal', click);
  }

  private resize(width: number): void {
    const max = Math.max(minPaneWidth, this.row.clientWidth - minSessionWidth);
    this.width = Math.round(Math.max(minPaneWidth, Math.min(max, width)));
    this.pane.style.flexBasis = `${this.width}px`;
  }
}
