import { ActionMenu } from './action-menu.js';
import { element } from './dom.js';
import { call } from './protocol.js';
import type { Prompt, ServerInfo } from './protocol.js';
import { samePrompts } from './settings-model.js';

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
export class ComposerMenu {
  private readonly menu: ActionMenu;
  private readonly list = element('composer-prompts', HTMLElement);
  private readonly note = element('composer-prompts-note', HTMLElement);
  private prompts: Prompt[] = [];
  private loaded = false;
  private failed = false;
  // The number of the latest read. Only its reply changes the list.
  private reads = 0;

  constructor(private readonly host: Host) {
    this.menu = new ActionMenu('composer-menu', () => {
      this.render();
      void this.refresh();
    });
    element('composer-prompts-manage', HTMLButtonElement).onclick = () => this.host.manage();
  }

  // Call this after the host shows or hides an item, such as Handoff prompt.
  controls(): void { this.menu.controls(); }

  // refresh reads the saved prompts. A failed read keeps the prompts of the last read.
  async refresh(): Promise<void> {
    const server = this.host.server();
    if (!server) return;
    const read = ++this.reads;
    try {
      const settings = await call(server, { operation: 'settings-get' });
      if (read !== this.reads) return;
      const changed = !this.loaded || this.failed || !samePrompts(settings.prompts, this.prompts);
      this.prompts = settings.prompts;
      this.loaded = true;
      this.failed = false;
      if (changed) this.render();
    } catch {
      if (read !== this.reads) return;
      this.failed = true;
      this.render();
    }
  }

  // render shows the saved prompts. An item that has the focus keeps it.
  private render(): void {
    const blocked = this.host.blocked();
    const focused = [...this.list.children].indexOf(document.activeElement as Element);
    const items = this.prompts.map(prompt => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.className = 'prompt-item';
      button.title = summary(prompt.text, tipLength);
      const name = document.createElement('span');
      name.className = 'prompt-item-name';
      name.textContent = prompt.name;
      const text = document.createElement('span');
      text.className = 'prompt-item-text';
      text.textContent = summary(prompt.text, previewLength);
      button.append(name, text);
      button.disabled = !!blocked;
      button.onclick = () => {
        const problem = this.host.insert(prompt.text);
        if (problem) this.host.problem(problem);
      };
      return button;
    });
    this.list.replaceChildren(...items);
    let note = '';
    if (this.failed && !this.loaded) note = 'Cannot read the saved prompts. Open the menu again to retry.';
    else if (!this.loaded) note = 'Loading the saved prompts…';
    else if (!items.length) note = 'No saved prompts yet. Add one with Manage prompts.';
    else if (blocked) note = blocked;
    this.note.textContent = note;
    this.note.hidden = !note;
    // A focused item that went away gives the focus to Manage prompts, so it stays in the menu.
    if (focused >= 0) (items[Math.min(focused, items.length - 1)] ?? element('composer-prompts-manage', HTMLButtonElement)).focus();
  }
}
