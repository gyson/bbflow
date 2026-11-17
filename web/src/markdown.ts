import MarkdownIt from 'markdown-it';
import type { StateCore, Token } from 'markdown-it';
import type { WorkspaceFile } from './protocol.js';
import { languageName } from './diff-model.js';

// The preview renders untrusted file text. markdown-it escapes all text, and html: false
// shows raw HTML as text. The rules below also keep links and images from loading
// content.
const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

// Only these links open, in a new tab. Other links, such as relative paths, show as text.
// The markdown-it link check also keeps javascript:, vbscript:, file:, and most data:
// links as Markdown source text.
const linkProtocols = new Set(['http:', 'https:', 'mailto:']);

function opens(href: string): boolean {
  try {
    return linkProtocols.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

function links(state: StateCore): void {
  for (const block of state.tokens) {
    let open: Token | null = null;
    for (const token of block.children ?? []) {
      if (token.type === 'link_open') {
        const href = String(token.attrGet('href') ?? '');
        if (opens(href)) {
          token.attrSet('target', '_blank');
          token.attrSet('rel', 'noopener noreferrer');
          open = null;
        } else {
          token.tag = 'span';
          token.attrs = [['class', 'md-link'], ['title', href]];
          open = token;
        }
      } else if (token.type === 'link_close' && open) {
        // Links do not nest, so the next close belongs to the open link.
        token.tag = 'span';
        open = null;
      }
    }
  }
}

// GitHub task list items. The checkbox is disabled. The preview never changes the file.
function taskLists(state: StateCore): void {
  const tokens = state.tokens;
  for (let index = 2; index < tokens.length; index++) {
    const inline = tokens[index];
    const item = tokens[index - 2];
    if (inline?.type !== 'inline' || item?.type !== 'list_item_open' || tokens[index - 1]?.type !== 'paragraph_open') continue;
    // Read the marker in the source text. The text token has resolved escapes and
    // entities, so "\[x]" and "&#91;x]" must stay text.
    const match = /^\[([ xX])\] /.exec(inline.content);
    const first = inline.children?.[0];
    if (!match || first?.type !== 'text' || !first.content.startsWith(match[0])) continue;
    first.content = first.content.slice(match[0].length);
    const box = new state.Token('html_inline', '', 0);
    box.content = `<input type="checkbox" disabled${match[1] === ' ' ? '' : ' checked'}> `;
    inline.children?.unshift(box);
    item.attrJoin('class', 'task-item');
  }
}

md.core.ruler.push('preview_links', links);
md.core.ruler.push('preview_task_lists', taskLists);

// The preview loads no images. It shows the alternative text and the source instead.
md.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index];
  if (!token) return '';
  const alt = self.renderInlineAsText(token.children ?? [], options, env);
  const source = String(token.attrGet('src') ?? '');
  const label = alt ? `${alt} (${source})` : source;
  return `<span class="md-image">Image not loaded: ${md.utils.escapeHtml(label)}</span>`;
};

export function renderMarkdown(text: string): string {
  return md.render(text);
}

// Preview shows the current text of a Markdown file. It is not available for a deleted
// file, a binary file, a file above the size limit, or a symbolic link.
export function previewable(file: WorkspaceFile): boolean {
  return languageName(file.path) === 'markdown' && file.new.state === 'text' && !file.new.symlink;
}
