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

test("CJK prose can touch a quoted strong phrase without adding spaces", () => {
  for (const [input, phrase] of [
    ["一对**“猫猫狗狗一起吃蛋挞”的配套头像**。", "“猫猫狗狗一起吃蛋挞”的配套头像"],
    ["推荐**《新书》**给你", "《新书》"],
    ["这里**很重要！**要记住", "很重要！"],
  ]) assert.ok(renderMarkdown(input).includes(`<strong>${phrase}</strong>`));
  const literal = "一对**“原样”**文字";
  assert.ok(renderMarkdown("`" + literal + "`").includes("<code>" + literal + "</code>"));
  assert.ok(!renderMarkdown("一对\\*\\*“原样”\\*\\*文字").includes("<strong>"));
  assert.ok(!renderMarkdown("一对**“尚未结束").includes("<strong>"));
});

test("Skill documents preserve Markdown paragraphs, structure and fenced examples", async () => {
  const {renderSkillMarkdown} = await import("./markdown.js");
  const html = renderSkillMarkdown("## 查找\n\n第一行\n第二行\n\n> **提示**\n\n1. `search_memory`\n   - 原文\n\n|类|例|\n|---|---|\n|水果|草莓|\n\n```md\n**原样**\n```\n\n<script>alert(1)</script>");
  for (const fragment of ["<h2>查找</h2>","第一行\n第二行","<blockquote>","<strong>提示</strong>","<ol>","<ul>","<td>草莓</td>","<code>search_memory</code>","**原样**","&lt;script&gt;"]) assert.ok(html.includes(fragment),fragment);
  assert.ok(!html.includes("<br"));
});
