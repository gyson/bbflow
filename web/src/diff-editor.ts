import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, highlightSpecialChars, lineNumbers } from '@codemirror/view';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
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
import { scala } from '@codemirror/legacy-modes/mode/clike';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { tags } from '@lezer/highlight';
import { languageName, type DiffLayout } from './diff-model.js';

// The diff and file views are read-only. CodeMirror renders file text as DOM text, never
// as HTML.
export interface CodeView { destroy(): void }

const collapse = { margin: 3, minSize: 4 };
// Stop the diff of a large file early. The result is then less exact, but the tab
// stays responsive.
const diffConfig = { scanLimit: 5000, timeout: 1500 };

const theme = EditorView.theme({
  '&': { fontSize: '12px', backgroundColor: 'var(--diff-background)', color: 'var(--text)' },
  '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', caretColor: 'var(--text)' },
  '.cm-specialChar': { color: 'var(--danger)' },
  '.cm-gutters': { backgroundColor: 'var(--inset)', color: 'var(--text-muted)', borderRight: '1px solid var(--divider)' },
  '.cm-content ::selection, .cm-content::selection': { background: 'var(--selected-border)', color: 'var(--text)' },
  '.cm-collapsedLines': { background: 'var(--inset)', color: 'var(--accent-text)', fontFamily: 'inherit' },
  '&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
  // Use stronger fills for changed text within each changed line.
  '&.cm-merge-a .cm-changedLine, .cm-deletedChunk': { backgroundColor: 'var(--diff-remove-line)' },
  '&.cm-merge-b .cm-changedLine': { backgroundColor: 'var(--diff-add-line)' },
  '&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText, &.cm-merge-b .cm-deletedText': {
    background: 'var(--diff-remove-text)', borderRadius: '2px',
  },
  '&.cm-merge-b .cm-changedText': { background: 'var(--diff-add-text)', borderRadius: '2px' },
  '.cm-changeGutter': { width: '1.3em', padding: '0', textAlign: 'center' },
  '&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter': {
    background: 'var(--diff-remove-line)', color: 'var(--danger)',
  },
  '&.cm-merge-b .cm-changedLineGutter': { background: 'var(--diff-add-line)', color: 'var(--positive)' },
  '&.cm-merge-a .cm-changedLineGutter::before, .cm-deletedLineGutter::before': { content: '"−"' },
  '&.cm-merge-b .cm-changedLineGutter::before': { content: '"+"' },
});

const codeHighlight = HighlightStyle.define([
  { tag: [tags.meta, tags.labelName, tags.contentSeparator], color: 'var(--code-meta)' },
  { tag: [tags.link, tags.url], textDecoration: 'underline' },
  { tag: tags.heading, textDecoration: 'underline', fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.keyword, color: 'var(--code-keyword)' },
  { tag: [tags.literal, tags.atom, tags.bool, tags.inserted], color: 'var(--code-literal)' },
  { tag: [tags.string, tags.regexp, tags.escape, tags.deleted], color: 'var(--code-string)' },
  {
    tag: [tags.definition(tags.variableName), tags.local(tags.variableName), tags.special(tags.variableName),
      tags.definition(tags.propertyName), tags.typeName, tags.namespace, tags.className, tags.macroName],
    color: 'var(--code-name)',
  },
  { tag: tags.comment, color: 'var(--code-comment)' },
  { tag: tags.invalid, color: 'var(--danger)' },
]);

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
    case 'scala': return StreamLanguage.define(scala);
    case 'shell': return StreamLanguage.define(shell);
    default: return [];
  }
}

function extensions(path: string): Extension[] {
  return [
    lineNumbers(),
    highlightSpecialChars(),
    EditorState.readOnly.of(true),
    syntaxHighlighting(codeHighlight),
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
