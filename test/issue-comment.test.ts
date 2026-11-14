import test from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { issueComment } from '../src/issue-comment.js';

test('published plan renders separate list items, code and the next action', () => {
  const plan = '1. Inspect the handler.\n2. Exercise both paths.\n\n```ts\n  await check();\n```';
  const body = issueComment('needs-files', plan.replaceAll('\n', '\r\n'));
  assert.ok(body.includes(plan));
  const html = new MarkdownIt().render(body);
  assert.match(html, /<ol>\s*<li>Inspect the handler/);
  assert.match(html, /<code class="language-ts">  await check/);
  assert.match(html, /<p><strong>Next step<\/strong><\/p>/);
  assert.ok(body.endsWith('<!-- jam-bot:needs-files -->'));
});

test('completion preserves complete paragraphs and rejects malformed publication', () => {
  const result = 'A paragraph.\n\n' + 'A complete sentence. '.repeat(100);
  assert.ok(issueComment('completion', result).includes(result));
  assert.throws(() => issueComment('completion', '```js\nlet a = 1'), /Unclosed/);
  assert.throws(() => issueComment('needs-files', 'Steps: 1. First. 2. Second.'), /list/);
  assert.throws(() => issueComment('completion', 'x'.repeat(65536)), /size limit/);
});
