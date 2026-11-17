import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewable, renderMarkdown } from './dist/markdown.js';

test('raw HTML shows as text', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\nText <img src=x onerror="alert(1)"> <b onclick="x()">bold</b>\n');
  assert.doesNotMatch(html, /<script|<img|<b /);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test('only http, https, and mailto links open, in a new tab', () => {
  const html = renderMarkdown('[a](https://example.com/a) [b](http://example.com) [c](mailto:me@example.com)\n');
  assert.equal(html.match(/<a href="[^"]+" target="_blank" rel="noopener noreferrer">/g)?.length, 3);
});

test('other links show as text with their target in the title', () => {
  for (const href of ['SPEC.md', '../docs/GOAL.md', '#goal', '//example.com', 'ftp://example.com', 'ssh://host']) {
    const html = renderMarkdown(`[link](${href})\n`);
    assert.doesNotMatch(html, /<a\b/, href);
    assert.match(html, /<span class="md-link" title="[^"]*">link<\/span>/, href);
  }
});

test('script links stay Markdown source text', () => {
  for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd']) {
    const html = renderMarkdown(`[link](${href})\n`);
    assert.doesNotMatch(html, /<a\b|<span/, href);
    assert.match(html, /<p>\[link\]\(/, href);
  }
});

test('images do not load and show their text and source', () => {
  const html = renderMarkdown('![Flow <chart>](images/flow.png) ![](https://example.com/x.png)\n');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<span class="md-image">Image not loaded: Flow &lt;chart&gt; \(images\/flow\.png\)<\/span>/);
  assert.match(html, /<span class="md-image">Image not loaded: https:\/\/example\.com\/x\.png<\/span>/);
});

test('GitHub tables, strikethrough, and task lists render', () => {
  const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | ~~2~~ |\n\n- [x] done\n- [ ] open\n- [y] plain\n');
  assert.match(html, /<table>[\s\S]*<td><s>2<\/s><\/td>/);
  assert.match(html, /<li class="task-item"><input type="checkbox" disabled checked> done<\/li>/);
  assert.match(html, /<li class="task-item"><input type="checkbox" disabled> open<\/li>/);
  assert.match(html, /<li>\[y\] plain<\/li>/);
});

test('a checkbox prefix outside a list item stays text', () => {
  assert.equal(renderMarkdown('[ ] not a task\n'), '<p>[ ] not a task</p>\n');
});

const side = (state, extra = {}) => ({ state, size: 1, ...(state === 'text' ? { text: '# A' } : {}), ...extra });
const file = (path, current, old = side('text')) => ({ path, baseline: { kind: 'head' }, old, new: current });

test('preview is available for the current text of Markdown files only', () => {
  assert.equal(previewable(file('docs/PLAN.md', side('text'))), true);
  assert.equal(previewable(file('README.MARKDOWN', side('text'), side('missing'))), true);
  assert.equal(previewable(file('notes.txt', side('text'))), false);
  assert.equal(previewable(file('gone.md', side('missing'))), false);
  assert.equal(previewable(file('big.md', side('tooLarge'))), false);
  assert.equal(previewable(file('data.md', side('binary'))), false);
  assert.equal(previewable(file('link.md', side('text', { symlink: true }))), false);
});
