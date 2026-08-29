import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(
  os.tmpdir(),
  `nanowork-review-dataset-import-${process.pid}.db`,
);
for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {}
}
process.env.NANOWORK_DB = DB_PATH;
process.env.YUNWU_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";

const { REVIEW_DATASET_LIMITS, importReviewDataset } =
  await import("../src/engines/review-dataset-import.js");

function attachment(id, name, ext = name.split(".").pop()) {
  return {
    id,
    name,
    ext,
    url: `/uploads/files/1/review/${id}-${encodeURIComponent(name)}`,
    readable: true,
  };
}

function reader(fixtures) {
  return async ({ attachment: current }) => ({
    fileId: current.id,
    bytes: fixtures.get(current.id),
  });
}

test("只有员工143且本轮存在FileHub授权引用才调用评价数据导入", async () => {
  let reads = 0;
  const readFile = async () => {
    reads += 1;
    throw new Error("must not read");
  };
  const other = await importReviewDataset({
    employeeIdx: 142,
    attachments: [attachment(1, "reviews.csv")],
    tenantId: 1,
    readFile,
  });
  assert.equal(other.evidence.invoked, false);
  assert.equal(other.evidence.parseStatus, "not_invoked");
  assert.equal(other.evidence.reason, "employee_not_eligible");
  assert.equal(other.promptSummary, null);

  const absent = await importReviewDataset({
    employeeIdx: 143,
    attachments: [],
    tenantId: 1,
    readFile,
  });
  assert.equal(absent.evidence.invoked, false);
  assert.equal(absent.evidence.parseStatus, "not_invoked");
  assert.equal(absent.evidence.reason, "no_authorized_uploads");
  assert.equal(reads, 0);
});

test("CSV、TSV、JSON形成结构化摘要；证据只留fileId/hash/行数/schema且PII被去标识化", async () => {
  const csv = Buffer.from(
    [
      "platform,rating,date,review,phone",
      '大众点评,2,2026-08-01,"顾客姓名：张三；上菜太慢，服务一般，联系我 13800138000",13800138000',
      '大众点评,5,2026-08-02,"口味很好，环境干净",',
    ].join("\n"),
  );
  const tsv = Buffer.from(
    [
      "平台\t星级\t评价内容\t邮箱",
      "美团\t1\t吃完拉肚子，有食品安全风险\tguest@example.com",
    ].join("\n"),
  );
  const json = Buffer.from(
    JSON.stringify({
      reviews: [
        {
          platform: "Google",
          stars: 4,
          reviewText: "Service was friendly; email me at owner@example.com",
          reviewer_name: "Alice Example",
        },
      ],
    }),
  );
  const result = await importReviewDataset({
    employeeIdx: 143,
    tenantId: 1,
    attachments: [
      attachment(11, "门店评价.csv"),
      attachment(12, "reviews.tsv"),
      attachment(13, "reviews.json"),
    ],
    readFile: reader(
      new Map([
        [11, csv],
        [12, tsv],
        [13, json],
      ]),
    ),
  });

  assert.equal(result.evidence.parseStatus, "completed");
  assert.deepEqual(result.evidence.acceptedFileIds, [11, 12, 13]);
  assert.equal(result.evidence.totals.rowCount, 4);
  assert.equal(result.evidence.accepted[0].sha256.length, 64);
  assert.equal(result.evidence.accepted[0].rowCount, 2);
  assert.equal(
    result.evidence.accepted[0].schema.semanticFields.reviewText,
    "review",
  );
  assert.equal(
    result.evidence.accepted[1].schema.semanticFields.reviewText,
    "评价内容",
  );
  assert.equal(
    result.evidence.accepted[2].schema.semanticFields.reviewText,
    "reviewText",
  );
  assert.ok(result.evidence.privacy.piiRedactions.phone >= 1);
  assert.ok(result.evidence.privacy.piiRedactions.email >= 1);
  assert.ok(result.evidence.privacy.piiRedactions.pii_field_values >= 2);
  assert.equal(result.evidence.privacy.rawRowsStored, false);
  assert.equal(result.evidence.privacy.rawReviewTextStored, false);
  assert.equal(result.promptSummary.aggregate.rowCount, 4);
  assert.equal(result.promptSummary.aggregate.ratingCount, 4);
  assert.equal(result.promptSummary.aggregate.riskSignalCounts.food_safety, 1);
  assert.ok(result.promptSummary.aggregate.themeCounts.service >= 2);
  assert.match(JSON.stringify(result.promptSummary), /\[PHONE_REDACTED\]/u);
  assert.match(JSON.stringify(result.promptSummary), /\[EMAIL_REDACTED\]/u);
  assert.match(JSON.stringify(result.promptSummary), /\[NAME_REDACTED\]/u);
  assert.deepEqual(result.promptSummary.aggregate.dateRange, {
    from: "2026-08-01",
    to: "2026-08-02",
    observedRows: 2,
  });

  const persistedEvidence = JSON.stringify(result.evidence);
  assert.doesNotMatch(
    persistedEvidence,
    /13800138000|guest@example\.com|owner@example\.com|Alice Example|张三/u,
  );
  assert.doesNotMatch(persistedEvidence, /上菜太慢|拉肚子|friendly/u);
  const prompt = JSON.stringify(result.promptSummary);
  assert.doesNotMatch(
    prompt,
    /13800138000|guest@example\.com|owner@example\.com|Alice Example|张三/u,
  );
});

test("坏编码、超限、公式注入和普通文本逐文件明确拒绝，不能冒充已导入", async () => {
  const oversized = Buffer.alloc(REVIEW_DATASET_LIMITS.maxFileBytes + 1, 0x61);
  const rows = ["review,rating"];
  for (
    let index = 0;
    index <= REVIEW_DATASET_LIMITS.maxRowsPerFile;
    index += 1
  ) {
    rows.push(`评价${index},5`);
  }
  const fixtures = new Map([
    [21, Buffer.from([0xc3, 0x28])],
    [22, oversized],
    [
      23,
      Buffer.from(
        'review,rating\n"=HYPERLINK(\"\"https://evil.invalid\"\")",1',
      ),
    ],
    [24, Buffer.from("这是会议纪要\n明天继续讨论预算")],
    [25, Buffer.from(rows.join("\n"))],
  ]);
  const result = await importReviewDataset({
    employeeIdx: 143,
    tenantId: 1,
    attachments: [
      attachment(21, "bad.csv"),
      attachment(22, "reviews.json"),
      attachment(23, "reviews.csv"),
      attachment(24, "会议纪要.txt"),
      attachment(25, "reviews.csv"),
    ],
    readFile: reader(fixtures),
  });

  assert.equal(result.evidence.parseStatus, "rejected");
  assert.equal(result.promptSummary, null);
  assert.deepEqual(
    result.evidence.rejected.map((item) => item.reasonCode),
    [
      "invalid_utf8",
      "file_too_large",
      "formula_injection",
      "ordinary_text",
      "too_many_rows",
    ],
  );
  assert.equal(result.evidence.acceptedFileIds.length, 0);
  assert.ok(
    result.evidence.rejected.every((item) => item.parseStatus === "rejected"),
  );
  assert.doesNotMatch(
    JSON.stringify(result.evidence),
    /evil\.invalid|会议纪要|明天继续/u,
  );
});

test("混合附件只汇总通过安全门的评价文件，并如实保留拒绝原因", async () => {
  const result = await importReviewDataset({
    employeeIdx: 143,
    tenantId: 1,
    attachments: [
      attachment(31, "reviews.csv"),
      attachment(32, "菜单.pdf", "pdf"),
      attachment(33, "notes.txt"),
    ],
    readFile: reader(
      new Map([
        [31, Buffer.from("平台,评分,评价内容\n大众点评,4,口味不错服务很好")],
        [33, Buffer.from("普通说明，不是评价数据")],
      ]),
    ),
  });

  assert.equal(result.evidence.parseStatus, "completed_with_rejections");
  assert.deepEqual(result.evidence.acceptedFileIds, [31]);
  assert.deepEqual(
    result.evidence.rejected.map((item) => [item.fileId, item.reasonCode]),
    [
      [32, "unsupported_type"],
      [33, "ordinary_text"],
    ],
  );
  assert.equal(result.promptSummary.aggregate.rowCount, 1);
});

test("声明单文件超限不读取，解析失败文件也计入本轮累计读取上限", async () => {
  let declaredOversizeReads = 0;
  const declaredOversize = await importReviewDataset({
    employeeIdx: 143,
    tenantId: 1,
    attachments: [
      {
        ...attachment(41, "reviews.csv"),
        size: REVIEW_DATASET_LIMITS.maxFileBytes + 1,
      },
    ],
    readFile: async () => {
      declaredOversizeReads += 1;
      throw new Error("must not read");
    },
  });
  assert.equal(declaredOversizeReads, 0);
  assert.equal(
    declaredOversize.evidence.rejected[0].reasonCode,
    "file_too_large",
  );

  const chunk = Buffer.from("评价数据：服务".padEnd(1_600_000, "a"));
  const cumulative = await importReviewDataset({
    employeeIdx: 143,
    tenantId: 1,
    attachments: [42, 43, 44, 45].map((id) =>
      attachment(id, `reviews-${id}.txt`),
    ),
    readFile: reader(
      new Map([
        [42, chunk],
        [43, chunk],
        [44, chunk],
        [45, chunk],
      ]),
    ),
  });
  assert.deepEqual(
    cumulative.evidence.rejected.map((item) => item.reasonCode),
    [
      "cell_too_large",
      "cell_too_large",
      "cell_too_large",
      "total_size_exceeded",
    ],
  );
  assert.equal(cumulative.evidence.totals.bytesRead, chunk.length * 4);
});

after(() => {
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
});
