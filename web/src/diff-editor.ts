import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, highlightSpecialChars, lineNumbers } from '@codemirror/view';
import { defaultHighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { MergeView, unifiedMergeView } from '@codemirror/merge';
import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { yaml } from '@codemirror/lang-yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { languageName, type DiffLayout } from './diff-model.js';

// The diff and file views are read-only. CodeMirror renders file text as DOM text, never
// as HTML.
export interface CodeView { destroy(): void }

const collapse = { margin: 3, minSize: 4 };
// Stop the diff of a large file early. The result is then less exact, but the tab
// stays responsive.
const diffConfig = { scanLimit: 5000, timeout: 1500 };

const theme = EditorView.theme({
  '&': { fontSize: '12px', backgroundColor: '#fff', color: '#232a30' },
  '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  '.cm-gutters': { backgroundColor: '#f6f7f4', color: '#9aa29a', borderRight: '1px solid #e6e8e3' },
  '.cm-collapsedLines': { backgroundColor: '#eef3ef', color: '#477257', fontFamily: 'inherit' },
  '&.cm-focused': { outline: 'none' },
});

function language(path: string): Extension {
  switch (languageName(path)) {
    case 'javascript': return javascript();
    case 'jsx': return javascript({ jsx: true });
    case 'typescript': return javascript({ typescript: true });
    case 'tsx': return javascript({ typescript: true, jsx: true });
    case 'go': return go();
    case 'python': return python();
    case 'json': return json();
    case 'markdown': return markdown();
    case 'css': return css();
    case 'html': return html();
    case 'yaml': return yaml();
    case 'rust': return rust();
    case 'shell': return StreamLanguage.define(shell);
    default: return [];
  }
}

function extensions(path: string): Extension[] {
  return [
    lineNumbers(),
    highlightSpecialChars(),
    EditorState.readOnly.of(true),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    language(path),
    theme,
  ];
}

export function showDiff(parent: HTMLElement, path: string, oldText: string, newText: string, layout: DiffLayout): CodeView {
  if (layout === 'split') {
    return new MergeView({
      a: { doc: oldText, extensions: extensions(path) },
      b: { doc: newText, extensions: extensions(path) },
      parent,
      gutter: true,
      highlightChanges: true,
      collapseUnchanged: collapse,
      diffConfig,
    });
  }
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: newText,
      extensions: [
        ...extensions(path),
        unifiedMergeView({ original: oldText, mergeControls: false, gutter: true, highlightChanges: true, collapseUnchanged: collapse, diffConfig }),
      ],
    }),
  });
}

export function showFile(parent: HTMLElement, path: string, text: string): CodeView {
  return new EditorView({ parent, state: EditorState.create({ doc: text, extensions: extensions(path) }) });
}
