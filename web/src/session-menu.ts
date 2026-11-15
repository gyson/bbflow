import { element } from './dom.js';

// The More menu of the session toolbar holds the session actions that a user needs less
// often. The host shows or hides each item. The menu button shows only when an item shows.
export class SessionMenu {
  private readonly box = element('session-menu-box', HTMLElement);
  private readonly button = element('session-menu-open', HTMLButtonElement);
  private readonly menu = element('session-menu', HTMLElement);
  private expanded = false;

  constructor() {
    this.button.onclick = () => this.open(!this.expanded);
    // An item runs its own action first. Then the click reaches the menu and closes it.
    this.menu.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('button')) this.open(false);
    });
    this.box.addEventListener('keydown', event => {
      if (!this.expanded) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this.open(false);
        this.button.focus();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const items = this.items();
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const step = event.key === 'ArrowDown' ? 1 : -1;
        items[(index + step + items.length) % items.length]?.focus();
      }
    });
    document.addEventListener('click', event => {
      if (this.expanded && event.target instanceof Node && !this.box.contains(event.target)) this.open(false);
    });
  }

  // Call this after the host changes the items.
  controls(): void {
    this.button.hidden = this.items().length === 0;
    if (this.button.hidden) this.open(false);
  }

  private items(): HTMLButtonElement[] {
    return [...this.menu.querySelectorAll('button')].filter(item => !item.hidden);
  }

  private open(open: boolean): void {
    this.expanded = open;
    this.menu.hidden = !open;
    this.button.setAttribute('aria-expanded', String(open));
    if (open) this.items().find(item => !item.disabled)?.focus();
  }
}
