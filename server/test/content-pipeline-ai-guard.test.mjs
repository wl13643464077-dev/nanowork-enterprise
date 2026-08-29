import assert from "node:assert/strict";
import { test } from "node:test";

import express from "express";

import { createAiGuard } from "../src/ai-limits.js";

const PIPELINE_MUTATION_PATHS = Object.freeze([
  "/pipelines",
  "/pipelines/42/review",
  "/pipelines/42/retry",
  "/pipelines/42/recover",
  "/pipelines/42/resume",
  "/pipelines/42/paid-media-authorization",
  "/pipelines/42/metrics",
  "/pipeline-schedules/1/run-now",
  "/PIPELINE-SCHEDULES/1/RUN-NOW/",
  "/pipelines/",
  "/PIPELINES/42/RESUME/",
  "/PIPELINES/42/PAID-MEDIA-AUTHORIZATION/",
  "/PIPELINES/42/METRICS/",
]);

async function withContentGuard(options, handler, run) {
  const app = express();
  const guard = createAiGuard(options);
  app.use((req, _res, next) => {
    req.user = {
      id: 101,
      tenant_id: Number(req.get("x-tenant") || 11),
      role: "boss",
    };
    next();
  });
  app.use("/content", guard("content"), handler);
  const server = app.listen(0, "127.0.0.1");
  const port = await new Promise((resolve) =>
    server.once("listening", () => resolve(server.address().port)),
  );
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("内容流水线所有会启动后台AI的POST动作逐一进入租户限流", async (t) => {
  for (const pathname of PIPELINE_MUTATION_PATHS) {
    await t.test(pathname, async () => {
      await withContentGuard(
        { ratePerMinute: 1, burst: 1, maxConcurrent: 8 },
        (_req, res) => res.json({ reached: true }),
        async (base) => {
          const first = await fetch(`${base}/content${pathname}`, {
            method: "POST",
          });
          const second = await fetch(`${base}/content${pathname}`, {
            method: "POST",
          });
          assert.equal(
            first.status,
            200,
            `${pathname}首次请求应进入业务处理器`,
          );
          assert.equal(
            second.status,
            429,
            `${pathname}第二次请求必须被内容模块限流拦截`,
          );
          assert.ok(Number(second.headers.get("retry-after")) >= 1);
          assert.match((await second.json()).error, /过于频繁/u);
        },
      );
    });
  }

  await withContentGuard(
    { ratePerMinute: 1, burst: 1, maxConcurrent: 8 },
    (_req, res) => res.json({ reached: true }),
    async (base) => {
      assert.equal(
        (await fetch(`${base}/content/pipelines`, { method: "POST" })).status,
        200,
      );
      assert.equal(
        (await fetch(`${base}/content/pipelines/42/resume`, { method: "POST" }))
          .status,
        429,
        "创建耗尽额度后，切换到resume也不能绕过同一内容模块令牌桶",
      );
    },
  );
});

test("内容流水线后台租约占用统一并发池，其他流水线动作不能穿透", async () => {
  let releaseBackgroundLease;
  await withContentGuard(
    { ratePerMinute: 1_000, burst: 1_000, maxConcurrent: 1 },
    (req, res) => {
      if (req.get("x-hold") === "1") {
        releaseBackgroundLease = req.aiGuard.defer(60_000);
        return res.status(202).json({ queued: true });
      }
      return res.json({ reached: true });
    },
    async (base) => {
      const queued = await fetch(`${base}/content/pipelines`, {
        method: "POST",
        headers: { "x-hold": "1" },
      });
      assert.equal(queued.status, 202);
      assert.equal(typeof releaseBackgroundLease, "function");

      const blocked = await fetch(`${base}/content/pipelines/42/recover`, {
        method: "POST",
      });
      assert.equal(blocked.status, 429);
      assert.match((await blocked.json()).error, /并发/u);

      releaseBackgroundLease();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(
        (
          await fetch(`${base}/content/pipelines/42/recover`, {
            method: "POST",
          })
        ).status,
        200,
      );
    },
  );
});

test("内容流水线GET列表和详情保持轻量，不消耗AI令牌", async () => {
  await withContentGuard(
    { ratePerMinute: 1, burst: 1, maxConcurrent: 8 },
    (_req, res) => res.json({ reached: true }),
    async (base) => {
      assert.equal((await fetch(`${base}/content/pipelines`)).status, 200);
      assert.equal((await fetch(`${base}/content/pipelines`)).status, 200);
      assert.equal((await fetch(`${base}/content/pipelines/42`)).status, 200);
      assert.equal((await fetch(`${base}/content/pipelines/42`)).status, 200);
      assert.equal(
        (await fetch(`${base}/content/pipelines`, { method: "POST" })).status,
        200,
      );
      assert.equal(
        (await fetch(`${base}/content/pipelines`, { method: "POST" })).status,
        429,
      );
    },
  );
});
