import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";

process.env.NANOWORK_DB = ":memory:";

const {
  createContentPipelineSpecialProviderAttemptStore,
  contentPipelineUnsettledStationBilling,
  downloadContentPipelineProviderAsset,
} = await import("../src/routes/content-production-pipeline.js");
const {
  createContentSpecialProviderBridge,
  contentSpecialProviderAttemptIdentity,
} = await import("../src/engines/content-special-provider-bridge.js");
const {
  contentPaidMediaAuthorizationReservation,
  createContentPaidMediaAuthorization,
} = await import("../src/engines/content-paid-media-authorization.js");
const { db, q, runWithTenant } = await import("../src/db.js");

db.exec(`
  CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT,
    type TEXT,
    tags TEXT,
    url TEXT,
    source_type TEXT,
    source_id INTEGER,
    creator_id INTEGER,
    note TEXT,
    body_snapshot TEXT,
    artifact_snapshot_json TEXT,
    snapshot_hash TEXT,
    use_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS credit_holds (
    id INTEGER PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    user_id INTEGER,
    log_id INTEGER NOT NULL,
    feature TEXT,
    kind TEXT,
    model TEXT,
    held_credits INTEGER NOT NULL,
    settled_credits INTEGER,
    status TEXT DEFAULT 'held',
    ref_type TEXT,
    ref_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    settled_at TEXT
  );
`);

after(() => {
  try {
    db.close();
  } catch {
    /* 测试进程已关闭 */
  }
});

function employeePackage() {
  return {
    identity: { idx: 5, key: "media", name: "多媒体师" },
    capabilities: [
      { name: "视觉生产", required: true, enabled: true, locked: true },
    ],
    workMethod: {
      input: {},
      execution: {},
      output: {},
      approval: {},
      handoff: {},
    },
    skills: { required: [{ title: "视觉生产" }], catalog: [] },
    prompts: {
      systemPrompt: { template: "完整系统提示词" },
      soloPrompt: { template: "单派" },
    },
    runtimeBindings: {
      models: { image: { credentials: "server_runtime_only" } },
    },
    workConfig: { factoryDefault: { imageModel: "gpt-image-2" } },
    jobProfile: { outputKeys: ["images"], boundaries: ["不得自动发布"] },
  };
}

function paidMediaAuthorization(estimatedUnitCredits = 75) {
  return createContentPaidMediaAuthorization({
    task: {
      direction: "provider幂等与授权累计测试",
      image_mode: "mix",
      image_count: 12,
      platforms: ["小红书", "抖音", "微信视频号", "公众号"],
    },
    actor: { id: 1, role: "boss" },
    imageModel: "gpt-image-2",
    estimatedUnitCredits,
  });
}

function paidAuthorizationUsage({
  kind = "image",
  count = 1,
  unitCredits = 75,
} = {}) {
  return authorizationUsageFrom(paidMediaAuthorization(unitCredits), {
    kind,
    count,
    unitCredits,
  });
}

function authorizationUsageFrom(
  policy,
  { kind = "image", count = 1, unitCredits = 75 } = {},
) {
  return contentPaidMediaAuthorizationReservation(policy, {
    providerKind: kind,
    requestedImageCount: count,
    requestedCredits: count * unitCredits,
  });
}

function testProviderAttemptStore() {
  return createContentPipelineSpecialProviderAttemptStore({
    async downloadProviderAssetFn() {
      // 若persist已错误开启外层事务，这个独立事务会立刻报
      // "cannot start a transaction within a transaction"。
      db.exec("BEGIN IMMEDIATE");
      db.exec("ROLLBACK");
      return {
        bytes: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
        mimeType: "image/png",
      };
    },
  });
}

test("URL-only固化下载在联网前拒绝非HTTP、URL凭据和私网目标", async () => {
  await assert.rejects(
    downloadContentPipelineProviderAsset("file:///etc/passwd"),
    (error) => error?.code === "CONTENT_PIPELINE_PROVIDER_ASSET_URL_UNSAFE",
  );
  await assert.rejects(
    downloadContentPipelineProviderAsset(
      "https://user:password@example.com/image.png",
    ),
    (error) => error?.code === "CONTENT_PIPELINE_PROVIDER_ASSET_URL_UNSAFE",
  );
  await assert.rejects(
    downloadContentPipelineProviderAsset("http://127.0.0.1:3109/private.png"),
    (error) => error?.code === "CONTENT_PIPELINE_PROVIDER_ASSET_URL_UNSAFE",
  );
  await assert.rejects(
    downloadContentPipelineProviderAsset(
      "http://[::ffff:127.0.0.1]/private.png",
    ),
    (error) => error?.code === "CONTENT_PIPELINE_PROVIDER_ASSET_URL_UNSAFE",
  );
  await assert.rejects(
    downloadContentPipelineProviderAsset("http://[::ffff:7f00:1]/private.png"),
    (error) => error?.code === "CONTENT_PIPELINE_PROVIDER_ASSET_URL_UNSAFE",
  );
});

test("URL固化失败发生在写事务之前且不产生material副作用", async () => {
  await runWithTenant(33, async () => {
    let downloadCalls = 0;
    const store = createContentPipelineSpecialProviderAttemptStore({
      async downloadProviderAssetFn() {
        downloadCalls += 1;
        db.exec("BEGIN IMMEDIATE");
        db.exec("ROLLBACK");
        throw Object.assign(new Error("capture failed"), {
          code: "TEST_CAPTURE_FAILED",
        });
      },
    });
    const attempt = {
      ...contentSpecialProviderAttemptIdentity({
        namespace: "content-production-pipeline",
        runId: 45_003,
        employeeIdx: 5,
        kind: "image",
        requestFingerprint: `sha256:${"a".repeat(64)}`,
      }),
      authorizationUsage: paidAuthorizationUsage(),
    };
    const claim = store.claim({ ...attempt, tenantId: 33, userId: 3_301 });
    const leasedAttempt = { ...attempt, leaseToken: claim.leaseToken };
    store.associateHold({
      ...leasedAttempt,
      tenantId: 33,
      userId: 3_301,
      hold: { holdId: 850_001 },
    });
    await assert.rejects(
      store.persist({
        tenantId: 33,
        userId: 3_301,
        runId: 45_003,
        employeeIdx: 5,
        kind: "image",
        imageModel: "gpt-image-2",
        request: { image_mode: "ai", platforms: ["小红书"] },
        output: {
          images: [{ url: "https://images.example/signed.png?token=private" }],
        },
        attempt: leasedAttempt,
        hold: { holdId: 850_001 },
      }),
      /capture failed/u,
    );
    assert.equal(downloadCalls, 1);
    assert.equal(
      q.get(
        `SELECT status FROM content_pipeline_special_provider_attempts
      WHERE tenant_id=? AND pipeline_id=?`,
        33,
        45_003,
      ).status,
      "claimed",
    );
    assert.equal(
      q.get(
        `SELECT COUNT(*) n FROM materials
      WHERE tenant_id=? AND source_type='content_pipeline_provider' AND source_id=?`,
        33,
        45_003,
      ).n,
      0,
    );
  });
});

test("ImageHunt已授权租户文件可固化为idx5素材，授权缺失时在读取前失败关闭", async () => {
  await runWithTenant(34, async () => {
    let localReads = 0;
    let remoteDownloads = 0;
    const store = createContentPipelineSpecialProviderAttemptStore({
      async readLocalProviderAssetFn(input) {
        localReads += 1;
        assert.deepEqual(input, {
          tenantId: 34,
          fileUrl: "/uploads/files/34/imagehunt/licensed.png",
          maxBytes: 25 * 1024 * 1024,
        });
        db.exec("BEGIN IMMEDIATE");
        db.exec("ROLLBACK");
        return {
          bytes: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
          mimeType: "image/png",
        };
      },
      async downloadProviderAssetFn() {
        remoteDownloads += 1;
        throw new Error("租户本地已授权素材不应走公网下载");
      },
    });
    const attempt = {
      ...contentSpecialProviderAttemptIdentity({
        namespace: "content-production-pipeline",
        runId: 45_034,
        employeeIdx: 5,
        kind: "material",
        requestFingerprint: `sha256:${"b".repeat(64)}`,
      }),
      authorizationUsage: paidAuthorizationUsage({ kind: "material" }),
    };
    const claim = store.claim({ ...attempt, tenantId: 34, userId: 3_401 });
    const leasedAttempt = { ...attempt, leaseToken: claim.leaseToken };
    store.associateHold({
      ...leasedAttempt,
      tenantId: 34,
      userId: 3_401,
      hold: { holdId: 850_034 },
    });
    const delivery = await store.persist({
      tenantId: 34,
      userId: 3_401,
      runId: 45_034,
      employeeIdx: 5,
      kind: "material",
      imageModel: "gpt-image-2",
      request: { image_mode: "real", platforms: ["小红书"] },
      output: {
        assets: [
          {
            url: "/uploads/files/34/imagehunt/licensed.png",
            mimeType: "image/png",
            materialId: 73,
            sourceUrl: "https://source.example/licensed",
            rights: {
              confirmed: true,
              commercialUse: true,
              license: "企业自有拍摄素材",
              attribution: "门店摄影师",
            },
          },
        ],
      },
      attempt: leasedAttempt,
      hold: { holdId: 850_034 },
    });
    assert.equal(delivery.persisted, true);
    assert.equal(localReads, 1);
    assert.equal(remoteDownloads, 0);
    const material = q.get(
      `SELECT type,body_snapshot,artifact_snapshot_json
      FROM materials WHERE tenant_id=? AND source_type='content_pipeline_provider'
        AND source_id=?`,
      34,
      45_034,
    );
    assert.equal(material.type, "图片");
    assert.match(material.body_snapshot, /^data:image\/png;base64,/u);
    const metadata = JSON.parse(material.artifact_snapshot_json);
    assert.equal(metadata.sourceMaterialId, 73);
    assert.equal(metadata.rights.commercialUse, true);
    assert.equal(metadata.rights.license, "企业自有拍摄素材");
  });

  await runWithTenant(35, async () => {
    let localReads = 0;
    const store = createContentPipelineSpecialProviderAttemptStore({
      async readLocalProviderAssetFn() {
        localReads += 1;
        throw new Error("授权门应先于文件读取");
      },
      async downloadProviderAssetFn() {
        throw new Error("授权门应先于网络读取");
      },
    });
    const attempt = {
      ...contentSpecialProviderAttemptIdentity({
        namespace: "content-production-pipeline",
        runId: 45_035,
        employeeIdx: 5,
        kind: "material",
        requestFingerprint: `sha256:${"c".repeat(64)}`,
      }),
      authorizationUsage: paidAuthorizationUsage({ kind: "material" }),
    };
    const claim = store.claim({ ...attempt, tenantId: 35, userId: 3_501 });
    const leasedAttempt = { ...attempt, leaseToken: claim.leaseToken };
    store.associateHold({
      ...leasedAttempt,
      tenantId: 35,
      userId: 3_501,
      hold: { holdId: 850_035 },
    });
    await assert.rejects(
      store.persist({
        tenantId: 35,
        userId: 3_501,
        runId: 45_035,
        employeeIdx: 5,
        kind: "material",
        imageModel: "gpt-image-2",
        request: { image_mode: "real", platforms: ["小红书"] },
        output: {
          assets: [
            {
              url: "/uploads/files/35/imagehunt/unlicensed.png",
              mimeType: "image/png",
              materialId: 74,
              rights: {
                confirmed: true,
                commercialUse: false,
                license: "个人用途",
              },
            },
          ],
        },
        attempt: leasedAttempt,
        hold: { holdId: 850_035 },
      }),
      (error) => error?.code === "CONTENT_PIPELINE_MATERIAL_RIGHTS_INVALID",
    );
    assert.equal(localReads, 0);
  });
});

test("外层station落库失败后的新bridge恢复只回放同一attempt，不重复付费或INSERT素材", async () => {
  await runWithTenant(31, async () => {
    const store = testProviderAttemptStore();
    const events = [];
    let holdSequence = 0;
    const dependencies = {
      resolveProviderAttemptFn: store.resolve,
      claimProviderAttemptFn: store.claim,
      validateProviderClaimFn: store.validateClaim,
      associateProviderHoldFn: store.associateHold,
      persistProviderOutputFn: store.persist,
      finalizeProviderAttemptFn: store.finalize,
      estimateMaxCreditsFn: () => 50,
      holdCreditsFn(input) {
        events.push(`hold:${input.refType}:${input.refId}`);
        holdSequence += 1;
        return {
          holdId: 810_000 + holdSequence,
          logId: 820_000 + holdSequence,
          tenantId: 31,
          userId: 3_101,
          kind: input.kind,
          model: input.model,
          credits: input.credits,
          balance: 9_000,
        };
      },
      settleHoldFn(hold, input) {
        events.push(`settle:${hold.holdId}:${input.credits}`);
        return { credits: input.credits, balance: 8_900, costYuan: 1 };
      },
      releaseHoldFn() {
        throw new Error("本测试不应释放已交付attempt");
      },
      async generateImageFn(input) {
        events.push(`generate:${input.idempotencyKey}`);
        return {
          model: input.model,
          url: `https://images.example/${events.filter((item) => item.startsWith("generate:")).length}.png`,
        };
      },
    };
    const input = {
      tenantId: 31,
      userId: 3_101,
      runId: 45_001,
      employeeIdx: 5,
      employeePackage: employeePackage(),
      imageModel: "gpt-image-2",
      attemptNamespace: "content-production-pipeline",
      paidMediaAuthorization: paidMediaAuthorization(50),
      request: {
        prompt: "生成两张可追溯经营信息图",
        image_mode: "ai",
        image_count: 2,
        platforms: ["小红书"],
        size: "1024x1024",
      },
    };

    const first = await createContentSpecialProviderBridge(
      input,
      dependencies,
    ).providers.image({ count: 2, purpose: "content_images" });
    const firstAttempt = q.get(
      `SELECT * FROM content_pipeline_special_provider_attempts
      WHERE tenant_id=? AND pipeline_id=? AND station_idx=5`,
      31,
      45_001,
    );
    assert.equal(firstAttempt.status, "settled");
    db.prepare(
      `INSERT INTO credit_holds(
      id,tenant_id,user_id,log_id,kind,model,held_credits,settled_credits,status,
      ref_type,ref_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      firstAttempt.hold_id,
      31,
      3_101,
      820_001,
      "image",
      "gpt-image-2",
      100,
      100,
      "settled",
      firstAttempt.billing_ref_type,
      firstAttempt.billing_ref_id,
    );

    // 模拟外层station主产物事务失败后，进程重新构造bridge并重试同一工位。
    const replayed = await createContentSpecialProviderBridge(
      input,
      dependencies,
    ).providers.image({ count: 2, purpose: "content_images" });
    const materialCount = q.get(
      `SELECT COUNT(*) n FROM materials
      WHERE tenant_id=? AND source_type='content_pipeline_provider' AND source_id=?`,
      31,
      45_001,
    ).n;
    const attemptCount = q.get(
      `SELECT COUNT(*) n
      FROM content_pipeline_special_provider_attempts
      WHERE tenant_id=? AND pipeline_id=? AND station_idx=5`,
      31,
      45_001,
    ).n;

    assert.equal(first.bridge.replayed, false);
    assert.equal(replayed.bridge.replayed, true);
    assert.equal(replayed.bridge.attemptId, first.bridge.attemptId);
    assert.equal(events.filter((item) => item.startsWith("hold:")).length, 1);
    assert.equal(
      events.filter((item) => item.startsWith("generate:")).length,
      2,
    );
    assert.equal(events.filter((item) => item.startsWith("settle:")).length, 1);
    assert.equal(materialCount, 2);
    const persistedMaterials = q.all(
      `SELECT url,body_snapshot,artifact_snapshot_json,snapshot_hash
      FROM materials WHERE tenant_id=? AND source_type='content_pipeline_provider' AND source_id=?
      ORDER BY id`,
      31,
      45_001,
    );
    assert.equal(
      persistedMaterials.every((material) => material.url === null),
      true,
    );
    for (const material of persistedMaterials) {
      const match = /^data:image\/png;base64,(.+)$/u.exec(
        material.body_snapshot,
      );
      assert.ok(match);
      const bytes = Buffer.from(match[1], "base64");
      const metadata = JSON.parse(material.artifact_snapshot_json);
      assert.equal(
        material.snapshot_hash,
        createHash("sha256").update(bytes).digest("hex"),
      );
      assert.equal(metadata.contentSha256, material.snapshot_hash);
      assert.equal(metadata.byteSize, bytes.length);
    }
    assert.equal(attemptCount, 1);
    assert.deepEqual(
      replayed.bridge.delivery.artifactIds,
      first.bridge.delivery.artifactIds,
    );
  });
});

test("provider外调已开始后失败则attempt转待对账，禁止自动退款与二次付费复跑", async () => {
  await runWithTenant(32, async () => {
    const store = testProviderAttemptStore();
    let providerCalls = 0;
    let holdCalls = 0;
    const dependencies = {
      resolveProviderAttemptFn: store.resolve,
      claimProviderAttemptFn: store.claim,
      validateProviderClaimFn: store.validateClaim,
      associateProviderHoldFn: store.associateHold,
      persistProviderOutputFn: store.persist,
      finalizeProviderAttemptFn: store.finalize,
      estimateMaxCreditsFn: () => 25,
      holdCreditsFn(input) {
        holdCalls += 1;
        return {
          holdId: 830_000 + holdCalls,
          logId: 840_000 + holdCalls,
          tenantId: 32,
          userId: 3_201,
          kind: input.kind,
          model: input.model,
          credits: input.credits,
          balance: 10_000 - input.credits,
        };
      },
      settleHoldFn(hold, input) {
        return { credits: input.credits, balance: 9_950, costYuan: 1 };
      },
      releaseHoldFn() {
        assert.fail("provider外调已开始后不得自动退款");
      },
      async generateImageFn(input) {
        providerCalls += 1;
        if (providerCalls === 1) throw new Error("provider transient failure");
        return {
          model: input.model,
          url: "https://images.example/retried.png",
        };
      },
    };
    const input = {
      tenantId: 32,
      userId: 3_201,
      runId: 45_002,
      employeeIdx: 5,
      employeePackage: employeePackage(),
      imageModel: "gpt-image-2",
      attemptNamespace: "content-production-pipeline",
      paidMediaAuthorization: paidMediaAuthorization(25),
      request: {
        prompt: "provider失败后安全重试",
        image_mode: "ai",
        image_count: 1,
        platforms: ["小红书"],
        size: "1024x1024",
      },
    };

    await assert.rejects(
      createContentSpecialProviderBridge(input, dependencies).providers.image({
        count: 1,
        purpose: "content_images",
      }),
      (error) => {
        assert.equal(error.billing.state, "pending_reconciliation");
        assert.equal(error.billing.heldCredits, 25);
        assert.equal(error.billing.chargedCredits, null);
        assert.equal(error.billing.releaseSuppressed, true);
        return true;
      },
    );
    assert.equal(
      q.get(
        `SELECT status FROM content_pipeline_special_provider_attempts
      WHERE tenant_id=? AND pipeline_id=?`,
        32,
        45_002,
      ).status,
      "pending_reconciliation",
    );

    await assert.rejects(
      createContentSpecialProviderBridge(input, dependencies).providers.image({
        count: 1,
        purpose: "content_images",
      }),
      /幂等尝试仍在执行或等待对账/u,
    );
    assert.equal(providerCalls, 1);
    assert.equal(holdCalls, 1);
    assert.equal(
      q.get(
        `SELECT COUNT(*) n FROM materials
      WHERE tenant_id=? AND source_type='content_pipeline_provider' AND source_id=?`,
        32,
        45_002,
      ).n,
      0,
    );
  });
});

test("进程崩溃窗口：租约过期且本轮无hold的空claim可安全回收，旧租约不能继续写", async () => {
  await runWithTenant(34, async () => {
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    let tokenSequence = 0;
    const store = createContentPipelineSpecialProviderAttemptStore({
      now: () => new Date(nowMs),
      randomUUIDFn: () => `crash-empty-${++tokenSequence}`,
      claimLeaseMs: 1_000,
    });
    const attempt = {
      ...contentSpecialProviderAttemptIdentity({
        namespace: "content-production-pipeline",
        runId: 45_004,
        employeeIdx: 5,
        kind: "image",
        requestFingerprint: `sha256:${"b".repeat(64)}`,
      }),
      authorizationUsage: paidAuthorizationUsage(),
    };
    const identity = { ...attempt, tenantId: 34, userId: 3_401 };
    const first = store.claim(identity);
    assert.equal(store.claim(identity).state, "in_progress");

    nowMs += 1_001;
    const recovered = store.claim(identity);
    assert.equal(recovered.state, "claimed");
    assert.equal(recovered.recoveredStaleEmptyClaim, true);
    assert.notEqual(recovered.leaseToken, first.leaseToken);
    assert.equal(
      q.get(
        `SELECT COUNT(*) n FROM content_pipeline_special_provider_attempts
      WHERE tenant_id=? AND pipeline_id=?`,
        34,
        45_004,
      ).n,
      1,
    );
    assert.throws(
      () => store.validateClaim({ ...identity, leaseToken: first.leaseToken }),
      (error) => error?.code === "CONTENT_PIPELINE_PROVIDER_CLAIM_LEASE_LOST",
    );
  });
});

test("进程崩溃窗口：hold已创建但尚未关联时不得回收或退款，转待对账并阻断重跑", async () => {
  await runWithTenant(35, async () => {
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const store = createContentPipelineSpecialProviderAttemptStore({
      now: () => new Date(nowMs),
      randomUUIDFn: () => "crash-unlinked-hold",
      claimLeaseMs: 1_000,
    });
    const attempt = {
      ...contentSpecialProviderAttemptIdentity({
        namespace: "content-production-pipeline",
        runId: 45_005,
        employeeIdx: 5,
        kind: "image",
        requestFingerprint: `sha256:${"c".repeat(64)}`,
      }),
      authorizationUsage: paidAuthorizationUsage(),
    };
    const identity = { ...attempt, tenantId: 35, userId: 3_501 };
    store.claim(identity);
    q.run(
      `INSERT INTO credit_holds(
      id,tenant_id,user_id,log_id,kind,model,held_credits,status,ref_type,ref_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      860_001,
      35,
      3_501,
      870_001,
      "image",
      "gpt-image-2",
      75,
      "held",
      attempt.refType,
      attempt.refId,
    );

    nowMs += 1_001;
    const blocked = store.claim(identity);
    assert.equal(blocked.state, "pending_reconciliation");
    const row = q.get(
      `SELECT status,hold_id FROM content_pipeline_special_provider_attempts
      WHERE tenant_id=? AND pipeline_id=?`,
      35,
      45_005,
    );
    assert.equal(row.status, "pending_reconciliation");
    assert.equal(row.hold_id, 860_001);
    assert.equal(
      q.get("SELECT status FROM credit_holds WHERE id=?", 860_001).status,
      "held",
    );
  });
});

test("进程崩溃窗口：hold已即时关联后即使没有产物也只进入待对账，不凭感觉释放", async () => {
  await runWithTenant(36, async () => {
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const store = createContentPipelineSpecialProviderAttemptStore({
      now: () => new Date(nowMs),
      randomUUIDFn: () => "crash-associated-hold",
      claimLeaseMs: 1_000,
    });
    const attempt = {
      ...contentSpecialProviderAttemptIdentity({
        namespace: "content-production-pipeline",
        runId: 45_006,
        employeeIdx: 5,
        kind: "image",
        requestFingerprint: `sha256:${"d".repeat(64)}`,
      }),
      authorizationUsage: paidAuthorizationUsage(),
    };
    const identity = { ...attempt, tenantId: 36, userId: 3_601 };
    const claim = store.claim(identity);
    q.run(
      `INSERT INTO credit_holds(
      id,tenant_id,user_id,log_id,kind,model,held_credits,status,ref_type,ref_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      860_002,
      36,
      3_601,
      870_002,
      "image",
      "gpt-image-2",
      90,
      "held",
      attempt.refType,
      attempt.refId,
    );
    store.associateHold({
      ...identity,
      leaseToken: claim.leaseToken,
      hold: { holdId: 860_002 },
    });

    nowMs += 1_001;
    const billing = contentPipelineUnsettledStationBilling({
      tenantId: 36,
      pipelineId: 45_006,
      stationIdx: 5,
    });
    assert.equal(billing.state, "pending_reconciliation");
    assert.equal(billing.heldCredits, 90);
    assert.deepEqual(billing.holdIds, [860_002]);
    assert.equal(
      q.get(
        `SELECT status FROM content_pipeline_special_provider_attempts
      WHERE tenant_id=? AND pipeline_id=?`,
        36,
        45_006,
      ).status,
      "pending_reconciliation",
    );
    assert.equal(
      q.get("SELECT status FROM credit_holds WHERE id=?", 860_002).status,
      "held",
    );
  });
});

test("工位5配图与工位6封面在pipeline全生命周期原子共用总额度，重新授权不清零", async () => {
  await runWithTenant(37, async () => {
    const store = testProviderAttemptStore();
    const policy = createContentPaidMediaAuthorization({
      task: {
        direction: "配图与封面共用总额度",
        image_mode: "ai",
        image_count: 4,
        platforms: ["小红书", "抖音"],
      },
      actor: { id: 3_701, role: "boss" },
      imageModel: "gpt-image-2",
      estimatedUnitCredits: 75,
    });
    const identity = ({
      stationIdx,
      attemptOrdinal,
      fingerprint,
      count,
      authorizationPolicy = policy,
    }) => ({
      ...contentSpecialProviderAttemptIdentity({
        namespace: "content-production-pipeline",
        runId: 45_007,
        employeeIdx: stationIdx,
        kind: "image",
        attemptOrdinal,
        requestFingerprint: `sha256:${fingerprint.repeat(64)}`,
      }),
      tenantId: 37,
      userId: 3_701,
      authorizationUsage: authorizationUsageFrom(authorizationPolicy, {
        count,
      }),
    });

    store.claim(
      identity({
        stationIdx: 5,
        attemptOrdinal: 1,
        fingerprint: "e",
        count: 4,
      }),
    );
    store.claim(
      identity({
        stationIdx: 6,
        attemptOrdinal: 1,
        fingerprint: "f",
        count: 2,
      }),
    );
    assert.throws(
      () =>
        store.claim(
          identity({
            stationIdx: 6,
            attemptOrdinal: 2,
            fingerprint: "1",
            count: 1,
          }),
        ),
      (error) =>
        error?.code ===
        "CONTENT_PAID_MEDIA_AUTHORIZATION_CUMULATIVE_LIMIT_EXCEEDED",
    );
    assert.equal(
      q.get(
        `SELECT COUNT(*) n FROM content_pipeline_special_provider_attempts
        WHERE tenant_id=? AND pipeline_id=?`,
        37,
        45_007,
      ).n,
      2,
    );
    const renewedPolicy = createContentPaidMediaAuthorization({
      task: {
        direction: "配图与封面共用总额度",
        image_mode: "ai",
        image_count: 4,
        platforms: ["小红书", "抖音"],
      },
      actor: { id: 3_701, role: "boss" },
      imageModel: "gpt-image-2",
      estimatedUnitCredits: 75,
      now: () => new Date(Date.now() + 60_000),
    });
    assert.notEqual(renewedPolicy.authorizationId, policy.authorizationId);
    assert.throws(
      () =>
        store.claim(
          identity({
            stationIdx: 6,
            attemptOrdinal: 3,
            fingerprint: "2",
            count: 1,
            authorizationPolicy: renewedPolicy,
          }),
        ),
      (error) =>
        error?.code ===
        "CONTENT_PAID_MEDIA_AUTHORIZATION_CUMULATIVE_LIMIT_EXCEEDED",
    );
  });
});

test("新stationAttempt先跨轮回放已结算产物，指纹不一致则转待对账且不建新hold", async () => {
  await runWithTenant(38, async () => {
    const store = testProviderAttemptStore();
    const policy = createContentPaidMediaAuthorization({
      task: {
        direction: "跨stationAttempt回放",
        image_mode: "ai",
        image_count: 1,
        platforms: ["小红书"],
      },
      actor: { id: 3_801, role: "boss" },
      imageModel: "gpt-image-2",
      estimatedUnitCredits: 50,
    });
    let holdCalls = 0;
    let providerCalls = 0;
    const dependencies = {
      resolveProviderAttemptFn: store.resolve,
      claimProviderAttemptFn: store.claim,
      validateProviderClaimFn: store.validateClaim,
      associateProviderHoldFn: store.associateHold,
      persistProviderOutputFn: store.persist,
      finalizeProviderAttemptFn: store.finalize,
      estimateMaxCreditsFn: () => 50,
      holdCreditsFn(input) {
        holdCalls += 1;
        return {
          holdId: 880_000 + holdCalls,
          logId: 881_000 + holdCalls,
          tenantId: 38,
          userId: 3_801,
          kind: input.kind,
          model: input.model,
          credits: input.credits,
          balance: 10_000,
        };
      },
      settleHoldFn(hold, input) {
        return { credits: input.credits, balance: 9_950, costYuan: 1 };
      },
      releaseHoldFn() {
        throw new Error("已交付产物不应释放");
      },
      async generateImageFn(input) {
        providerCalls += 1;
        return {
          model: input.model,
          url: "https://images.example/cross-attempt.png",
        };
      },
    };
    const bridgeInput = (attemptOrdinal, prompt) => ({
      tenantId: 38,
      userId: 3_801,
      runId: 45_008,
      employeeIdx: 5,
      employeePackage: employeePackage(),
      imageModel: "gpt-image-2",
      attemptNamespace: "content-production-pipeline",
      attemptOrdinal,
      paidMediaAuthorization: policy,
      request: {
        prompt,
        image_mode: "ai",
        image_count: 1,
        platforms: ["小红书"],
        size: "1024x1024",
      },
    });

    const first = await createContentSpecialProviderBridge(
      bridgeInput(1, "生成可追溯经营图"),
      dependencies,
    ).providers.image({ count: 1, purpose: "content_images" });
    const replayed = await createContentSpecialProviderBridge(
      bridgeInput(2, "生成可追溯经营图"),
      dependencies,
    ).providers.image({ count: 1, purpose: "content_images" });
    assert.equal(first.bridge.replayed, false);
    assert.equal(replayed.bridge.replayed, true);
    assert.notEqual(replayed.bridge.attemptId, first.bridge.attemptId);
    assert.equal(holdCalls, 1);
    assert.equal(providerCalls, 1);
    assert.equal(
      q.get(
        `SELECT COUNT(*) n FROM content_pipeline_special_provider_attempts
        WHERE tenant_id=? AND pipeline_id=?`,
        38,
        45_008,
      ).n,
      1,
    );

    await assert.rejects(
      createContentSpecialProviderBridge(
        bridgeInput(3, "另一个不同的经营图请求"),
        dependencies,
      ).providers.image({ count: 1, purpose: "content_images" }),
      (error) =>
        error?.code ===
        "CONTENT_PIPELINE_PROVIDER_PRIOR_DELIVERY_REQUIRES_RECONCILIATION",
    );
    assert.equal(holdCalls, 1);
    assert.equal(providerCalls, 1);
    assert.equal(
      q.get(
        `SELECT status FROM content_pipeline_special_provider_attempts
        WHERE tenant_id=? AND pipeline_id=? ORDER BY id DESC LIMIT 1`,
        38,
        45_008,
      ).status,
      "pending_reconciliation",
    );
  });
});
