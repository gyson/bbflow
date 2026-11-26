import { ActionMenu } from './action-menu.js';
import { element } from './dom.js';
import { call } from './protocol.js';
import type { Prompt, PromptGroup, ServerInfo } from './protocol.js';
import { groupPrompts, samePromptGroups, samePrompts } from './settings-model.js';

interface Host {
  server(): ServerInfo | null;
  // blocked tells why text cannot go into the message editor now, or undefined.
  blocked(): string | undefined;
  // insert puts text at the cursor of the message editor. It returns a problem, or
  // undefined.
  insert(text: string): string | undefined;
  problem(text: string): void;
  // manage opens the Prompts card of Settings.
  manage(): void;
}

// The menu item shows this much of the text of a prompt. The tooltip shows more.
const previewLength = 120;
const tipLength = 600;
// The width of the flyout of a group, as in the style sheet. A menu without this room
// at its right shows the prompts of a group in place of its items.
const flyoutWidth = 280;
// A pointer that rests on a group opens its flyout after openDelay. A move to another
// item waits switchDelay, so that a diagonal move into the open flyout keeps it open.
const openDelay = 80;
const switchDelay = 220;

// summary is the text of a prompt on one line, with its spaces and lines joined, and cut
// to limit characters.
export function summary(text: string, limit: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

// The ＋ menu of the message editor attaches files, shows the handoff prompt, and puts a
// saved prompt at the cursor of the editor. It never sends. The saved prompts come from
// the settings. Another view can change them, so the menu reads them again each time it
// opens. Until the reply, it shows the prompts of the last read.
//
// The prompts without a group come first, then one item for each group with prompts. A
// group opens a flyout at the right of the menu, from a resting pointer, a click, or the
// Right key. Without the room for the flyout, as on a phone, the prompts of the group
// replace the items of the menu instead.
export class ComposerMenu {
  private readonly menu: ActionMenu;
  private readonly menuElement = element('composer-menu', HTMLElement);
  private readonly actions = element('composer-menu-actions', HTMLElement);
  private readonly label = element('composer-prompts-label', HTMLElement);
  private readonly list = element('composer-prompts', HTMLElement);
  private readonly note = element('composer-prompts-note', HTMLElement);
  private readonly manageButton = element('composer-prompts-manage', HTMLButtonElement);
  private readonly flyout = element('composer-flyout', HTMLElement);
  private prompts: Prompt[] = [];
  private groups: PromptGroup[] = [];
  private loaded = false;
  private failed = false;
  // The number of the latest read. Only its reply changes the list.
  private reads = 0;
  // The group that replaces the items of the menu, and the group of the open flyout.
  private path: string | null = null;
  private fly: string | null = null;
  private flyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly host: Host) {
    this.menu = new ActionMenu('composer-menu', () => {
      this.path = null;
      this.closeFlyout();
      this.render();
      void this.refresh();
    });
    this.manageButton.onclick = () => this.host.manage();
    this.menuElement.addEventListener('keydown', event => this.key(event));
    this.menuElement.addEventListener('pointerover', event => this.hover(event));
    // A pointer that leaves the menu and the flyout cancels a pending open or switch.
    this.menuElement.addEventListener('pointerleave', () => clearTimeout(this.flyTimer));
    this.list.addEventListener('scroll', () => this.closeFlyout());
    this.flyout.addEventListener('pointerenter', () => clearTimeout(this.flyTimer));
  }

  // Call this after the host shows, hides, or turns off an item, such as Handoff prompt.
  controls(): void {
    this.menu.controls();
    this.keepFocus();
  }

  // update applies the lock of the draft to the prompts and the note. The editor calls it
  // after each change of its controls, so an open menu follows a send from another view.
  update(): void {
    const blocked = this.host.blocked();
    for (const item of [...this.list.children, ...this.flyout.children]) {
      if (item instanceof HTMLButtonElement && item.dataset.promptId !== undefined && item.disabled !== !!blocked) item.disabled = !!blocked;
    }
    let note = '';
    if (this.failed && !this.loaded) note = 'Cannot read the saved prompts. Open the menu again to retry.';
    else if (!this.loaded) note = 'Loading the saved prompts…';
    else if (blocked) note = blocked;
    else if (!this.prompts.length) note = 'No saved prompts yet. Add one with Manage prompts.';
    if (this.note.textContent !== note) this.note.textContent = note;
    this.note.hidden = !note;
    this.keepFocus();
  }

  // A disabled item loses the focus, and the browser then gives it to the page, where
  // Escape no longer reaches the menu. The editor turns off Attach files, the first item,
  // and the lock turns off the saved prompts. When the focused item of the menu is off,
  // Manage prompts gets the focus, because it is always on.
  private keepFocus(): void {
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement && active.disabled && this.menuElement.contains(active)) this.manageButton.focus();
  }

  // refresh reads the saved prompts. A failed read keeps the prompts of the last read.
  async refresh(): Promise<void> {
    const server = this.host.server();
    if (!server) return;
    const read = ++this.reads;
    try {
      const settings = await call(server, { operation: 'settings-get' });
      if (read !== this.reads) return;
      const groups = settings.promptGroups ?? [];
      const changed = !this.loaded || this.failed || !samePrompts(settings.prompts, this.prompts) || !samePromptGroups(groups, this.groups);
      this.prompts = settings.prompts;
      this.groups = groups;
      this.loaded = true;
      this.failed = false;
      if (changed) this.render();
    } catch {
      if (read !== this.reads) return;
      this.failed = true;
      this.render();
    }
  }

  // The groups that the menu shows: the groups with prompts.
  private shownGroups(): PromptGroup[] {
    return this.groups.filter(group => this.prompts.some(prompt => prompt.group === group.id));
  }

  // render shows the saved prompts. The focused prompt or group keeps the focus, also
  // when the list has another order. When it went away, Manage prompts gets the focus, so
  // the focus stays in the menu.
  private render(): void {
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && (this.list.contains(active) || this.flyout.contains(active)) ? itemKey(active) : undefined;
    const groups = this.shownGroups();
    const group = groups.find(candidate => candidate.id === this.path);
    if (!group) this.path = null;
    // An open group replaces the other items. Its back item names it, so the label hides.
    this.label.hidden = this.actions.hidden = !!group;
    let items: HTMLElement[];
    if (group) {
      const back = document.createElement('button');
      back.type = 'button';
      back.setAttribute('role', 'menuitem');
      back.setAttribute('aria-label', `Back from ${group.name}`);
      back.className = 'prompt-back-item';
      back.dataset.back = 'true';
      back.textContent = `‹ ${group.name}`;
      back.onclick = event => {
        event?.stopPropagation();
        this.back();
      };
      items = [back, ...groupPrompts(this.prompts, group.id).map(prompt => this.item(prompt))];
    } else {
      items = [...groupPrompts(this.prompts, '').map(prompt => this.item(prompt)), ...groups.map(group => this.groupItem(group))];
    }
    this.list.replaceChildren(...items);
    if (this.fly !== null) {
      if (!group && groups.some(group => group.id === this.fly)) this.openFlyout(this.fly, false);
      else this.closeFlyout();
    }
    this.update();
    if (focused !== undefined) {
      const item = [...this.list.children, ...this.flyout.children].find(candidate => candidate instanceof HTMLButtonElement && itemKey(candidate) === focused && !candidate.disabled);
      (item instanceof HTMLButtonElement ? item : this.manageButton).focus();
    }
  }

  private item(prompt: Prompt): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.className = 'prompt-item';
    button.dataset.promptId = prompt.id;
    button.title = summary(prompt.text, tipLength);
    const name = document.createElement('span');
    name.className = 'prompt-item-name';
    name.textContent = prompt.name;
    const text = document.createElement('span');
    text.className = 'prompt-item-text';
    text.textContent = summary(prompt.text, previewLength);
    button.append(name, text);
    button.onclick = () => {
      const problem = this.host.insert(prompt.text);
      if (problem) this.host.problem(problem);
    };
    return button;
  }

  private groupItem(group: PromptGroup): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', String(this.fly === group.id));
    button.className = this.fly === group.id ? 'prompt-group-item open' : 'prompt-group-item';
    button.dataset.groupId = group.id;
    const name = document.createElement('span');
    name.className = 'prompt-group-item-name';
    name.textContent = group.name;
    const arrow = document.createElement('span');
    arrow.className = 'prompt-group-item-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '›';
    button.append(name, arrow);
    // A group item opens its prompts and keeps the menu open. A click from the keyboard
    // has the detail 0, and it moves the focus to the first prompt.
    button.onclick = event => {
      event?.stopPropagation();
      this.openGroup(group.id, event?.detail === 0);
    };
    return button;
  }

  private groupRow(id: string): HTMLElement | undefined {
    return [...this.list.children].find((item): item is HTMLElement => item instanceof HTMLElement && item.dataset.groupId === id);
  }

  // roomForFlyout tells if the flyout fits at the right of the menu.
  private roomForFlyout(): boolean {
    const menu = this.menuElement.getBoundingClientRect?.();
    const width = document.documentElement?.clientWidth;
    return !!menu && !!width && menu.right + 4 + flyoutWidth <= width - 8;
  }

  private openGroup(id: string, keyboard: boolean): void {
    if (this.roomForFlyout()) {
      this.openFlyout(id, keyboard);
      if (!keyboard) this.groupRow(id)?.focus();
      return;
    }
    this.closeFlyout();
    this.path = id;
    this.render();
    this.list.scrollTop = 0;
    const first = [...this.list.children].find(item => item instanceof HTMLButtonElement && item.dataset.promptId !== undefined && !item.disabled);
    (first instanceof HTMLElement ? first : this.list.children[0] as HTMLElement | undefined)?.focus();
  }

  private back(): void {
    const id = this.path;
    this.path = null;
    this.render();
    if (id !== null) this.groupRow(id)?.focus();
  }

  // openFlyout shows the prompts of the group at the right of the menu, next to the item
  // of the group. The flyout stays inside the height of the menu.
  private openFlyout(id: string, focusFirst: boolean): void {
    clearTimeout(this.flyTimer);
    const row = this.groupRow(id);
    const group = this.groups.find(candidate => candidate.id === id);
    if (!row || !group) return;
    this.fly = id;
    this.flyout.setAttribute('aria-label', group.name);
    this.flyout.replaceChildren(...groupPrompts(this.prompts, id).map(prompt => this.item(prompt)));
    this.flyout.hidden = false;
    for (const item of this.list.children) {
      if (!(item instanceof HTMLElement) || item.dataset.groupId === undefined) continue;
      const open = item.dataset.groupId === id;
      item.classList.toggle('open', open);
      item.setAttribute('aria-expanded', String(open));
    }
    const menu = this.menuElement.getBoundingClientRect(), place = row.getBoundingClientRect();
    this.flyout.style.maxHeight = `${menu.height}px`;
    const top = Math.max(0, Math.min(place.top - menu.top - 7, menu.height - this.flyout.offsetHeight));
    this.flyout.style.top = `${top}px`;
    this.flyout.scrollTop = 0;
    this.update();
    if (focusFirst) {
      const first = [...this.flyout.children].find(item => item instanceof HTMLButtonElement && item.dataset.promptId !== undefined && !item.disabled);
      (first instanceof HTMLElement ? first : row).focus();
    }
  }

  // closeFlyout hides the flyout. With refocus, the item of its group gets the focus.
  private closeFlyout(refocus = false): void {
    clearTimeout(this.flyTimer);
    const id = this.fly;
    if (id === null) return;
    this.fly = null;
    this.flyout.hidden = true;
    this.flyout.replaceChildren();
    for (const item of this.list.children) {
      if (!(item instanceof HTMLElement) || item.dataset.groupId === undefined) continue;
      item.classList.remove('open');
      item.setAttribute('aria-expanded', 'false');
    }
    if (refocus) this.groupRow(id)?.focus();
  }

  // A mouse pointer that rests on a group opens its flyout. A pointer on another item of
  // the menu, such as Attach files or Manage prompts, closes the flyout. A pointer in the
  // flyout keeps it open. Touch screens open a group with a tap.
  private hover(event: PointerEvent): void {
    if (event.pointerType !== 'mouse' || this.path !== null) return;
    const item = event.target instanceof Element ? event.target.closest('button') : null;
    if (!(item instanceof HTMLButtonElement) || !this.menuElement.contains(item)) return;
    clearTimeout(this.flyTimer);
    if (this.flyout.contains(item)) return;
    const id = item.dataset.groupId;
    if (id === undefined ? this.fly === null : id === this.fly || !this.roomForFlyout()) return;
    this.flyTimer = setTimeout(() => {
      if (this.menuElement.hidden) return;
      if (id === undefined) this.closeFlyout();
      else this.openFlyout(id, false);
    }, this.fly === null ? openDelay : switchDelay);
  }

  // The items that Up and Down move between: the items of the menu that show and are on,
  // and Manage prompts. In the flyout, they move between its prompts.
  private navigation(inFlyout: boolean): HTMLElement[] {
    const on = (parent: HTMLElement) => [...parent.children].filter((item): item is HTMLButtonElement => item instanceof HTMLButtonElement && !item.hidden && !item.disabled);
    if (inFlyout) return on(this.flyout).filter(item => item.dataset.promptId !== undefined);
    return [
      ...(this.actions.hidden ? [] : on(this.actions)),
      ...on(this.list),
      ...(this.manageButton.disabled ? [] : [this.manageButton]),
    ];
  }

  // key handles the keys of the groups and the flyout. The action menu handles Escape
  // when no group or flyout is open, and Tab.
  private key(event: KeyboardEvent): void {
    const target = document.activeElement;
    const inFlyout = target instanceof HTMLElement && this.flyout.contains(target);
    const group = target instanceof HTMLElement && !inFlyout ? target.dataset.groupId : undefined;
    const handled = () => { event.preventDefault(); event.stopPropagation(); };
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        handled();
        if (!inFlyout) this.closeFlyout();
        const items = this.navigation(inFlyout);
        const index = items.indexOf(target as HTMLElement);
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = index < 0 ? (step > 0 ? 0 : items.length - 1) : (index + step + items.length) % items.length;
        items[next]?.focus();
        return;
      }
      case 'ArrowRight':
        if (group !== undefined) {
          handled();
          this.openGroup(group, true);
        }
        return;
      case 'ArrowLeft':
        if (inFlyout) {
          handled();
          this.closeFlyout(true);
        } else if (this.path !== null) {
          handled();
          this.back();
        }
        return;
      case 'Escape':
        if (this.fly !== null) this.closeFlyout(true);
        else if (this.path !== null) this.back();
        else return;
        handled();
    }
  }
}

// itemKey names a prompt, a group, or the back item of the menu, so that a new render can
// find the same item.
function itemKey(item: HTMLElement): string | undefined {
  if (item.dataset.promptId !== undefined) return `p:${item.dataset.promptId}`;
  if (item.dataset.groupId !== undefined) return `g:${item.dataset.groupId}`;
  return item.dataset.back ? 'back' : undefined;
}
