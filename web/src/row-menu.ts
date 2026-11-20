// A row menu holds the actions of one session row in the sidebar. The ⋯ button of the row
// opens it, so a single click never runs an action. One row menu opens at a time. While
// it is open, the host keeps the buttons of the list. Thus a list refresh does not close
// the menu.

// run gets true when the user chose the item with the keyboard.
export interface RowAction { label: string; run: (keyboard: boolean) => void }

interface OpenMenu { box: HTMLElement; button: HTMLButtonElement; menu: HTMLElement }

const dotsIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4.5" cy="10" r="1.4"/><circle cx="10" cy="10" r="1.4"/><circle cx="15.5" cy="10" r="1.4"/></svg>';

export class RowMenus {
  private current: OpenMenu | null = null;

  // closed runs after a menu closes. The host then applies the list changes that it kept.
  constructor(private readonly closed: () => void) {
    document.addEventListener('click', event => {
      if (this.current && event.target instanceof Node && !this.current.box.contains(event.target)) this.close();
    });
  }

  get open(): boolean { return !!this.current; }

  // Return the ⋯ button of a row and its menu. The returned items are in the order of
  // actions, so that the host can hide an item that stops to apply. focus is the focus
  // key of the button.
  create(name: string, focus: string, actions: RowAction[]): { box: HTMLElement; button: HTMLButtonElement; items: HTMLButtonElement[] } {
    const box = document.createElement('span');
    box.className = 'row-menu-box';
    const button = document.createElement('button');
    button.className = 'row-menu-button';
    button.title = `Actions for ${name}`;
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = dotsIcon;
    button.dataset.focus = focus;
    const menu = document.createElement('div');
    menu.className = 'row-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', button.title);
    menu.hidden = true;
    const items = actions.map(item => {
      const choice = document.createElement('button');
      choice.setAttribute('role', 'menuitem');
      choice.textContent = item.label;
      choice.onclick = event => {
        // A click from the keyboard has no pointer detail. Move the focus to the menu
        // button first, so that a dialog of the action returns the focus there.
        const keyboard = event.detail === 0;
        button.focus();
        this.close();
        item.run(keyboard);
      };
      return choice;
    });
    menu.append(...items);
    button.onclick = () => {
      if (this.current?.button === button) this.close();
      else this.show({ box, button, menu });
    };
    box.addEventListener('keydown', event => {
      if (this.current?.box !== box) return;
      const shown = items.filter(item => !item.hidden);
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
        button.focus();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const index = shown.indexOf(document.activeElement as HTMLButtonElement);
        const step = event.key === 'ArrowDown' ? 1 : -1;
        shown[(index + step + shown.length) % shown.length]?.focus();
      } else if (event.key === 'Tab') {
        // Continue from the menu button. The browser then moves to the next control.
        this.close();
        button.focus();
      }
    });
    // A focus loss without a new target means that the window lost the focus.
    box.addEventListener('focusout', event => {
      if (this.current?.box === box && event.relatedTarget instanceof Node && !box.contains(event.relatedTarget)) this.close();
    });
    box.append(button, menu);
    return { box, button, items };
  }

  close(): void {
    const current = this.current;
    if (!current) return;
    this.current = null;
    current.menu.hidden = true;
    current.button.setAttribute('aria-expanded', 'false');
    current.box.classList.remove('open', 'up');
    this.closed();
  }

  private show(next: OpenMenu): void {
    this.close();
    this.current = next;
    next.menu.hidden = false;
    next.button.setAttribute('aria-expanded', 'true');
    next.box.classList.add('open');
    // Open upward when the list has no room below the button.
    const list = next.box.closest('#sessions')?.getBoundingClientRect();
    const menu = next.menu.getBoundingClientRect();
    if (list && menu.bottom > list.bottom && menu.height < next.button.getBoundingClientRect().top - list.top) next.box.classList.add('up');
    next.menu.querySelector<HTMLButtonElement>('button:not([hidden])')?.focus();
  }
}
