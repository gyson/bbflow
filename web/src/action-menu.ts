import { element } from './dom.js';

// An action menu holds actions that a user needs less often, behind a ⋯ button. The
// More menu of the session toolbar and the menu of the file header are action menus.
// The host shows or hides each item. The menu button shows only when an item shows.
// The page has a box `<id>-box`, a menu button `<id>-open`, a menu `<id>`, and a status
// element `<id>-status` for each menu.
export class ActionMenu {
  private readonly box: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly menu: HTMLElement;
  private readonly status: HTMLElement;
  private readonly tip: string;
  private confirmTimer: ReturnType<typeof setTimeout> | undefined;
  private expanded = false;

  constructor(id: string) {
    this.box = element(`${id}-box`, HTMLElement);
    this.button = element(`${id}-open`, HTMLButtonElement);
    this.menu = element(id, HTMLElement);
    this.status = element(`${id}-status`, HTMLElement);
    this.tip = this.button.dataset.tip ?? '';
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
  // button. A screen reader reads it from a status element. An error message is longer,
  // so the host can show it for a longer time.
  confirm(text: string, duration = 1800): void {
    clearTimeout(this.confirmTimer);
    this.button.dataset.tip = this.status.textContent = text;
    this.button.classList.add('tip-open');
    this.confirmTimer = setTimeout(() => this.clear(), duration);
  }

  // End the confirmation that shows now, for example when its subject goes away.
  clear(): void {
    clearTimeout(this.confirmTimer);
    this.button.dataset.tip = this.tip;
    this.status.textContent = '';
    this.button.classList.remove('tip-open');
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
