import { element } from './dom.js';

// The page keeps at most this number of error toasts. A new toast removes the oldest one.
export const toastLimit = 3;

// Error toasts show a failed action that has no place of its own in the page, such as an
// action from the row menu of another session. Each toast names the failed action and
// gives the reason. It stays until the user closes it, so that the user can read it.
export class ErrorToasts {
  private readonly host = element('toasts', HTMLElement);

  show(title: string, detail: string): void {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'alert');
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '!';
    const text = document.createElement('div');
    text.className = 'toast-text';
    const heading = document.createElement('strong');
    heading.textContent = title;
    text.append(heading, detail);
    const close = document.createElement('button');
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Close error');
    close.textContent = '×';
    close.onclick = () => toast.remove();
    toast.append(icon, text, close);
    this.host.append(toast);
    while (this.host.children.length > toastLimit) this.host.firstElementChild?.remove();
  }
}
