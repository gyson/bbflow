import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, highlightSpecialChars, lineNumbers } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { MergeView, unifiedMergeView } from '@codemirror/merge';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { codeHighlighter, parser } from './code-highlight.js';
import { fenceLanguage, languageName, type DiffLayout } from './diff-model.js';

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

// GitHub Flavored Markdown. A fenced code block with a known language gets the colors of
// that language. A nested Markdown block does not color its own fenced code blocks.
const markdownSupport = markdown({ base: markdownLanguage, codeLanguages: info => parser(fenceLanguage(info)) });

function language(path: string): Extension {
  const name = languageName(path);
  return name === 'markdown' ? markdownSupport : parser(name) ?? [];
}

function extensions(path: string): Extension[] {
  return [
    lineNumbers(),
    highlightSpecialChars(),
    EditorState.readOnly.of(true),
    syntaxHighlighting(codeHighlighter),
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
