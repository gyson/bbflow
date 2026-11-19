import { StreamLanguage, type Language } from '@codemirror/language';
import { cssLanguage } from '@codemirror/lang-css';
import { goLanguage } from '@codemirror/lang-go';
import { htmlLanguage } from '@codemirror/lang-html';
import { javascriptLanguage, jsxLanguage, tsxLanguage, typescriptLanguage } from '@codemirror/lang-javascript';
import { jsonLanguage } from '@codemirror/lang-json';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { pythonLanguage } from '@codemirror/lang-python';
import { rustLanguage } from '@codemirror/lang-rust';
import { yamlLanguage } from '@codemirror/lang-yaml';
import { scala } from '@codemirror/legacy-modes/mode/clike';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { tagHighlighter, tags } from '@lezer/highlight';
import type { Language as FileLanguage } from './diff-model.js';

// The file view, the diff, and the fenced code of Preview use these classes. The .hl-
// rules in style.css give their colors. A later rule there wins when a token has two
// classes.
export const codeHighlighter = tagHighlighter([
  { tag: tags.quote, class: 'hl-quote' },
  { tag: [tags.meta, tags.labelName, tags.contentSeparator], class: 'hl-meta' },
  { tag: tags.emphasis, class: 'hl-emphasis' },
  { tag: tags.strong, class: 'hl-strong' },
  { tag: tags.strikethrough, class: 'hl-strikethrough' },
  { tag: tags.keyword, class: 'hl-keyword' },
  { tag: [tags.literal, tags.atom, tags.bool, tags.inserted], class: 'hl-literal' },
  { tag: [tags.string, tags.regexp, tags.escape, tags.deleted], class: 'hl-string' },
  {
    tag: [tags.definition(tags.variableName), tags.local(tags.variableName), tags.special(tags.variableName),
      tags.definition(tags.propertyName), tags.typeName, tags.namespace, tags.className, tags.macroName],
    class: 'hl-name',
  },
  { tag: tags.comment, class: 'hl-comment' },
  { tag: tags.invalid, class: 'hl-invalid' },
  { tag: tags.heading, class: 'hl-heading' },
  { tag: tags.link, class: 'hl-link' },
  { tag: tags.url, class: 'hl-url' },
  { tag: tags.monospace, class: 'hl-monospace' },
  { tag: tags.processingInstruction, class: 'hl-marker' },
]);

const scalaLanguage = StreamLanguage.define(scala);
const shellLanguage = StreamLanguage.define(shell);

export function parser(name: FileLanguage): Language | null {
  switch (name) {
    case 'javascript': return javascriptLanguage;
    case 'jsx': return jsxLanguage;
    case 'typescript': return typescriptLanguage;
    case 'tsx': return tsxLanguage;
    case 'go': return goLanguage;
    case 'python': return pythonLanguage;
    case 'json': return jsonLanguage;
    case 'markdown': return markdownLanguage;
    case 'css': return cssLanguage;
    case 'html': return htmlLanguage;
    case 'yaml': return yamlLanguage;
    case 'rust': return rustLanguage;
    case 'scala': return scalaLanguage;
    case 'shell': return shellLanguage;
    default: return null;
  }
}
