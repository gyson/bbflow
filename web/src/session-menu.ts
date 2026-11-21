import { element } from './dom.js';

// The More menu of the session toolbar holds the session actions that a user needs less
// often. The host shows or hides each item. The menu button shows only when an item shows.
export class SessionMenu {
  private readonly box = element('session-menu-box', HTMLElement);
  private readonly button = element('session-menu-open', HTMLButtonElement);
  private readonly menu = element('session-menu', HTMLElement);
  private readonly status = element('session-menu-status', HTMLElement);
  private readonly tip = this.button.dataset.tip ?? '';
  private confirmTimer: ReturnType<typeof setTimeout> | undefined;
  private expanded = false;

  constructor() {
    this.button.onclick = () => this.open(!this.expanded);
    const onItem = (event: Event) => event.target instanceof Element && !!event.target.closest('button');
    // Move the focus to the menu button before an item runs its action. A dialog that
    // the action opens then returns the focus to a control that stays visible.
    this.menu.addEventListener('click', event => { if (onItem(event)) this.button.focus(); }, true);
    // An item runs its own action next. Then the click reaches the menu and closes it.
    this.menu.addEventListener('click', event => { if (onItem(event)) this.open(false); });
    // Other code can move the focus out of the menu. A focus loss without a new target
    // means that the window lost the focus, and the menu stays open.
    this.box.addEventListener('focusout', event => {
      if (this.expanded && event.relatedTarget instanceof Node && !this.box.contains(event.relatedTarget)) this.open(false);
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
      } else if (event.key === 'Tab') {
        // Close the menu and continue from the menu button. The browser then moves the
        // focus to the control after or before that button.
        this.open(false);
        this.button.focus();
      }
    });
    document.addEventListener('click', event => {
      if (this.expanded && event.target instanceof Node && !this.box.contains(event.target)) this.open(false);
    });
  }

  // Show a short confirmation of an item, such as a copy, as the tooltip of the menu
  // button. A screen reader reads it from a status element.
  confirm(text: string): void {
    clearTimeout(this.confirmTimer);
    this.button.dataset.tip = this.status.textContent = text;
    this.button.classList.add('tip-open');
    this.confirmTimer = setTimeout(() => {
      this.button.dataset.tip = this.tip;
      this.status.textContent = '';
      this.button.classList.remove('tip-open');
    }, 1800);
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
