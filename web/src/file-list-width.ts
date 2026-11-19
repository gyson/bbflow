import { dragDivider } from './divider-drag.js';
import { element } from './dom.js';

// Width limits in CSS pixels. The file view keeps room for the file header and the code.
const minWidth = 140, viewMinWidth = 280, step = 20;

// Return the file list width limits for a width of the list and the file view together.
export function fileListBounds(bodyWidth: number): { min: number; max: number } {
  return { min: minWidth, max: Math.max(minWidth, bodyWidth - viewMinWidth) };
}

// FileListWidth lets the divider between the file list and the file view of the
// Changes and Files views change the list width. Both views use the same width. The
// width belongs to this view of the page. Session changes keep it. Reload resets it.
export class FileListWidth {
  private readonly body = element('diff-body', HTMLElement);
  private readonly list = element('diff-files', HTMLElement);
  private readonly divider = element('diff-files-divider', HTMLElement);
  // A null width uses the default width from the style sheet.
  private width: number | null = null;

  constructor() {
    dragDivider(this.divider, 'x', 'resizing-file-list', {
      start: () => this.list.getBoundingClientRect().width,
      move: (width, offset) => this.resize(width + offset),
    });
    this.divider.ondblclick = () => {
      this.width = null;
      this.layout();
    };
    this.divider.onkeydown = event => {
      const bounds = this.bounds();
      const current = this.list.getBoundingClientRect().width;
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
    // The pane and the window change the space for the list.
    new ResizeObserver(() => this.layout()).observe(this.body);
  }

  private bounds(): { min: number; max: number } {
    return fileListBounds(this.body.clientWidth);
  }

  private resize(width: number): void {
    const { min, max } = this.bounds();
    this.width = Math.round(Math.max(min, Math.min(max, width)));
    this.layout();
  }

  private layout(): void {
    // A hidden pane has no width. Keep the values until it shows again.
    if (!this.body.clientWidth) return;
    const { min, max } = this.bounds();
    // Limit the displayed width to the narrower pane. Keep the preferred width.
    if (this.width === null) this.body.style.removeProperty('--file-list-width');
    else this.body.style.setProperty('--file-list-width', `${Math.max(min, Math.min(max, this.width))}px`);
    const width = Math.round(this.list.getBoundingClientRect().width);
    this.divider.setAttribute('aria-valuemin', String(min));
    this.divider.setAttribute('aria-valuemax', String(max));
    this.divider.setAttribute('aria-valuenow', String(width));
    this.divider.setAttribute('aria-valuetext', `File list ${width} pixels wide`);
  }
}
