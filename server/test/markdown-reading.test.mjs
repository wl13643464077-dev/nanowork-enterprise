import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const requireWeb = createRequire(
  new URL("../../web/package.json", import.meta.url),
);
const ts = requireWeb("typescript");
const React = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");

function loadTs(file, dependencies = {}) {
  const exports = {};
  const source = readFileSync(
    new URL(`../../web/src/${file}`, import.meta.url),
    "utf8",
  );
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    }).outputText,
    {
      exports,
      URL,
      window: { location: { origin: "https://nanowork.test" } },
      require(name) {
        if (Object.hasOwn(dependencies, name)) return dependencies[name];
        if (name.endsWith(".css")) return {};
        return requireWeb(name);
      },
    },
  );
  return exports;
}

// Use the actual link sanitizer without making network requests or mounting the app.
const client = loadTs("api/client.ts", {
  antd: { message: {} },
  "./store-context": {},
});
const { Markdown } = loadTs("components/Markdown.tsx", {
  "../api/client": client,
});
const render = (content) =>
  renderToStaticMarkup(React.createElement(Markdown, { content }));

test("共享正文真实渲染超过八千字的中文全文，保留头尾和每段而不截断", () => {
  const paragraphs = Array.from(
    { length: 120 },
    (_, i) =>
      `第${i + 1}段：${"顾客反馈与出餐记录需要完整保留，便于老板对照原始事实再决定是否采纳。".repeat(4)}`,
  );
  const content = [
    "# 完整报告",
    ...paragraphs,
    "最终核对：全文末尾仍然可读。",
  ].join("\n\n");
  assert.ok(content.length > 8000);
  const html = render(content);
  for (const paragraph of paragraphs)
    assert.ok(html.includes(`<p>${paragraph}</p>`));
  assert.ok(html.includes("<h1>完整报告</h1>"));
  assert.ok(html.includes("<p>最终核对：全文末尾仍然可读。</p>"));
  assert.equal((html.match(/<p>/g) || []).length, 121);
});

test("宽表格只有独立可聚焦滚动区域，单元格、长代码、列表和引用均完整渲染", () => {
  const code = `const record = "${"完整记录ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(12)}";`;
  const html = render(
    [
      "## 执行对照",
      "### 店长安排",
      "1. 记录出餐时间\n   - 保留顾客原话\n2. 周末复查",
      "> 尚未确认的经营判断需要人工核对。",
      "| 项目 | 记录 |\n| --- | --- |\n| 午餐 | 完整事实甲 |\n| 晚餐 | 完整事实乙 |",
      `\`\`\`js\n${code}\n\`\`\``,
    ].join("\n\n"),
  );
  assert.match(html, /<h2>执行对照<\/h2>/u);
  assert.match(html, /<h3>店长安排<\/h3>/u);
  assert.match(html, /<ol>[\s\S]*<ul>[\s\S]*保留顾客原话/u);
  assert.match(html, /<blockquote>[\s\S]*尚未确认的经营判断需要人工核对/u);
  assert.match(
    html,
    /<div class="md-table-scroll" role="region" aria-label="报告表格（可横向滚动）" tabindex="0"><table>/u,
  );
  assert.equal((html.match(/<td>/g) || []).length, 4);
  assert.match(html, /<td>完整事实甲<\/td>/u);
  assert.match(html, /<td>完整事实乙<\/td>/u);
  assert.ok(html.includes(code.replaceAll('"', "&quot;")));
  assert.match(html, /<pre><code class="language-js">/u);
});

test("来源和长 URL 保留为安全链接，正文排版不引入脚本或外链图片", () => {
  const url = `https://example.com/research/${"complete-original-reference-".repeat(20)}`;
  const html = render(
    `[来源全文](${url})\n\n[站内记录](/tasks/1)\n\n[危险地址](javascript:alert)\n\n![外链图](https://example.com/tracker.png)\n\n<script>alert('x')</script>`,
  );
  assert.ok(html.includes(`href="${url}"`));
  assert.match(
    html,
    /href="\/tasks\/1" target="_blank" rel="noopener noreferrer"/u,
  );
  assert.match(
    html,
    /href="#" target="_blank" rel="noopener noreferrer">危险地址/u,
  );
  assert.doesNotMatch(html, /<img\b|<script\b|href="javascript:/u);
  assert.match(html, /来源全文/u);
});
