import { dragDivider } from './divider-drag.js';
import { element } from './dom.js';

// Width limits in CSS pixels. The main area keeps room for the toolbar and terminal.
const minWidth = 240, maxWidth = 480, mainMinWidth = 400, step = 20;

// The page uses the mobile layout at this window width or less. Keep this width the same
// as the width of the mobile layout rules in style.css.
export const mobileQuery = '(max-width: 700px)';

// Return the sidebar width limits for a window width.
export function sidebarBounds(windowWidth: number): { min: number; max: number } {
  return { min: minWidth, max: Math.max(minWidth, Math.min(maxWidth, windowWidth - mainMinWidth)) };
}

// Return the key of the row that gets the keyboard focus after a row leaves the list.
// before has the keys of the shown rows before the change, and after has them after the
// change. The nearest later row comes first, then the nearest earlier row.
export function nearestRow(before: string[], removed: string, after: string[]): string | undefined {
  const index = before.indexOf(removed);
  const shown = new Set(after);
  const order = index < 0 ? before : [...before.slice(index + 1), ...before.slice(0, index).reverse()];
  return order.find(key => key !== removed && shown.has(key));
}

function mainArea(): HTMLElement {
  const main = document.querySelector('main');
  if (!main) throw new Error('Missing UI element: main');
  return main;
}

// Sidebar holds the width and the visibility of the sidebar. In the mobile layout, the
// sidebar is a drawer above the main area. The drawer has its own state. It starts
// closed, except on the welcome view, and a change of the layout sets it again.
export class Sidebar {
  private readonly sidebar = element('sidebar', HTMLElement);
  private readonly scrim = element('sidebar-scrim', HTMLElement);
  private readonly divider = element('sidebar-divider', HTMLElement);
  private readonly toggle = element('sidebar-toggle', HTMLButtonElement);
  private readonly main = mainArea();
  // These preferences belong to the view. Session changes preserve them. Reload resets them.
  // A null width uses the default width from the style sheet.
  private width: number | null = null;
  private visible = true;
  private drawer: boolean;
  // The element that had the focus before the drawer opened. It gets the focus again when
  // the drawer closes.
  private returnFocus: HTMLElement | null = null;
  private readonly drawerLayout = matchMedia(mobileQuery);
  private readonly stopDrag: () => void;

  // home tells if the page shows the welcome view.
  constructor(private readonly home: () => boolean) {
    this.drawer = home();
    // The drawer takes the focus when no row of the drawer can take it.
    this.sidebar.tabIndex = -1;
    this.stopDrag = dragDivider(this.divider, 'x', 'resizing-sidebar', {
      start: () => this.sidebar.getBoundingClientRect().width,
      move: (width, offset) => this.resize(width + offset),
    });
    this.divider.ondblclick = () => {
      this.width = null;
      this.layout();
    };
    this.divider.onkeydown = event => {
      const bounds = this.bounds();
      const current = this.sidebar.getBoundingClientRect().width;
      let width: number;
      switch (event.key) {
        case 'ArrowLeft': width = current - step; break;
        case 'ArrowRight': width = current + step; break;
        case 'Home': width = bounds.min; break;
        case 'End': width = bounds.max; break;
        default: return;
      }
      event.preventDefault();
      this.resize(width);
    };
    this.toggle.onclick = () => this.show(!this.shown);
    this.scrim.onclick = () => this.show(false);
    // Command-B toggles the sidebar on macOS. Ctrl+B stays with terminal programs.
    window.addEventListener('keydown', event => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'b') return;
      event.preventDefault();
      if (!event.repeat) this.show(!this.shown);
    }, true);
    // Escape closes the drawer. An open row menu or dialog takes Escape first.
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented || !this.narrow || !this.drawer) return;
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      this.show(false);
    });
    this.drawerLayout.addEventListener('change', () => {
      this.stopDrag();
      this.drawer = this.home();
      this.apply();
    });
    window.addEventListener('resize', () => this.layout());
    this.apply();
  }

  // Open or close the drawer of the mobile layout. The sidebar of a wider window stays
  // as it is.
  setDrawer(open: boolean): void {
    if (this.narrow && this.drawer !== open) this.show(open);
  }

  // Tell if the sidebar is a drawer now.
  private get narrow(): boolean { return this.drawerLayout.matches; }

  private get shown(): boolean { return this.narrow ? this.drawer : this.visible; }

  private show(shown: boolean): void {
    this.stopDrag();
    const focus = document.activeElement;
    const opens = this.narrow && shown && !this.drawer;
    if (opens) this.returnFocus = focus instanceof HTMLElement && !this.sidebar.contains(focus) ? focus : null;
    if (this.narrow) this.drawer = shown;
    else this.visible = shown;
    this.apply();
    // The open drawer covers the main area, so it takes the keyboard focus. When the drawer
    // closes, the focus goes back to where it was. Keep keyboard focus on a visible control.
    if (opens) this.focusDrawer();
    else if (!shown && (this.sidebar.contains(focus) || focus === this.divider || (this.narrow && (!focus || focus === document.body)))) {
      this.restoreFocus();
    }
  }

  // Give the focus to the row of the selected session, or else to the drawer.
  private focusDrawer(): void {
    this.sidebar.querySelector<HTMLElement>('#sessions [aria-current="true"]')?.focus();
    if (!this.sidebar.contains(document.activeElement)) this.sidebar.focus();
  }

  private restoreFocus(): void {
    const target = this.returnFocus;
    this.returnFocus = null;
    if (this.narrow && target?.isConnected) target.focus();
    if (!target || document.activeElement !== target) this.toggle.focus();
  }

  private apply(): void {
    const shown = this.shown;
    this.sidebar.hidden = this.divider.hidden = !shown;
    this.scrim.hidden = !shown || !this.narrow;
    // The main area under the open drawer takes no focus and no input.
    this.main.inert = shown && this.narrow;
    const label = shown ? 'Hide sidebar' : 'Show sidebar';
    this.toggle.setAttribute('aria-expanded', String(shown));
    this.toggle.setAttribute('aria-label', label);
    this.toggle.dataset.tip = `${label} (⌘B)`;
    if (shown) this.layout();
  }

  private bounds(): { min: number; max: number } {
    return sidebarBounds(document.documentElement.clientWidth);
  }

  private resize(width: number): void {
    const { min, max } = this.bounds();
    this.width = Math.round(Math.max(min, Math.min(max, width)));
    this.layout();
  }

  private layout(): void {
    if (!this.shown) return;
    const { min, max } = this.bounds();
    // Limit the displayed width to the smaller window. Keep the preferred width.
    if (this.width === null) this.sidebar.style.removeProperty('--sidebar-width');
    else this.sidebar.style.setProperty('--sidebar-width', `${Math.max(min, Math.min(max, this.width))}px`);
    const width = Math.round(this.sidebar.getBoundingClientRect().width);
    this.divider.setAttribute('aria-valuemin', String(min));
    this.divider.setAttribute('aria-valuemax', String(max));
    this.divider.setAttribute('aria-valuenow', String(width));
    this.divider.setAttribute('aria-valuetext', `Sidebar ${width} pixels wide`);
  }
}
