import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

test("任务中心以安全 Markdown 呈现报告并可返回数字员工对话", () => {
  const page = fs.readFileSync(
    path.join(root, "web/src/pages/TaskCenter.tsx"),
    "utf8",
  );
  assert.match(page, /<Markdown content=\{detail\.report\.markdown\}/u);
  assert.match(page, /detail\.conversationDeepLink/u);
  assert.match(page, /detail\.conversationAvailability\?\.available/u);
  assert.match(page, /回到数字员工对话/u);
  assert.match(page, /detail\.deliverables/u);
  assert.match(page, /artifact\.downloadUrl/u);
});

test("内容团队工位产物以预览和下载卡片呈现，不把 artifacts 数组直接串行化", () => {
  const page = fs.readFileSync(
    path.join(root, "web/src/pages/TaskCenter.tsx"),
    "utf8",
  );
  assert.match(page, /工位交付文件/u);
  assert.match(page, /detail\.pipeline\.artifacts/u);
  assert.match(page, /artifact\.previewUrl/u);
  assert.match(page, /artifact\.downloadUrl/u);
  assert.match(page, /artifact\.previewAvailable/u);
  assert.match(page, /artifact\.downloadAvailable/u);
  assert.doesNotMatch(
    page,
    /JSON\.stringify\([\s\S]{0,160}artifacts:\s*detail\.pipeline\.artifacts/u,
  );
});

test("历史失败任务可主动刷新并回到对应工作台人工重试", () => {
  const page = fs.readFileSync(
    path.join(root, "web/src/pages/TaskCenter.tsx"),
    "utf8",
  );
  assert.match(page, /刷新任务状态/u);
  assert.match(page, /DETAIL_RUNNING_REFRESH_MS\s*=\s*2_000/u);
  assert.match(page, /DETAIL_ATTENTION_REFRESH_MS\s*=\s*12_000/u);
  assert.match(page, /pending_reconciliation/u);
  assert.match(page, /前往重试失败工位/u);
  assert.match(page, /detail\.pipeline\.pipelineDeepLink/u);
  assert.match(page, /返回AI带货员重新处理/u);
  assert.match(page, /\/content\?tab=media&mediaJobId=/u);
  assert.match(page, /旧失败任务的历史快照，不会自动变成成功/u);
  assert.match(page, /不会自动触发付费重跑|不会自动付费重跑/u);
});

test("任务中心后端对丢失文件关闭ready，且旧流水线schema无法证明attempt时返回空产物", () => {
  const engine = fs.readFileSync(
    path.join(root, "server/src/engines/task-center.js"),
    "utf8",
  );
  assert.match(engine, /sourceArtifactFileReady\(artifact\)/u);
  assert.match(engine, /stat\.isFile\(\)\s*&&\s*!stat\.isSymbolicLink\(\)/u);
  assert.match(engine, /tableHasColumn\([\s\S]{0,120}"station_attempt"/u);
  assert.match(engine, /s\.attempt=a\.station_attempt/u);
  assert.match(engine, /artifactAttemptAware[\s\S]{0,700}: \[\]/u);
});
