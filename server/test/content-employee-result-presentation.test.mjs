import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { contentRunResultPreview } from "../src/engines/content-result-presentation.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, "../..");

test("内容员工 JSON 产物列表预览必须是人能读的摘要", () => {
  const preview = contentRunResultPreview(`\`\`\`json
  {"publish_plan":"先发小红书，再发视频号","versions":{"小红书":{"title":"周末双人套餐"},"视频号":{"title":"老板亲自推荐"}}}
  \`\`\``);
  assert.match(preview, /先发小红书/u);
  assert.match(preview, /小红书：周末双人套餐/u);
  assert.doesNotMatch(preview, /```|[{}]/u);
});

test("内容员工产物预览保留普通 Markdown 正文", () => {
  const preview = contentRunResultPreview(
    "## 经营摘要\n\n本周应先完成菜单改版。",
  );
  assert.match(preview, /经营摘要/u);
  assert.match(preview, /菜单改版/u);
});

test("对话工作台直接渲染结构化结果、执行记录和真实文件交付", () => {
  const workbench = fs.readFileSync(
    path.join(workspace, "web/src/components/EmployeeWorkbench.tsx"),
    "utf8",
  );
  const renderer = fs.readFileSync(
    path.join(workspace, "web/src/components/ContentEmployeeResult.tsx"),
    "utf8",
  );
  assert.match(workbench, /<ContentEmployeeResult/u);
  assert.match(workbench, /查看执行记录/u);
  assert.match(workbench, /未形成业务产物/u);
  assert.match(workbench, /restaurantTask\.billing\.label/u);
  assert.match(workbench, /带回原要求重新派活/u);
  assert.match(workbench, /<SourceDeliverables/u);
  assert.match(workbench, /\/files\/artifacts\/source/u);
  assert.match(workbench, /formats: \['pdf', 'docx', 'xlsx'\]/u);
  assert.match(renderer, /<ArtifactActions/u);
  assert.match(renderer, /平台发布版本/u);
  assert.match(renderer, /核验来源/u);
  assert.match(renderer, /restoreReadableMarkdown/u);
  assert.match(renderer, /Array\.isArray\(structured\.channel_scan\)/u);
  assert.match(renderer, /联网核验已回传/u);
  assert.match(renderer, /content-result-fold/u);
  assert.match(renderer, /无可验证事实|检索快照未覆盖/u);
  assert.match(renderer, /Word 文档|sourceType/u);
});
