import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown } from "./markdown.js";

test("emphasis renders while code and raw HTML remain literal", () => {
  const html = renderMarkdown("**重点**\n\n`**原样**`\n\n```text\na * b\n```\n\n<b>原文</b>");
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<code>\*\*原样\*\*<\/code>/);
  assert.match(html, /<pre><code[^>]*>a \* b/);
  assert.ok(html.includes("&lt;b&gt;原文&lt;/b&gt;"));
});

test("web links remain usable and image descriptions do not fetch files", () => {
  assert.ok(renderMarkdown("[文档](https://example.org)").includes('href="https://example.org"'));
  assert.equal(renderMarkdown("![示意图](https://example.org/image.png)").trim(), "<p>示意图</p>");
});
