import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Router } from "express";

import { CONTENT_EMPLOYEES } from "../catalog/content-crew.js";
import {
  curTenant,
  db,
  getTenantConfig,
  q,
  runWithTenant,
  setTenantConfig,
} from "../db.js";
import {
  canAccessOwner,
  hasFullDataAccess,
  isManagerRole,
} from "../engines/access.js";
import { generate } from "../engines/ai.js";
import {
  estimateCallCredits,
  estimateMaxCredits,
  holdCredits,
  precheckByRole,
  releaseHeldCreditsByRefInCurrentTransaction,
  releaseHold,
  settleHold,
} from "../engines/credits.js";
import {
  CONTENT_PAID_MEDIA_PRICING_VERSION,
  contentPaidMediaMaximumImageCount,
  contentPaidMediaPricingSnapshot,
  createContentPaidMediaAuthorization,
} from "../engines/content-paid-media-authorization.js";
import {
  createContentProductionPipeline,
  createSqliteContentProductionPipelineRepository,
  contentPipelineUsesPredictiveRetro,
} from "../engines/content-production-pipeline.js";
import { createContentProductionHandlerRegistry } from "../engines/content-production-handler-registry.js";
import {
  createContentSpecialProviderBridge,
  mergeContentSpecialProviderBillingEvidence,
} from "../engines/content-special-provider-bridge.js";
import {
  createContentTenantProfileStore,
  resolveContentStructuredBrief,
} from "../engines/content-structured-brief.js";
import { canonicalContentEmployeeProfileFor } from "../engines/canonical-employee-profile.js";
import { executeHeldDelivery } from "../engines/two-phase-delivery.js";
import { sanitizeContentRuntimeErrorMessage } from "../engines/content-handler-adapters.js";
import { readTenantUploadedFileByUrl } from "../engines/filehub.js";
import { searchLicensedMaterials } from "../engines/licensed-material-search.js";
import { routing, textModelFor, yunwuAvailable } from "../engines/yunwu.js";
import { webSearch } from "../engines/websearch.js";
import { logOp, notify } from "../util.js";

const PIPELINE_REF_TYPE = "content_production_pipeline_station";
const PIPELINE_LEASE_MS = 30 * 60 * 1000;
const SPECIAL_PROVIDER_CLAIM_LEASE_MS = PIPELINE_LEASE_MS;
const PIPELINE_LIST_LIMIT = 30;
const PIPELINE_TEXT_OUTPUT_TOKENS = 7_000;
const PIPELINE_ESTIMATE_OVERHEAD_TOKENS = 12_000;
const PIPELINE_PENDING_REVIEW_LIMIT = 100;
const PIPELINE_REVIEW_ROLES = new Set([
  "boss",
  "ops_director",
  "manager",
  "admin",
  "platform_super",
]);
const PIPELINE_FINAL_REVIEW_ROLES = new Set([
  "boss",
  "admin",
  "platform_super",
]);
const PIPELINE_NOTIFICATION_FINAL_ROLES = new Set(["boss", "admin"]);
const PIPELINE_APPROVAL_BOUNDARY_LABELS = Object.freeze({
  pick: "候选择优",
  review: "人工复核",
  auto: "内部交接确认",
  force: "老板/管理员终审",
  await_metrics: "等待真实发布指标",
});
const PIPELINE_ARTIFACT_MEDIA_TYPES = Object.freeze({
  json: "application/json",
  markdown: "text/markdown",
  images: "application/json",
  covers: "application/json",
  html: "text/html",
  publish_packages: "application/json",
  svg: "image/svg+xml",
});
const PIPELINE_PROVIDER_ASSET_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const PIPELINE_PROVIDER_ASSET_MAX_BYTES = 25 * 1024 * 1024;
const PIPELINE_PROVIDER_ASSET_FETCH_TIMEOUT_MS = 20_000;
const PIPELINE_PROVIDER_ASSET_MAX_REDIRECTS = 3;

function providerAssetError(message, code, status = 409) {
  return new ContentProductionPipelineRouteError(message, status, code);
}

function providerImageMimeFromBytes(bytes) {
  if (!Buffer.isBuffer(bytes)) return "";
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (
    bytes.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
  ) {
    return "image/gif";
  }
  return "";
}

function isPublicProviderAddress(address) {
  const normalized = String(address || "")
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  const mapped =
    /^::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([a-f0-9]{1,4}):([a-f0-9]{1,4}))$/iu.exec(
      normalized,
    );
  if (mapped) {
    const ipv4 =
      mapped[1] ||
      (() => {
        const high = Number.parseInt(mapped[2], 16);
        const low = Number.parseInt(mapped[3], 16);
        return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
      })();
    return isPublicProviderAddress(ipv4);
  }
  const family = isIP(normalized);
  if (family === 4) {
    const parts = normalized.split(".").map(Number);
    const [a, b, c] = parts;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (family === 6) {
    return !(
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:")
    );
  }
  return false;
}

function parseProviderAssetRemoteUrl(
  rawUrl,
  { allowSignedQuery = false } = {},
) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    throw providerAssetError(
      "provider素材URL格式无效，已禁止读取",
      "CONTENT_PIPELINE_PROVIDER_ASSET_URL_UNSAFE",
    );
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    !parsed.hostname ||
    ["localhost", "localhost.localdomain"].includes(
      parsed.hostname.toLowerCase(),
    ) ||
    /\.(?:localhost|local|internal|home|arpa)$/iu.test(parsed.hostname)
  ) {
    throw providerAssetError(
      "provider素材URL协议、凭据或主机不安全，已禁止读取",
      "CONTENT_PIPELINE_PROVIDER_ASSET_URL_UNSAFE",
    );
  }
  if (!allowSignedQuery) {
    for (const key of parsed.searchParams.keys()) {
      if (
        /(?:token|secret|signature|credential|authorization|api[_-]?key|^sig$)/iu.test(
          key,
        )
      ) {
        throw providerAssetError(
          "provider素材URL包含临时凭据，已禁止向客户端跳转",
          "CONTENT_PIPELINE_PROVIDER_ASSET_URL_UNSAFE",
        );
      }
    }
  }
  const literalHost = parsed.hostname.replace(/^\[|\]$/gu, "");
  const literalFamily = isIP(literalHost);
  if (literalFamily && !isPublicProviderAddress(literalHost)) {
    throw providerAssetError(
      "provider素材URL指向非公网地址，已禁止读取",
      "CONTENT_PIPELINE_PROVIDER_ASSET_URL_UNSAFE",
    );
  }
  return parsed;
}

async function verifiedProviderAddress(hostname) {
  const lookupHostname = String(hostname || "").replace(/^\[|\]$/gu, "");
  if (isIP(lookupHostname)) return lookupHostname;
  let addresses;
  try {
    addresses = await lookup(lookupHostname, { all: true, verbatim: true });
  } catch {
    throw providerAssetError(
      "provider素材主机解析失败，无法固化交付",
      "CONTENT_PIPELINE_PROVIDER_ASSET_DOWNLOAD_FAILED",
      502,
    );
  }
  if (
    !addresses.length ||
    addresses.some((item) => !isPublicProviderAddress(item.address))
  ) {
    throw providerAssetError(
      "provider素材主机解析到非公网地址，已阻止SSRF",
      "CONTENT_PIPELINE_PROVIDER_ASSET_URL_UNSAFE",
    );
  }
  return addresses[0].address;
}

export async function downloadContentPipelineProviderAsset(
  rawUrl,
  redirectCount = 0,
) {
  const parsed = parseProviderAssetRemoteUrl(rawUrl, {
    allowSignedQuery: true,
  });
  const requestHostname = parsed.hostname.replace(/^\[|\]$/gu, "");
  const address = await verifiedProviderAddress(requestHostname);
  const requestFn = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = requestFn(
      {
        protocol: parsed.protocol,
        hostname: requestHostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: {
          Accept: "image/png,image/jpeg,image/webp,image/gif",
          Host: parsed.host,
          "User-Agent": "NanoWork-Provider-Asset-Capture/1.0",
        },
        ...(isIP(requestHostname) ? {} : { servername: requestHostname }),
        lookup: (_hostname, _options, callback) =>
          callback(null, address, isIP(address)),
        timeout: PIPELINE_PROVIDER_ASSET_FETCH_TIMEOUT_MS,
      },
      (response) => {
        const status = Number(response.statusCode || 0);
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          if (
            redirectCount >= PIPELINE_PROVIDER_ASSET_MAX_REDIRECTS ||
            !response.headers.location
          ) {
            reject(
              providerAssetError(
                "provider素材重定向次数过多或缺少目标地址",
                "CONTENT_PIPELINE_PROVIDER_ASSET_DOWNLOAD_FAILED",
                502,
              ),
            );
            return;
          }
          const redirected = new URL(
            response.headers.location,
            parsed,
          ).toString();
          downloadContentPipelineProviderAsset(
            redirected,
            redirectCount + 1,
          ).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(
            providerAssetError(
              `provider素材下载返回HTTP ${status || "未知状态"}`,
              "CONTENT_PIPELINE_PROVIDER_ASSET_DOWNLOAD_FAILED",
              502,
            ),
          );
          return;
        }
        const mimeType = String(response.headers["content-type"] || "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        if (!PIPELINE_PROVIDER_ASSET_MEDIA_TYPES.has(mimeType)) {
          response.resume();
          reject(
            providerAssetError(
              "provider素材响应不是允许的图片类型",
              "CONTENT_PIPELINE_PROVIDER_ASSET_MIME_INVALID",
              502,
            ),
          );
          return;
        }
        const declaredLength = Number(response.headers["content-length"] || 0);
        if (declaredLength > PIPELINE_PROVIDER_ASSET_MAX_BYTES) {
          response.resume();
          reject(
            providerAssetError(
              "provider素材超过25MB安全上限",
              "CONTENT_PIPELINE_PROVIDER_ASSET_TOO_LARGE",
              413,
            ),
          );
          return;
        }
        const chunks = [];
        let byteSize = 0;
        response.on("data", (chunk) => {
          byteSize += chunk.length;
          if (byteSize > PIPELINE_PROVIDER_ASSET_MAX_BYTES) {
            request.destroy(
              providerAssetError(
                "provider素材超过25MB安全上限",
                "CONTENT_PIPELINE_PROVIDER_ASSET_TOO_LARGE",
                413,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          const bytes = Buffer.concat(chunks);
          if (providerImageMimeFromBytes(bytes) !== mimeType) {
            reject(
              providerAssetError(
                "provider素材声明MIME与图片字节签名不一致",
                "CONTENT_PIPELINE_PROVIDER_ASSET_MIME_INVALID",
                502,
              ),
            );
            return;
          }
          resolve({ bytes, mimeType });
        });
      },
    );
    request.once("timeout", () =>
      request.destroy(
        providerAssetError(
          "provider素材下载超时，无法固化交付",
          "CONTENT_PIPELINE_PROVIDER_ASSET_DOWNLOAD_TIMEOUT",
          504,
        ),
      ),
    );
    request.once("error", reject);
    request.end();
  });
}

function decodeProviderDataImage(bodySnapshot, expectedMimeType = "") {
  const match =
    /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-z0-9+/]+={0,2})$/iu.exec(
      String(bodySnapshot || ""),
    );
  if (!match) {
    throw providerAssetError(
      "provider图片快照不是合法的data:image/...;base64内容",
      "CONTENT_PIPELINE_PROVIDER_ASSET_INTEGRITY_FAILED",
    );
  }
  const mimeType = match[1].toLowerCase();
  if (
    (expectedMimeType && mimeType !== expectedMimeType.toLowerCase()) ||
    !PIPELINE_PROVIDER_ASSET_MEDIA_TYPES.has(mimeType)
  ) {
    throw providerAssetError(
      "provider图片快照MIME与落库证据不一致",
      "CONTENT_PIPELINE_PROVIDER_ASSET_INTEGRITY_FAILED",
    );
  }
  const bytes = Buffer.from(match[2], "base64");
  if (
    !bytes.length ||
    bytes.length > PIPELINE_PROVIDER_ASSET_MAX_BYTES ||
    bytes.toString("base64").replace(/=+$/u, "") !==
      match[2].replace(/=+$/u, "")
  ) {
    throw providerAssetError(
      "provider图片快照base64损坏或超过安全上限",
      "CONTENT_PIPELINE_PROVIDER_ASSET_INTEGRITY_FAILED",
    );
  }
  if (providerImageMimeFromBytes(bytes) !== mimeType) {
    throw providerAssetError(
      "provider图片快照MIME与真实图片签名不一致",
      "CONTENT_PIPELINE_PROVIDER_ASSET_INTEGRITY_FAILED",
    );
  }
  return { bytes, mimeType };
}

export function contentPipelineStationProviderAttemptBudget(stationIdx) {
  const idx = Number(stationIdx);
  if ([0, 1, 2].includes(idx)) return 2;
  if (idx >= 3 && idx <= 8) return 2;
  return 1;
}

class ContentProductionPipelineRouteError extends Error {
  constructor(
    message,
    status = 400,
    code = "CONTENT_PRODUCTION_PIPELINE_ROUTE_INVALID",
  ) {
    super(message);
    this.name = "ContentProductionPipelineRouteError";
    this.status = status;
    this.code = code;
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonRecord(value) {
  if (isRecord(value)) return clone(value);
  try {
    const parsed = JSON.parse(String(value || ""));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new ContentProductionPipelineRouteError(`${label}必须是正整数`);
  }
  return number;
}

function cleanText(value, max = 500) {
  return String(value ?? "")
    .replace(/\bsk-\s*[a-z0-9_-]{8,}\b/giu, "[REDACTED]")
    .replace(/\bBearer\s+[a-z0-9._~+/=-]{8,}\b/giu, "[REDACTED]")
    .trim()
    .slice(0, max);
}

function stationRefId(pipelineId, stationIdx) {
  const refId = Number(pipelineId) * 10 + Number(stationIdx) + 1;
  if (!Number.isSafeInteger(refId) || refId <= 0) {
    throw new ContentProductionPipelineRouteError(
      "流水线工位计费引用超出安全范围",
      409,
      "CONTENT_PIPELINE_BILLING_REFERENCE_INVALID",
    );
  }
  return refId;
}

export function contentPipelineUnsettledStationBilling({
  tenantId: rawTenantId,
  pipelineId: rawPipelineId,
  stationIdx: rawStationIdx,
} = {}) {
  const tenantId = positiveInteger(rawTenantId, "tenantId");
  const pipelineId = positiveInteger(rawPipelineId, "pipelineId");
  const stationIdx = Number(rawStationIdx);
  if (!Number.isInteger(stationIdx) || stationIdx < 0 || stationIdx > 9) {
    throw new ContentProductionPipelineRouteError("stationIdx必须是0..9");
  }
  const active = [];
  const holdTable =
    q.get(`SELECT 1 ok FROM sqlite_master
    WHERE type='table' AND name='credit_holds'`)?.ok === 1;
  const mainHolds = holdTable
    ? q.all(
        `SELECT id,status,held_credits,settled_credits,ref_type,ref_id
      FROM credit_holds
      WHERE tenant_id=? AND ref_type=? AND ref_id=? AND status='held'
      ORDER BY id ASC`,
        tenantId,
        PIPELINE_REF_TYPE,
        stationRefId(pipelineId, stationIdx),
      )
    : [];
  for (const main of mainHolds) {
    active.push({
      component: "stationText",
      holdId: Number(main.id),
      status: main.status,
      heldCredits: Number(main.held_credits || 0),
      refType: main.ref_type,
      refId: Number(main.ref_id),
    });
  }
  const specialTable =
    q.get(`SELECT 1 ok FROM sqlite_master
    WHERE type='table' AND name='content_pipeline_special_provider_attempts'`)
      ?.ok === 1;
  if (holdTable && specialTable) {
    // 进程若在claim后、预授权前退出，旧claim不能永久阻断重跑。只有租约已过期、
    // 且本轮没有任何hold/产物证据时才回收；其余崩溃窗口一律转待对账。
    reconcileStaleContentPipelineSpecialProviderAttempts({
      tenantId,
      pipelineId,
      stationIdx,
    });
    const rows = q.all(
      `SELECT a.attempt_id,a.status attempt_status,
      a.billing_ref_type,a.billing_ref_id,a.hold_id,
      h.status hold_status,h.held_credits,h.settled_credits
      FROM content_pipeline_special_provider_attempts a
      LEFT JOIN credit_holds h
        ON h.tenant_id=a.tenant_id AND h.id=a.hold_id
      WHERE a.tenant_id=? AND a.pipeline_id=? AND a.station_idx=?
        AND (h.status='held' OR a.status IN ('claimed','persisted','pending_reconciliation'))
      ORDER BY a.id`,
      tenantId,
      pipelineId,
      stationIdx,
    );
    for (const row of rows) {
      active.push({
        component: "specialProvider",
        attemptId: cleanText(row.attempt_id, 160),
        attemptStatus: row.attempt_status,
        holdId: Number(row.hold_id || 0) || null,
        status: row.hold_status || row.attempt_status,
        heldCredits:
          row.hold_status === "held" ? Number(row.held_credits || 0) : 0,
        refType: row.billing_ref_type,
        refId: Number(row.billing_ref_id || 0) || null,
      });
    }
  }
  if (!active.length) return null;
  return {
    state: "pending_reconciliation",
    status: "pending_reconciliation",
    pendingReconciliation: true,
    heldCredits: active.reduce(
      (total, item) => total + Number(item.heldCredits || 0),
      0,
    ),
    holdIds: [...new Set(active.map((item) => item.holdId).filter(Boolean))],
    components: active,
    note: "当前工位仍有未释放预授权或待对账provider attempt，禁止重跑。",
  };
}

export function classifyContentPipelineRecovery(input = {}) {
  const tenantId = positiveInteger(input.tenantId, "tenantId");
  const pipelineId = positiveInteger(input.pipelineId, "pipelineId");
  const stationIdx = Number(input.stationIdx);
  if (!Number.isInteger(stationIdx) || stationIdx < 0 || stationIdx > 9) {
    throw new ContentProductionPipelineRouteError("stationIdx必须是0..9");
  }
  const unsettled = contentPipelineUnsettledStationBilling({
    tenantId,
    pipelineId,
    stationIdx,
  });
  if (unsettled) {
    return {
      safeToResume: false,
      code: "CONTENT_PIPELINE_RECOVERY_UNSETTLED_BILLING",
      message: "当前工位存在held占扣或provider待对账状态，禁止自动重放",
      heldCredits: Number(unsettled.heldCredits || 0),
    };
  }
  const holdTable =
    q.get(`SELECT 1 ok FROM sqlite_master
    WHERE type='table' AND name='credit_holds'`)?.ok === 1;
  if (holdTable && input.station?.output == null) {
    const chargedWithoutDelivery = q.get(
      `SELECT id,settled_credits FROM credit_holds
      WHERE tenant_id=? AND ref_type=? AND ref_id=? AND status='settled'
        AND COALESCE(settled_credits,0)>0 ORDER BY id DESC LIMIT 1`,
      tenantId,
      PIPELINE_REF_TYPE,
      stationRefId(pipelineId, stationIdx),
    );
    if (chargedWithoutDelivery) {
      return {
        safeToResume: false,
        code: "CONTENT_PIPELINE_RECOVERY_CHARGED_WITHOUT_DELIVERY",
        message: "账本显示provider已结算但工位未形成业务产物，需人工对账",
        heldCredits: 0,
      };
    }
  }
  const specialTable =
    q.get(`SELECT 1 ok FROM sqlite_master
    WHERE type='table' AND name='content_pipeline_special_provider_attempts'`)
      ?.ok === 1;
  if (specialTable && input.station?.output == null) {
    const providerDelivered = q.get(
      `SELECT id,status FROM content_pipeline_special_provider_attempts
      WHERE tenant_id=? AND pipeline_id=? AND station_idx=?
        AND (output_json IS NOT NULL OR delivery_json IS NOT NULL
          OR status IN ('persisted','settled','pending_reconciliation'))
      ORDER BY id DESC LIMIT 1`,
      tenantId,
      pipelineId,
      stationIdx,
    );
    if (providerDelivered) {
      return {
        safeToResume: false,
        code: "CONTENT_PIPELINE_RECOVERY_PROVIDER_DELIVERY_UNCERTAIN",
        message:
          "特殊provider已有产物或结算证据，但工位主产物未完成，禁止自动重放",
        heldCredits: 0,
      };
    }
  }
  return {
    safeToResume: true,
    code: "CONTENT_PIPELINE_RECOVERY_UNAMBIGUOUS",
    message: "无held占扣、无已交付provider产物、无待对账状态",
    heldCredits: 0,
  };
}

export function releaseContentPipelineUndeliveredHoldsInCurrentTransaction({
  tenantId: rawTenantId,
  pipelineId: rawPipelineId,
  stationIdx: rawStationIdx,
  station,
  cancelledAt,
} = {}) {
  const tenantId = positiveInteger(rawTenantId, "tenantId");
  const pipelineId = positiveInteger(rawPipelineId, "pipelineId");
  const stationIdx = Number(rawStationIdx);
  if (!Number.isInteger(stationIdx) || stationIdx < 0 || stationIdx > 9) {
    throw new ContentProductionPipelineRouteError("stationIdx必须是0..9");
  }
  if (station?.output != null) {
    return {
      releasedCount: 0,
      releasedCredits: 0,
      preservedDeliveredStation: true,
    };
  }
  const released = releaseHeldCreditsByRefInCurrentTransaction({
    tenantId,
    refType: PIPELINE_REF_TYPE,
    refId: stationRefId(pipelineId, stationIdx),
    note: `pipeline#${pipelineId}取消；工位${stationIdx}未交付主产物，释放文本provider预授权`,
  });
  const specialTable =
    q.get(`SELECT 1 ok FROM sqlite_master
    WHERE type='table' AND name='content_pipeline_special_provider_attempts'`)
      ?.ok === 1;
  const specialReleased = [];
  if (specialTable) {
    const attempts = q.all(
      `SELECT id,attempt_id,billing_ref_type,billing_ref_id
      FROM content_pipeline_special_provider_attempts
      WHERE tenant_id=? AND pipeline_id=? AND station_idx=? AND status='claimed'
        AND output_json IS NULL AND delivery_json IS NULL ORDER BY id`,
      tenantId,
      pipelineId,
      stationIdx,
    );
    for (const attempt of attempts) {
      const refId = Number(attempt.billing_ref_id);
      const refType = cleanText(attempt.billing_ref_type, 160);
      let specialBilling = {
        releasedCount: 0,
        releasedCredits: 0,
        holdIds: [],
      };
      if (refType && Number.isSafeInteger(refId) && refId > 0) {
        specialBilling = releaseHeldCreditsByRefInCurrentTransaction({
          tenantId,
          refType,
          refId,
          note: `pipeline#${pipelineId}取消；工位${stationIdx}特殊provider未交付产物，释放预授权`,
        });
      }
      const billing = {
        state: "released",
        status: "released",
        pendingReconciliation: false,
        chargedCredits: 0,
        heldCredits: 0,
        releasedCredits: Number(specialBilling.releasedCredits || 0),
        cancelledAt: cleanText(cancelledAt, 80) || null,
      };
      const updated = q.run(
        `UPDATE content_pipeline_special_provider_attempts
        SET status='released',billing_json=?,error_json=?,lease_token=NULL,
          lease_expires_at=NULL,updated_at=datetime('now','localtime')
        WHERE tenant_id=? AND id=? AND status='claimed'
          AND output_json IS NULL AND delivery_json IS NULL`,
        JSON.stringify(billing),
        JSON.stringify({
          code: "CONTENT_PIPELINE_CANCELLED",
          message: "流水线取消，未交付provider attempt已关闭",
        }),
        tenantId,
        attempt.id,
      );
      if (updated.changes !== 1) {
        throw new ContentProductionPipelineRouteError(
          "特殊provider状态已变化，取消未完成",
          409,
          "CONTENT_PIPELINE_CANCEL_PROVIDER_CONFLICT",
        );
      }
      specialReleased.push({
        attemptId: cleanText(attempt.attempt_id, 160),
        releasedCredits: Number(specialBilling.releasedCredits || 0),
        holdIds: specialBilling.holdIds || [],
      });
    }
  }
  return {
    releasedCount:
      Number(released.releasedCount || 0) +
      specialReleased.reduce(
        (total, item) => total + Number(item.holdIds?.length || 0),
        0,
      ),
    releasedCredits:
      Number(released.releasedCredits || 0) +
      specialReleased.reduce(
        (total, item) => total + Number(item.releasedCredits || 0),
        0,
      ),
    holdIds: [
      ...(released.holdIds || []),
      ...specialReleased.flatMap((item) => item.holdIds || []),
    ],
    specialReleased,
    preservedSettledHistory: true,
  };
}

function pipelineActor(tenantId, userId) {
  const actor = q.get(
    `SELECT id,tenant_id,name,role,status
    FROM users WHERE tenant_id=? AND id=?`,
    tenantId,
    userId,
  );
  if (!actor || actor.status !== "启用") {
    throw new ContentProductionPipelineRouteError(
      "流水线执行账号不存在、不属于当前租户或已停用",
      409,
      "CONTENT_PIPELINE_ACTOR_UNAVAILABLE",
    );
  }
  return actor;
}

function configuredStationTextModel(profile, role) {
  const configured = cleanText(
    profile?.workConfig?.factoryDefault?.common?.textModel ||
      profile?.runtimeBindings?.currentRuntimeBindings?.models?.text
        ?.factoryModel,
    160,
  );
  return configured && configured !== "inherit"
    ? configured
    : textModelFor(role);
}

function providerDeliveryFrom(generated) {
  return (
    generated?.handlerEvidence?.providerDelivery ||
    generated?.handlerEvidence?.productionRuntime?.providerDelivery ||
    null
  );
}

function specialProviderAttemptsFrom(generated) {
  const attempts =
    generated?.handlerEvidence?.productionRuntime?.specialRuntime?.bridge
      ?.attempts;
  return Array.isArray(attempts) ? attempts.filter(isRecord) : [];
}

export function mergeContentPipelineStationBillingEvidence(
  generated,
  stationTextBilling,
) {
  return mergeContentSpecialProviderBillingEvidence(
    stationTextBilling,
    specialProviderAttemptsFrom(generated),
    {
      primaryComponent: "stationText",
      pendingNote:
        "工位主产物已持久化，但图片/素材provider仍有预授权待对账；流水线必须停在当前工位。",
      settledNote: "工位文本与图片/素材provider均已完成权威结算。",
    },
  );
}

export function createStationDeliveryBoundary({ repository }) {
  return async (input) => {
    const tenantId = positiveInteger(input?.tenantId, "tenantId");
    const pipelineId = positiveInteger(input?.pipelineId, "pipelineId");
    const stationIdx = Number(input?.stationIdx);
    if (!Number.isInteger(stationIdx) || stationIdx < 0 || stationIdx > 9) {
      throw new ContentProductionPipelineRouteError(
        "stationIdx必须是0..9之间的整数",
      );
    }
    const job = repository.getJob(tenantId, pipelineId);
    if (!job) {
      throw new ContentProductionPipelineRouteError(
        "内容生产流水线不存在",
        404,
        "CONTENT_PIPELINE_NOT_FOUND",
      );
    }
    const actor = pipelineActor(tenantId, job.createdBy);
    const profile = canonicalContentEmployeeProfileFor(stationIdx);
    const model = configuredStationTextModel(profile, actor.role);
    const persistedUpstream = repository.readCompletedOutputsBefore(
      tenantId,
      pipelineId,
      stationIdx,
    );
    const estimatePayload = JSON.stringify({
      canonicalProfile: profile,
      task: job.task,
      persona: job.persona,
      settings: job.settings,
      workflow: job.workflow,
      persistedUpstream,
      expectedPromptEvidence: input.expectedPromptEvidence,
    });
    const providerAttemptBudget =
      contentPipelineStationProviderAttemptBudget(stationIdx);
    const singleCallEstimatedCredits = estimateCallCredits({
      kind: "text",
      model,
      texts: [estimatePayload],
      outputTokens: PIPELINE_TEXT_OUTPUT_TOKENS,
      overheadTokens: PIPELINE_ESTIMATE_OVERHEAD_TOKENS,
    });
    // 联网研究工位0/1/2最多会在同一工位内进行1次“真实快照白名单”定向返工。
    // 两次文本provider必须共用同一hold，所以在首次调用前一次性授权
    // 最多2次的上限；不能返工时再占第二笔，也不能产物落库后才发现超额。
    const credits = singleCallEstimatedCredits * providerAttemptBudget;
    const hold = holdCredits({
      userId: actor.id,
      tenantId,
      feature: `内容团队流水线·${profile.identity.name}`,
      kind: "text",
      model,
      credits,
      refType: PIPELINE_REF_TYPE,
      refId: stationRefId(pipelineId, stationIdx),
      note: `pipeline#${pipelineId}工位${stationIdx}调用真实云API前预授权；生成或业务落库失败全额释放。`,
    });
    const delivered = await executeHeldDelivery({
      hold,
      generate: input.generate,
      persist: input.persist,
      settle: settleHold,
      release: releaseHold,
      settlement: (generated) => {
        const provider = providerDeliveryFrom(generated);
        if (!provider || provider.mode !== "api") {
          throw Object.assign(new Error("工位缺少可结算的真实API交付证据"), {
            code: "CONTENT_PIPELINE_PROVIDER_DELIVERY_MISSING",
            status: 409,
          });
        }
        return {
          usage: clone(provider.usage || {}),
          model: cleanText(provider.model, 160) || model,
          aiMode: "api",
          note: `pipeline#${pipelineId}工位${stationIdx}产物已持久化，按真实token结算`,
        };
      },
      requirePositiveApiUsage: true,
      releaseNote: (error, phase) =>
        `pipeline#${pipelineId}工位${stationIdx}未交付（phase=${phase}；` +
        `${cleanText(error?.code || error?.name || "failed", 100)}），预授权全额释放`,
    });
    return {
      generated: delivered.output,
      persisted: delivered.delivery,
      billingEvidence: {
        ...mergeContentPipelineStationBillingEvidence(
          delivered.output,
          delivered.billing,
        ),
        providerAttemptBudget,
        singleCallEstimatedCredits,
      },
    };
  };
}

function specialProviderEntries(output) {
  const entries = [
    ...(Array.isArray(output?.images) ? output.images : []),
    ...(Array.isArray(output?.assets) ? output.assets : []),
  ];
  if (
    !entries.length &&
    isRecord(output) &&
    (output.url || output.b64 || output.content)
  ) {
    entries.push(output);
  }
  return entries.filter(isRecord);
}

export function ensureContentPipelineSpecialProviderAttemptSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_pipeline_special_provider_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      pipeline_id INTEGER NOT NULL,
      station_idx INTEGER NOT NULL CHECK(station_idx BETWEEN 0 AND 9),
      provider_kind TEXT NOT NULL CHECK(provider_kind IN ('image','material')),
      attempt_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      billing_ref_type TEXT NOT NULL,
      billing_ref_id INTEGER NOT NULL,
      hold_id INTEGER,
      status TEXT NOT NULL CHECK(status IN (
        'claimed','persisted','settled','pending_reconciliation','released','failed'
      )),
      output_json TEXT,
      delivery_json TEXT,
      billing_json TEXT,
      error_json TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      hold_floor_id INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(tenant_id,attempt_id),
      UNIQUE(tenant_id,billing_ref_type,billing_ref_id)
    );
    CREATE INDEX IF NOT EXISTS idx_content_pipeline_special_attempt_pipeline
      ON content_pipeline_special_provider_attempts(
        tenant_id,pipeline_id,station_idx,provider_kind,status
      );
  `);
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(content_pipeline_special_provider_attempts)")
      .all()
      .map((column) => String(column.name)),
  );
  if (!columns.has("lease_token")) {
    db.exec(
      "ALTER TABLE content_pipeline_special_provider_attempts ADD COLUMN lease_token TEXT",
    );
  }
  if (!columns.has("lease_expires_at")) {
    db.exec(
      "ALTER TABLE content_pipeline_special_provider_attempts ADD COLUMN lease_expires_at TEXT",
    );
  }
  if (!columns.has("hold_floor_id")) {
    db.exec(`ALTER TABLE content_pipeline_special_provider_attempts
      ADD COLUMN hold_floor_id INTEGER NOT NULL DEFAULT 0`);
  }
}

function normalizedSpecialAttempt(input) {
  const tenantId = positiveInteger(input?.tenantId, "特殊provider tenantId");
  if (tenantId !== curTenant()) {
    throw new ContentProductionPipelineRouteError(
      "特殊供应商尝试与当前租户上下文不匹配",
      500,
      "CONTENT_PIPELINE_PROVIDER_TENANT_MISMATCH",
    );
  }
  const pipelineId = positiveInteger(input?.runId, "特殊provider pipelineId");
  const stationIdx = Number(input?.employeeIdx);
  if (!Number.isInteger(stationIdx) || stationIdx < 0 || stationIdx > 9) {
    throw new ContentProductionPipelineRouteError(
      "特殊provider stationIdx必须是0..9",
    );
  }
  const kind = String(input?.kind || "");
  if (!["image", "material"].includes(kind)) {
    throw new ContentProductionPipelineRouteError(
      "特殊provider kind必须是image或material",
    );
  }
  const attemptId = cleanText(input?.attemptId, 160);
  const requestFingerprint = cleanText(input?.requestFingerprint, 100);
  const refType = cleanText(input?.refType, 100);
  const refId = positiveInteger(input?.refId, "特殊provider refId");
  if (
    !attemptId ||
    !/^sha256:[a-f0-9]{64}$/u.test(requestFingerprint) ||
    refType !== "content_special_provider"
  ) {
    throw new ContentProductionPipelineRouteError(
      "特殊provider幂等身份不完整",
      409,
      "CONTENT_PIPELINE_PROVIDER_ATTEMPT_IDENTITY_INVALID",
    );
  }
  const leaseToken = cleanText(input?.leaseToken, 100) || null;
  return {
    tenantId,
    pipelineId,
    stationIdx,
    kind,
    attemptId,
    requestFingerprint,
    refType,
    refId,
    leaseToken,
  };
}

function specialAttemptRow(identity) {
  return q.get(
    `SELECT * FROM content_pipeline_special_provider_attempts
    WHERE tenant_id=? AND attempt_id=?`,
    identity.tenantId,
    identity.attemptId,
  );
}

function assertSpecialAttemptRow(row, identity) {
  if (
    !row ||
    Number(row.pipeline_id) !== identity.pipelineId ||
    Number(row.station_idx) !== identity.stationIdx ||
    row.provider_kind !== identity.kind ||
    row.request_fingerprint !== identity.requestFingerprint ||
    row.billing_ref_type !== identity.refType ||
    Number(row.billing_ref_id) !== identity.refId
  ) {
    throw new ContentProductionPipelineRouteError(
      "特殊provider幂等键已存在但业务身份或请求指纹不一致，已拒绝复用",
      409,
      "CONTENT_PIPELINE_PROVIDER_ATTEMPT_CONFLICT",
    );
  }
  return row;
}

function specialAttemptCurrentCycleHold(row) {
  const holdTable =
    q.get(`SELECT 1 ok FROM sqlite_master
    WHERE type='table' AND name='credit_holds'`)?.ok === 1;
  if (!holdTable) return null;
  if (row?.hold_id) {
    const linked = q.get(
      `SELECT id,status,held_credits,settled_credits,ref_type,ref_id
      FROM credit_holds WHERE tenant_id=? AND id=?`,
      row.tenant_id,
      row.hold_id,
    );
    if (linked) return linked;
  }
  return q.get(
    `SELECT id,status,held_credits,settled_credits,ref_type,ref_id
    FROM credit_holds
    WHERE tenant_id=? AND ref_type=? AND ref_id=? AND id>?
    ORDER BY id DESC LIMIT 1`,
    row?.tenant_id,
    row?.billing_ref_type,
    row?.billing_ref_id,
    Number(row?.hold_floor_id || 0),
  );
}

function specialAttemptLeaseExpired(row, nowMs) {
  const expiresAt = Date.parse(String(row?.lease_expires_at || ""));
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs;
}

function specialAttemptPendingReconciliation(row, hold, reason) {
  const stored = jsonRecord(row?.billing_json);
  const holdId = Number(hold?.id || row?.hold_id || 0) || null;
  const heldCredits =
    hold?.status === "held" ? Number(hold.held_credits || 0) : 0;
  const billing = {
    ...stored,
    state: "pending_reconciliation",
    holdId,
    estimatedCredits: Number(
      hold?.held_credits || stored.estimatedCredits || 0,
    ),
    heldCredits,
    chargedCredits:
      hold?.status === "settled" ? Number(hold.settled_credits || 0) : null,
    credits:
      hold?.status === "settled" ? Number(hold.settled_credits || 0) : null,
    pendingReconciliation: true,
    note: "特殊provider进程在交付状态落盘前中断；存在预授权或调用可能性，禁止自动退款与重跑。",
  };
  q.run(
    `UPDATE content_pipeline_special_provider_attempts
    SET hold_id=COALESCE(?,hold_id),status='pending_reconciliation',
      lease_token=NULL,lease_expires_at=NULL,billing_json=?,error_json=?,
      updated_at=datetime('now','localtime')
    WHERE tenant_id=? AND attempt_id=? AND status='claimed'`,
    holdId,
    JSON.stringify(billing),
    JSON.stringify({
      code: "CONTENT_PIPELINE_PROVIDER_CRASH_REQUIRES_RECONCILIATION",
      reason,
      recoveredAt: new Date().toISOString(),
    }),
    row.tenant_id,
    row.attempt_id,
  );
  return {
    state: "pending_reconciliation",
    status: "pending_reconciliation",
    holdId,
  };
}

function reconcileStaleSpecialAttemptRow(row, nowMs) {
  if (row?.status !== "claimed" || !specialAttemptLeaseExpired(row, nowMs)) {
    return { state: "active", status: row?.status || null };
  }
  const hold = specialAttemptCurrentCycleHold(row);
  if (row.hold_id || hold || row.output_json || row.delivery_json) {
    return specialAttemptPendingReconciliation(
      row,
      hold,
      row.output_json || row.delivery_json
        ? "stale_claim_with_delivery_evidence"
        : "stale_claim_with_hold_or_unknown_provider_call",
    );
  }
  q.run(
    `DELETE FROM content_pipeline_special_provider_attempts
    WHERE tenant_id=? AND attempt_id=? AND status='claimed'`,
    row.tenant_id,
    row.attempt_id,
  );
  return { state: "reclaimed", status: "reclaimed", removedEmptyClaim: true };
}

function reconcileStaleContentPipelineSpecialProviderAttempts({
  tenantId,
  pipelineId,
  stationIdx,
  now = new Date(),
}) {
  ensureContentPipelineSpecialProviderAttemptSchema();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("特殊provider恢复时钟无效");
  const rows = q.all(
    `SELECT * FROM content_pipeline_special_provider_attempts
    WHERE tenant_id=? AND pipeline_id=? AND station_idx=? AND status='claimed'`,
    tenantId,
    pipelineId,
    stationIdx,
  );
  for (const row of rows) reconcileStaleSpecialAttemptRow(row, nowMs);
}

function authoritativeSpecialAttemptBilling(row) {
  const stored = jsonRecord(row?.billing_json);
  const hold = specialAttemptCurrentCycleHold(row);
  if (hold?.status === "held") {
    return {
      ...stored,
      state: "pending_reconciliation",
      holdId: Number(hold.id),
      estimatedCredits: Number(hold.held_credits || 0),
      heldCredits: Number(hold.held_credits || 0),
      chargedCredits: null,
      credits: null,
      pendingReconciliation: true,
      note: stored.note || "特殊provider产物已持久化，预授权仍在待对账。",
    };
  }
  if (hold?.status === "settled") {
    const chargedCredits = Number(hold.settled_credits || 0);
    return {
      ...stored,
      state: "settled",
      holdId: Number(hold.id),
      estimatedCredits: Number(hold.held_credits || 0),
      heldCredits: 0,
      chargedCredits,
      credits: chargedCredits,
      pendingReconciliation: false,
    };
  }
  return stored;
}

function replaySpecialAttempt(row) {
  const output = jsonRecord(row?.output_json);
  const delivery = jsonRecord(row?.delivery_json);
  if (
    !Object.keys(output).length ||
    delivery.persisted !== true ||
    !Array.isArray(delivery.artifactIds) ||
    !delivery.artifactIds.length
  ) {
    return null;
  }
  const billing = authoritativeSpecialAttemptBilling(row);
  return {
    state: "replay",
    output,
    delivery,
    billing,
    hold: row.hold_id
      ? {
          holdId: Number(row.hold_id),
          estimatedCredits: Number(billing.estimatedCredits || 0),
        }
      : null,
  };
}

export function createContentPipelineSpecialProviderAttemptStore(
  dependencies = {},
) {
  ensureContentPipelineSpecialProviderAttemptSchema();
  const downloadProviderAssetFn =
    dependencies.downloadProviderAssetFn ||
    downloadContentPipelineProviderAsset;
  const readLocalProviderAssetFn =
    dependencies.readLocalProviderAssetFn || readTenantUploadedFileByUrl;
  const nowFn = dependencies.now || (() => new Date());
  const randomUUIDFn = dependencies.randomUUIDFn || randomUUID;
  const claimLeaseMs = Number(
    dependencies.claimLeaseMs ?? SPECIAL_PROVIDER_CLAIM_LEASE_MS,
  );
  if (
    typeof downloadProviderAssetFn !== "function" ||
    typeof readLocalProviderAssetFn !== "function"
  ) {
    throw new TypeError(
      "内容流水线provider产物存储缺少downloadProviderAssetFn",
    );
  }
  if (
    typeof nowFn !== "function" ||
    typeof randomUUIDFn !== "function" ||
    !Number.isSafeInteger(claimLeaseMs) ||
    claimLeaseMs < 1_000
  ) {
    throw new TypeError("内容流水线provider claim租约依赖不完整");
  }

  const leaseSnapshot = () => {
    const observed = nowFn();
    const now = observed instanceof Date ? observed : new Date(observed);
    if (!Number.isFinite(now.getTime()))
      throw new TypeError("特殊provider claim时钟无效");
    const leaseToken = cleanText(randomUUIDFn(), 100);
    if (!leaseToken) throw new TypeError("特殊provider claim租约令牌无效");
    return {
      nowMs: now.getTime(),
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + claimLeaseMs).toISOString(),
    };
  };

  const currentHoldFloor = (identity) => {
    const holdTable =
      q.get(`SELECT 1 ok FROM sqlite_master
      WHERE type='table' AND name='credit_holds'`)?.ok === 1;
    if (!holdTable) return 0;
    return Number(
      q.get(
        `SELECT COALESCE(MAX(id),0) id
      FROM credit_holds WHERE tenant_id=? AND ref_type=? AND ref_id=?`,
        identity.tenantId,
        identity.refType,
        identity.refId,
      )?.id || 0,
    );
  };

  const assertedClaimLease = (row, identity) => {
    if (
      row.status !== "claimed" ||
      !identity.leaseToken ||
      row.lease_token !== identity.leaseToken
    ) {
      throw new ContentProductionPipelineRouteError(
        "特殊provider claim租约已失效，禁止旧进程继续占分、落库或改写账务",
        409,
        "CONTENT_PIPELINE_PROVIDER_CLAIM_LEASE_LOST",
      );
    }
    return row;
  };

  const resolve = (rawIdentity) => {
    const identity = normalizedSpecialAttempt(rawIdentity);
    const row = specialAttemptRow(identity);
    if (!row) return null;
    assertSpecialAttemptRow(row, identity);
    const replay = replaySpecialAttempt(row);
    if (replay) return replay;
    if (["released", "failed"].includes(row.status)) return null;
    return { state: "in_progress", status: row.status };
  };

  const claim = (rawIdentity) => {
    const identity = normalizedSpecialAttempt(rawIdentity);
    const lease = leaseSnapshot();
    const claimed = (extra) => ({
      state: "claimed",
      leaseToken: lease.leaseToken,
      leaseExpiresAt: lease.leaseExpiresAt,
      ...extra,
    });
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = specialAttemptRow(identity);
      if (existing) {
        assertSpecialAttemptRow(existing, identity);
        const replay = replaySpecialAttempt(existing);
        if (replay) {
          db.exec("COMMIT");
          return replay;
        }
        if (["released", "failed"].includes(existing.status)) {
          q.run(
            `UPDATE content_pipeline_special_provider_attempts
            SET status='claimed',hold_id=NULL,output_json=NULL,delivery_json=NULL,
              billing_json=NULL,error_json=NULL,lease_token=?,lease_expires_at=?,
              hold_floor_id=?,updated_at=datetime('now','localtime')
            WHERE tenant_id=? AND attempt_id=? AND status IN ('released','failed')`,
            lease.leaseToken,
            lease.leaseExpiresAt,
            currentHoldFloor(identity),
            identity.tenantId,
            identity.attemptId,
          );
          db.exec("COMMIT");
          return claimed({ retriedAfterReleasedAttempt: true });
        }
        if (existing.status === "claimed") {
          const recovered = reconcileStaleSpecialAttemptRow(
            existing,
            lease.nowMs,
          );
          if (recovered.state === "pending_reconciliation") {
            db.exec("COMMIT");
            return recovered;
          }
          if (recovered.state !== "reclaimed") {
            db.exec("COMMIT");
            return {
              state: "in_progress",
              status: existing.status,
              leaseExpiresAt: existing.lease_expires_at || null,
            };
          }
        } else {
          db.exec("COMMIT");
          return { state: "in_progress", status: existing.status };
        }
      }
      q.run(
        `INSERT INTO content_pipeline_special_provider_attempts(
        tenant_id,pipeline_id,station_idx,provider_kind,attempt_id,
        request_fingerprint,billing_ref_type,billing_ref_id,status,
        lease_token,lease_expires_at,hold_floor_id,created_by
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        identity.tenantId,
        identity.pipelineId,
        identity.stationIdx,
        identity.kind,
        identity.attemptId,
        identity.requestFingerprint,
        identity.refType,
        identity.refId,
        "claimed",
        lease.leaseToken,
        lease.leaseExpiresAt,
        currentHoldFloor(identity),
        positiveInteger(rawIdentity.userId, "特殊provider userId"),
      );
      db.exec("COMMIT");
      return claimed({ recoveredStaleEmptyClaim: Boolean(existing) });
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 保留原始错误 */
      }
      throw error;
    }
  };

  const validateClaim = (rawAttempt) => {
    const identity = normalizedSpecialAttempt(rawAttempt);
    const renewal = leaseSnapshot();
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = assertedClaimLease(
        assertSpecialAttemptRow(specialAttemptRow(identity), identity),
        identity,
      );
      if (specialAttemptLeaseExpired(row, renewal.nowMs)) {
        throw new ContentProductionPipelineRouteError(
          "特殊provider claim租约已过期，禁止继续创建预授权",
          409,
          "CONTENT_PIPELINE_PROVIDER_CLAIM_LEASE_EXPIRED",
        );
      }
      const changed = q.run(
        `UPDATE content_pipeline_special_provider_attempts
        SET lease_expires_at=?,updated_at=datetime('now','localtime')
        WHERE tenant_id=? AND attempt_id=? AND status='claimed' AND lease_token=?`,
        renewal.leaseExpiresAt,
        identity.tenantId,
        identity.attemptId,
        identity.leaseToken,
      );
      if (changed.changes !== 1) {
        throw new ContentProductionPipelineRouteError(
          "特殊provider claim续租失败，禁止继续创建预授权",
          409,
          "CONTENT_PIPELINE_PROVIDER_CLAIM_LEASE_LOST",
        );
      }
      db.exec("COMMIT");
      return {
        state: "claimed",
        leaseToken: identity.leaseToken,
        leaseExpiresAt: renewal.leaseExpiresAt,
      };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 保留原始错误 */
      }
      throw error;
    }
  };

  const associateHold = (rawAttempt) => {
    const identity = normalizedSpecialAttempt(rawAttempt);
    const holdId = positiveInteger(
      rawAttempt?.hold?.holdId ?? rawAttempt?.holdId,
      "特殊provider holdId",
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = assertedClaimLease(
        assertSpecialAttemptRow(specialAttemptRow(identity), identity),
        identity,
      );
      if (row.hold_id && Number(row.hold_id) !== holdId) {
        throw new ContentProductionPipelineRouteError(
          "特殊provider claim已关联其他预授权，禁止覆盖",
          409,
          "CONTENT_PIPELINE_PROVIDER_HOLD_CONFLICT",
        );
      }
      if (holdId <= Number(row.hold_floor_id || 0)) {
        throw new ContentProductionPipelineRouteError(
          "特殊provider预授权不属于当前claim周期",
          409,
          "CONTENT_PIPELINE_PROVIDER_HOLD_STALE",
        );
      }
      const holdTable =
        q.get(`SELECT 1 ok FROM sqlite_master
        WHERE type='table' AND name='credit_holds'`)?.ok === 1;
      const holdRow = holdTable
        ? q.get(
            `SELECT tenant_id,ref_type,ref_id FROM credit_holds WHERE id=?`,
            holdId,
          )
        : null;
      if (
        holdRow &&
        (Number(holdRow.tenant_id) !== identity.tenantId ||
          holdRow.ref_type !== identity.refType ||
          Number(holdRow.ref_id) !== identity.refId)
      ) {
        throw new ContentProductionPipelineRouteError(
          "特殊provider预授权与claim业务身份不一致",
          409,
          "CONTENT_PIPELINE_PROVIDER_HOLD_IDENTITY_MISMATCH",
        );
      }
      const changed = q.run(
        `UPDATE content_pipeline_special_provider_attempts
        SET hold_id=?,updated_at=datetime('now','localtime')
        WHERE tenant_id=? AND attempt_id=? AND status='claimed' AND lease_token=?`,
        holdId,
        identity.tenantId,
        identity.attemptId,
        identity.leaseToken,
      );
      if (changed.changes !== 1) {
        throw new ContentProductionPipelineRouteError(
          "特殊provider预授权关联失败，禁止进入外部provider",
          409,
          "CONTENT_PIPELINE_PROVIDER_HOLD_ASSOCIATION_FAILED",
        );
      }
      db.exec("COMMIT");
      return { state: "associated", holdId };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 保留原始错误 */
      }
      throw error;
    }
  };

  const persist = async ({
    tenantId,
    userId,
    runId,
    employeeIdx,
    kind,
    imageModel,
    request,
    output,
    attempt,
    hold,
  }) => {
    const identity = normalizedSpecialAttempt({
      ...attempt,
      tenantId,
      runId,
      employeeIdx,
      kind,
    });
    const entries = specialProviderEntries(output);
    if (!entries.length) throw new Error("特殊供应商没有可持久化产物");
    // 不在SQLite写事务中等待外部下载；先完成所有安全校验与字节固化，
    // 然后用一个短事务原子落库素材与attempt台账。
    const capturedEntries = await Promise.all(
      entries.map(async (item) => {
        const declaredMimeType = cleanText(
          item.mimeType || item.mime_type || "image/png",
          100,
        ).toLowerCase();
        const url = String(item.url || item.file || "").trim();
        const base64 = typeof item.b64 === "string" ? item.b64 : "";
        const content = typeof item.content === "string" ? item.content : "";
        let captured;
        if (kind === "material") {
          const rights = isRecord(item.rights) ? item.rights : {};
          const materialId = Number(item.materialId);
          if (
            rights.confirmed !== true ||
            rights.commercialUse !== true ||
            !cleanText(rights.license, 200) ||
            !Number.isSafeInteger(materialId) ||
            materialId <= 0 ||
            !url.startsWith(`/uploads/files/${tenantId}/`)
          ) {
            throw providerAssetError(
              "真实素材缺少租户本地文件或完整商用授权证据",
              "CONTENT_PIPELINE_MATERIAL_RIGHTS_INVALID",
              409,
            );
          }
        }
        if (base64) {
          captured = decodeProviderDataImage(
            `data:${declaredMimeType};base64,${base64}`,
            declaredMimeType,
          );
        } else if (content) {
          captured = decodeProviderDataImage(content, declaredMimeType);
        } else if (url.startsWith(`/uploads/files/${tenantId}/`)) {
          captured = await readLocalProviderAssetFn({
            tenantId,
            fileUrl: url,
            maxBytes: PIPELINE_PROVIDER_ASSET_MAX_BYTES,
          });
        } else if (url) {
          // URL只用于服务端一次性抓取。任何签名URL都不进入materials.url或公共JSON；
          // 下载器钉住已验证公网IP、逐跳校验重定向并限制类型/体积/超时。
          captured = await downloadProviderAssetFn(url);
        } else {
          throw new Error("特殊供应商产物缺少可固化的图片字节或URL");
        }
        const mimeType = cleanText(captured?.mimeType, 100).toLowerCase();
        const bytes = Buffer.isBuffer(captured?.bytes)
          ? captured.bytes
          : Buffer.from(captured?.bytes || []);
        if (
          !PIPELINE_PROVIDER_ASSET_MEDIA_TYPES.has(mimeType) ||
          !bytes.length ||
          providerImageMimeFromBytes(bytes) !== mimeType ||
          bytes.length > PIPELINE_PROVIDER_ASSET_MAX_BYTES
        ) {
          throw providerAssetError(
            "provider图片固化结果类型、内容或体积不合法",
            "CONTENT_PIPELINE_PROVIDER_ASSET_CAPTURE_INVALID",
            502,
          );
        }
        return { item, mimeType, bytes };
      }),
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = assertSpecialAttemptRow(
        specialAttemptRow(identity),
        identity,
      );
      const replay = replaySpecialAttempt(row);
      if (replay) {
        db.exec("COMMIT");
        return replay.delivery;
      }
      assertedClaimLease(row, identity);
      const holdId = positiveInteger(hold?.holdId, "特殊provider holdId");
      if (Number(row.hold_id || 0) !== holdId) {
        throw new ContentProductionPipelineRouteError(
          "特殊provider产物对应的预授权尚未与claim可靠关联",
          409,
          "CONTENT_PIPELINE_PROVIDER_HOLD_NOT_ASSOCIATED",
        );
      }
      const artifactIds = [];
      for (const [index, capturedEntry] of capturedEntries.entries()) {
        const { item, mimeType, bytes } = capturedEntry;
        const bodySnapshot = `data:${mimeType};base64,${bytes.toString("base64")}`;
        const contentSha256 = createHash("sha256").update(bytes).digest("hex");
        const byteSize = bytes.length;
        const inserted = q.run(
          `INSERT INTO materials(
          tenant_id,name,type,tags,url,source_type,source_id,creator_id,note,
          body_snapshot,artifact_snapshot_json,snapshot_hash
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          tenantId,
          `内容流水线工位${employeeIdx}${kind === "image" ? "图片" : "素材"}${index + 1}`,
          "图片",
          JSON.stringify([
            "内容团队流水线",
            `employee:${employeeIdx}`,
            `pipeline:${runId}`,
          ]),
          null,
          "content_pipeline_provider",
          runId,
          userId,
          `provider=${cleanText(imageModel, 160)};attempt=${identity.attemptId};` +
            `ref=${identity.refType}#${identity.refId};仅形成租户内产物，未执行对外发布`,
          bodySnapshot || null,
          JSON.stringify({
            schemaVersion: "nanowork.content-pipeline-provider-artifact/2",
            kind,
            employeeIdx,
            pipelineId: runId,
            attemptId: identity.attemptId,
            attemptOrdinal: Number(attempt?.attemptOrdinal || 1),
            artifactIndex: index,
            billingRefType: identity.refType,
            billingRefId: identity.refId,
            model: cleanText(item.model || output?.model || imageModel, 160),
            mimeType,
            imageMode: request?.image_mode || null,
            platforms: Array.isArray(request?.platforms)
              ? request.platforms
              : [],
            platform: cleanText(item.platform || "", 120) || null,
            requestedSize: /^\d{3,5}x\d{3,5}$/u.test(String(item.size || ""))
              ? String(item.size)
              : null,
            displaySize:
              cleanText(item.displaySize || item.display_size || "", 120) ||
              null,
            style: cleanText(item.style || "", 120) || null,
            paihuoRealImage: employeeIdx === 6 && kind === "image",
            sourceMaterialId:
              kind === "material" ? Number(item.materialId) || null : null,
            sourceUrl:
              kind === "material"
                ? cleanText(item.sourceUrl || "", 1_500) || null
                : null,
            rights:
              kind === "material"
                ? {
                    confirmed: item.rights?.confirmed === true,
                    commercialUse: item.rights?.commercialUse === true,
                    license: cleanText(item.rights?.license || "", 200),
                    attribution:
                      cleanText(item.rights?.attribution || "", 300) || null,
                  }
                : null,
            credentialsIncluded: false,
            binaryInMetadata: false,
            byteSize,
            contentSha256,
          }),
          contentSha256,
        );
        artifactIds.push(`material:${Number(inserted.lastInsertRowid)}`);
      }
      const delivery = {
        persisted: true,
        artifactIds,
        targetType: "material",
        targetId: Number(artifactIds[0]?.split(":")[1] || 0) || null,
      };
      const changed = q.run(
        `UPDATE content_pipeline_special_provider_attempts
        SET hold_id=?,status='persisted',output_json=?,delivery_json=?,
          lease_token=NULL,lease_expires_at=NULL,
          updated_at=datetime('now','localtime')
        WHERE tenant_id=? AND attempt_id=? AND status='claimed' AND lease_token=?`,
        holdId,
        JSON.stringify(output),
        JSON.stringify(delivery),
        identity.tenantId,
        identity.attemptId,
        identity.leaseToken,
      );
      if (changed.changes !== 1) {
        throw new Error(
          "特殊provider产物已写入但attempt台账未同步，事务已回滚",
        );
      }
      db.exec("COMMIT");
      return delivery;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 保留原始错误 */
      }
      throw error;
    }
  };

  const finalize = (rawAttempt) => {
    const identity = normalizedSpecialAttempt(rawAttempt);
    const row = assertSpecialAttemptRow(specialAttemptRow(identity), identity);
    const billing = isRecord(rawAttempt.billing)
      ? clone(rawAttempt.billing)
      : {};
    if (row.status === "claimed") {
      assertedClaimLease(row, identity);
    } else if (row.status === "persisted") {
      const finalizedHoldId = Number(rawAttempt.hold?.holdId || 0) || null;
      if (!finalizedHoldId || finalizedHoldId !== Number(row.hold_id || 0)) {
        throw new ContentProductionPipelineRouteError(
          "特殊provider结算回写与已持久化预授权不一致",
          409,
          "CONTENT_PIPELINE_PROVIDER_FINALIZATION_CONFLICT",
        );
      }
    } else if (["settled", "released", "failed"].includes(row.status)) {
      return { status: row.status, alreadyFinalized: true };
    } else {
      throw new ContentProductionPipelineRouteError(
        "特殊provider attempt正在待对账，禁止执行进程恢复式自动结算或退款",
        409,
        "CONTENT_PIPELINE_PROVIDER_RECONCILIATION_REQUIRED",
      );
    }
    if (!row.output_json && billing.state === "not_held") {
      const hold = specialAttemptCurrentCycleHold(row);
      if (row.hold_id || hold) {
        return specialAttemptPendingReconciliation(
          row,
          hold,
          "not_held_report_conflicts_with_authoritative_hold",
        );
      }
      // claim发生在占分之前；只有权威台账也确认本轮从未建hold，才删除空claim。
      const removed = q.run(
        `DELETE FROM content_pipeline_special_provider_attempts
        WHERE tenant_id=? AND attempt_id=? AND status='claimed' AND lease_token=?`,
        identity.tenantId,
        identity.attemptId,
        identity.leaseToken,
      );
      if (removed.changes !== 1) {
        throw new ContentProductionPipelineRouteError(
          "特殊provider空claim回收失败，禁止无证据重跑",
          409,
          "CONTENT_PIPELINE_PROVIDER_EMPTY_CLAIM_RECOVERY_FAILED",
        );
      }
      return { status: "not_held", removedEmptyClaim: true };
    }
    const hasDelivery = row.output_json && row.delivery_json;
    const status = hasDelivery
      ? billing.state === "settled"
        ? "settled"
        : "pending_reconciliation"
      : billing.state === "released"
        ? "released"
        : billing.state === "not_held"
          ? "failed"
          : "pending_reconciliation";
    q.run(
      `UPDATE content_pipeline_special_provider_attempts
      SET hold_id=COALESCE(?,hold_id),status=?,billing_json=?,error_json=?,
        lease_token=NULL,lease_expires_at=NULL,
        updated_at=datetime('now','localtime')
      WHERE tenant_id=? AND attempt_id=?`,
      Number(rawAttempt.hold?.holdId || 0) || null,
      status,
      JSON.stringify(billing),
      rawAttempt.error ? JSON.stringify(rawAttempt.error) : null,
      identity.tenantId,
      identity.attemptId,
    );
    return { status };
  };

  return Object.freeze({
    resolve,
    claim,
    validateClaim,
    associateHold,
    persist,
    finalize,
  });
}

function defaultRuntime() {
  const repository = createSqliteContentProductionPipelineRepository({ db });
  repository.ensureSchema();
  const specialAttemptStore =
    createContentPipelineSpecialProviderAttemptStore();
  // 授权重验、handler选模和provider计价必须共享同一组解析器；否则路由签发的
  // 授权可能与工位5实际调用不一致。
  const resolveImageModelFn = () => routing().image;
  const estimateMaxCreditsFn = estimateMaxCredits;
  const handlerRegistry = createContentProductionHandlerRegistry({
    generateFn: generate,
    webSearchFn: webSearch,
    resolveImageModel: resolveImageModelFn,
    specialProviderBridgeFactory: (args) =>
      createContentSpecialProviderBridge(
        {
          ...args,
          attemptNamespace: "content-production-pipeline",
        },
        {
          resolveProviderAttemptFn: specialAttemptStore.resolve,
          claimProviderAttemptFn: specialAttemptStore.claim,
          validateProviderClaimFn: specialAttemptStore.validateClaim,
          associateProviderHoldFn: specialAttemptStore.associateHold,
          persistProviderOutputFn: specialAttemptStore.persist,
          finalizeProviderAttemptFn: specialAttemptStore.finalize,
          estimateMaxCreditsFn,
          materialSearchFn: searchLicensedMaterials,
        },
      ),
  });
  const pipeline = createContentProductionPipeline({
    repository,
    handlerRegistry,
    resolveImageModel: resolveImageModelFn,
    estimateMaxCredits: estimateMaxCreditsFn,
    classifyRecovery: classifyContentPipelineRecovery,
    releaseUndeliveredHolds:
      releaseContentPipelineUndeliveredHoldsInCurrentTransaction,
    executeStationDelivery: createStationDeliveryBoundary({ repository }),
  });
  return Object.freeze({
    repository,
    pipeline,
    capabilities: Object.freeze({
      licensedMaterialProvider: true,
      imageModes: Object.freeze(["real", "mix", "ai"]),
    }),
  });
}

let defaultRuntimeSingleton = null;

function getDefaultRuntime() {
  if (!defaultRuntimeSingleton) defaultRuntimeSingleton = defaultRuntime();
  return defaultRuntimeSingleton;
}

export function getDefaultContentProductionPipelineRuntime() {
  return getDefaultRuntime();
}

function artifactIdsForStation(station) {
  const attempts =
    station?.handlerEvidence?.productionRuntime?.specialRuntime?.bridge
      ?.attempts;
  if (!Array.isArray(attempts)) return [];
  return [
    ...new Set(
      attempts
        .flatMap((attempt) =>
          Array.isArray(attempt?.delivery?.artifactIds)
            ? attempt.delivery.artifactIds
            : [],
        )
        .map((item) => cleanText(item, 160))
        .filter(Boolean),
    ),
  ];
}

function materialIdsForStation(station) {
  return artifactIdsForStation(station)
    .map((value) => /^material:(\d+)$/u.exec(value))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

function providerAssetFilename(row, metadata) {
  const extension =
    {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif",
    }[metadata.mimeType] || "bin";
  const safeName = cleanText(row?.name || `provider-asset-${row?.id}`, 140)
    .replace(/[\r\n]/gu, "")
    .replace(/[^a-zA-Z0-9._-]/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `${/[a-z0-9]/iu.test(safeName) ? safeName : `provider-asset-${row?.id}`}.${extension}`;
}

function providerAssetRows({ tenantId, pipelineId, materialIds }) {
  const ids = [
    ...new Set(
      (materialIds || [])
        .map(Number)
        .filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  ];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return q.all(
    `SELECT id,name,type,source_type,source_id,
      artifact_snapshot_json,snapshot_hash,
      CASE WHEN COALESCE(body_snapshot,'')<>'' THEN 1 ELSE 0 END has_body_snapshot
    FROM materials
    WHERE tenant_id=? AND source_type='content_pipeline_provider' AND source_id=?
      AND id IN (${placeholders})`,
    tenantId,
    pipelineId,
    ...ids,
  );
}

function publicProviderAssets({
  state,
  station,
  sourceStation,
  projectedIntoPublishPackage = false,
}) {
  const pipelineId = Number(state?.id);
  const tenantId = Number(state?.tenantId);
  const sourceStationIdx = Number(sourceStation?.stationIdx);
  const stationIdx = Number(station?.stationIdx);
  const ids = materialIdsForStation(sourceStation);
  const idOrder = new Map(ids.map((id, index) => [id, index]));
  const availability = artifactAvailability(station);
  return providerAssetRows({ tenantId, pipelineId, materialIds: ids })
    .map((row) => {
      const metadata = jsonRecord(row.artifact_snapshot_json);
      const mimeType = cleanText(metadata.mimeType, 100).toLowerCase();
      if (
        Number(metadata.pipelineId) !== pipelineId ||
        Number(metadata.employeeIdx) !== sourceStationIdx ||
        !PIPELINE_PROVIDER_ASSET_MEDIA_TYPES.has(mimeType) ||
        !/^[a-f0-9]{64}$/u.test(String(row.snapshot_hash || ""))
      )
        return null;
      const id = Number(row.id);
      const base = `/api/content/pipelines/${pipelineId}/stations/${stationIdx}/provider-assets/${id}`;
      const immutableSnapshot = Number(row.has_body_snapshot) === 1;
      return {
        id,
        sourceStationIdx,
        kind: cleanText(metadata.kind || "image", 40),
        filename: providerAssetFilename(row, { mimeType }),
        mediaType: mimeType,
        byteSize:
          Number.isSafeInteger(Number(metadata.byteSize)) &&
          Number(metadata.byteSize) >= 0
            ? Number(metadata.byteSize)
            : null,
        sha256: String(row.snapshot_hash),
        immutableSnapshot,
        projectedIntoPublishPackage,
        providerModel: cleanText(metadata.model || "", 160) || null,
        platform: cleanText(metadata.platform || "", 120) || null,
        requestedSize: /^\d{3,5}x\d{3,5}$/u.test(
          String(metadata.requestedSize || ""),
        )
          ? String(metadata.requestedSize)
          : null,
        displaySize: cleanText(metadata.displaySize || "", 120) || null,
        style: cleanText(metadata.style || "", 120) || null,
        paihuoRealImage: metadata.paihuoRealImage === true,
        sourceMaterialId: Number(metadata.sourceMaterialId) || null,
        sourceUrl: cleanText(metadata.sourceUrl || "", 1_500) || null,
        rights: isRecord(metadata.rights) ? clone(metadata.rights) : null,
        ...(immutableSnapshot
          ? availability
          : { availability: "remote_reference", finalUsable: false }),
        previewUrl: `${base}/preview`,
        downloadUrl: `${base}/download`,
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        (idOrder.get(left.id) ?? 0) - (idOrder.get(right.id) ?? 0),
    );
}

function artifactAvailability(station) {
  if (station?.status === "billing_pending") {
    return { availability: "billing_pending", finalUsable: false };
  }
  if (station?.status === "awaiting_approval") {
    return { availability: "awaiting_approval", finalUsable: false };
  }
  if (station?.status === "awaiting_metrics") {
    return { availability: "awaiting_metrics", finalUsable: false };
  }
  if (station?.status === "completed") {
    return { availability: "final", finalUsable: true };
  }
  return {
    availability: cleanText(station?.status || "saved", 40),
    finalUsable: false,
  };
}

function publicStationArtifacts(station) {
  const availability = artifactAvailability(station);
  return (Array.isArray(station?.artifacts) ? station.artifacts : [])
    .filter(
      (artifact) =>
        Number.isSafeInteger(Number(artifact?.id)) && Number(artifact.id) > 0,
    )
    .map((artifact) => {
      const id = Number(artifact.id);
      const pipelineId = Number(station.pipelineId);
      const stationIdx = Number(station.stationIdx);
      const base = `/api/content/pipelines/${pipelineId}/stations/${stationIdx}/artifacts/${id}`;
      return {
        id,
        kind: cleanText(artifact.kind || "unknown", 80),
        primary: artifact.primary === true,
        filename: cleanText(artifact.filename || `artifact-${id}`, 180),
        mediaType: cleanText(
          artifact.mediaType || "application/octet-stream",
          100,
        ),
        byteSize: Math.max(0, Number(artifact.byteSize || 0)),
        sha256: /^[a-f0-9]{64}$/u.test(String(artifact.sha256 || ""))
          ? String(artifact.sha256)
          : null,
        ...availability,
        previewUrl: `${base}/preview`,
        downloadUrl: `${base}/download`,
      };
    });
}

function pipelinePredictiveRetroWait(state) {
  if (!contentPipelineUsesPredictiveRetro(state?.workflow)) return false;
  if (Number(state?.currentStation) !== 9) return false;
  if (
    !["awaiting_metrics", "awaiting_approval"].includes(
      String(state?.status || ""),
    )
  ) {
    return false;
  }
  const station9 = (state?.stations || []).find(
    (station) => Number(station?.stationIdx) === 9,
  );
  return (
    String(state?.status) === "awaiting_metrics" ||
    station9?.approvalBoundary?.code === "await_metrics"
  );
}

function publicPipeline(state) {
  const stations = Array.isArray(state?.stations) ? state.stations : [];
  const mediaStation =
    stations.find((station) => Number(station?.stationIdx) === 5) || null;
  const knowledgeSink = isRecord(state?.knowledgeSink)
    ? {
        ...clone(state.knowledgeSink),
        pipelineDeepLink: `/content?pipelineId=${Number(state.id)}`,
        assetDeepLink: state.knowledgeSink.assetId ? "/assets" : null,
      }
    : null;
  return {
    ...clone(state),
    knowledgeSink,
    stations: stations.map((station) => {
      const stationIdx = Number(station?.stationIdx);
      const sourceStation =
        stationIdx === 8 && mediaStation ? mediaStation : station;
      return {
        ...clone(station),
        employeeName:
          CONTENT_EMPLOYEES[station.stationIdx]?.name ||
          `内容工位${station.stationIdx}`,
        artifactIds: artifactIdsForStation(station),
        artifacts: publicStationArtifacts(station),
        providerAssets: publicProviderAssets({
          state,
          station,
          sourceStation,
          projectedIntoPublishPackage:
            stationIdx === 8 && sourceStation !== station,
        }),
      };
    }),
    boundary: "全流程只生成租户内产物与发布包，不会自动登录平台或对外发布。",
  };
}

function pipelinePendingStation(state) {
  const stationIdx = Number(state?.pendingStation);
  if (!Number.isInteger(stationIdx) || stationIdx < 0 || stationIdx > 9)
    return null;
  return (
    (state?.stations || []).find(
      (station) => Number(station?.stationIdx) === stationIdx,
    ) || null
  );
}

function pipelineApprovalBoundaryCode(state) {
  const code = cleanText(
    pipelinePendingStation(state)?.approvalBoundary?.code,
    32,
  );
  return Object.hasOwn(PIPELINE_APPROVAL_BOUNDARY_LABELS, code) ? code : "";
}

function pipelineReviewCapability(user, state) {
  const boundaryCode = pipelineApprovalBoundaryCode(state);
  if (!canAccessOwner(user, state?.createdBy)) {
    return {
      canReview: false,
      reason: "当前账号不在该创建人的数据管理范围内",
    };
  }
  if (!boundaryCode) {
    return {
      canReview: false,
      reason: "待审工位缺少已持久化的审批边界，已停止审批",
    };
  }
  const role = cleanText(user?.role, 64);
  const roles =
    boundaryCode === "force"
      ? PIPELINE_FINAL_REVIEW_ROLES
      : PIPELINE_REVIEW_ROLES;
  if (!roles.has(role)) {
    return {
      canReview: false,
      reason:
        boundaryCode === "force"
          ? "该工位必须由老板或管理员终审"
          : "当前账号没有内容流水线审批权限",
    };
  }
  return { canReview: true, reason: "" };
}

/**
 * 待审通知只发给真正能越过当前边界的人。
 * force 工位不向经理发送；普通工位只通知创建人本人（若有审批权）、
 * 其真实管理链和本租户老板/管理员，不扩散给同级管理者。
 */
export function contentPipelineReviewAudienceIds({
  users,
  creatorId,
  boundaryCode,
} = {}) {
  const activeUsers = (Array.isArray(users) ? users : []).filter(
    (user) =>
      user && user.status === "启用" && Number.isSafeInteger(Number(user.id)),
  );
  const byId = new Map(activeUsers.map((user) => [Number(user.id), user]));
  const selected = new Set();
  for (const user of activeUsers) {
    if (PIPELINE_NOTIFICATION_FINAL_ROLES.has(cleanText(user.role, 64))) {
      selected.add(Number(user.id));
    }
  }
  if (boundaryCode !== "force") {
    const creator = byId.get(Number(creatorId));
    if (creator && PIPELINE_REVIEW_ROLES.has(cleanText(creator.role, 64))) {
      selected.add(Number(creator.id));
    }
    const visited = new Set();
    let managerId = Number(creator?.manager_id);
    while (
      Number.isSafeInteger(managerId) &&
      managerId > 0 &&
      !visited.has(managerId)
    ) {
      visited.add(managerId);
      const manager = byId.get(managerId);
      if (!manager) break;
      if (PIPELINE_REVIEW_ROLES.has(cleanText(manager.role, 64)))
        selected.add(managerId);
      managerId = Number(manager.manager_id);
    }
  }
  return activeUsers
    .filter((user) => selected.has(Number(user.id)))
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((user) => Number(user.id));
}

function assertPipelineAccess(user, state) {
  if (
    !state ||
    Number(state.tenantId) !== Number(user?.tenant_id || curTenant())
  ) {
    throw new ContentProductionPipelineRouteError(
      "内容生产流水线不存在",
      404,
      "CONTENT_PIPELINE_NOT_FOUND",
    );
  }
  if (!canAccessOwner(user, state.createdBy)) {
    throw new ContentProductionPipelineRouteError(
      "当前账号无权查看或操作该内容流水线",
      403,
      "CONTENT_PIPELINE_ACCESS_FORBIDDEN",
    );
  }
  return state;
}

function workflowInput(body, user) {
  if (body?.workflow !== undefined && !isRecord(body.workflow)) {
    throw new ContentProductionPipelineRouteError("workflow必须是对象");
  }
  const suppliedApprovalPolicy = body?.workflow?.approvalPolicy;
  const suppliedApprovalMode = cleanText(suppliedApprovalPolicy?.mode, 40);
  if (
    suppliedApprovalPolicy !== undefined &&
    suppliedApprovalMode !== "internal_auto" &&
    !hasFullDataAccess(user)
  ) {
    throw new ContentProductionPipelineRouteError(
      "只有老板或管理员可以自定义流水线审批点",
      403,
      "CONTENT_PIPELINE_APPROVAL_POLICY_ROLE_FORBIDDEN",
    );
  }
  if (
    suppliedApprovalPolicy !== undefined &&
    !isRecord(suppliedApprovalPolicy)
  ) {
    throw new ContentProductionPipelineRouteError(
      "workflow.approvalPolicy必须是对象",
    );
  }
  if (
    suppliedApprovalMode === "internal_auto" &&
    (suppliedApprovalPolicy.reviewStations !== undefined ||
      suppliedApprovalPolicy.externalPublishAllowed === true ||
      suppliedApprovalPolicy.automaticBusinessAdoptionAllowed === true)
  ) {
    throw new ContentProductionPipelineRouteError(
      "internal_auto只允许内部连续生成报告，不能夹带审批点、外发或业务采纳授权",
      400,
      "CONTENT_PIPELINE_INTERNAL_AUTO_SCOPE_INVALID",
    );
  }
  if (body?.workflow?.paidMediaAuthorization !== undefined) {
    throw new ContentProductionPipelineRouteError(
      "付费媒体授权只能由服务端签发，客户端不能直接提交授权对象",
      400,
      "CONTENT_PIPELINE_MEDIA_AUTHORIZATION_FORGED",
    );
  }
  if (
    body?.workflow?.paidMediaAuthorized !== undefined &&
    typeof body.workflow.paidMediaAuthorized !== "boolean"
  ) {
    throw new ContentProductionPipelineRouteError(
      "workflow.paidMediaAuthorized必须是布尔值",
    );
  }
  if (
    body?.workflow?.paidMediaAuthorized === true &&
    !PIPELINE_FINAL_REVIEW_ROLES.has(cleanText(user?.role, 64))
  ) {
    throw new ContentProductionPipelineRouteError(
      "只有老板、管理员或平台超管可以授权付费媒体provider",
      403,
      "CONTENT_PAID_MEDIA_AUTHORITY_REQUIRED",
    );
  }
  const approvalPolicy =
    suppliedApprovalPolicy === undefined
      ? undefined
      : {
          ...(suppliedApprovalMode === "internal_auto"
            ? { mode: "internal_auto" }
            : clone(suppliedApprovalPolicy)),
          configuredBy: {
            id: Number(user?.id),
            role: cleanText(user?.role, 64),
          },
        };
  const safeWorkflow = clone(body?.workflow || {});
  delete safeWorkflow.paidMediaAuthorized;
  return {
    ...safeWorkflow,
    mode: cleanText(body?.workflow?.mode || body?.mode || "copilot", 40),
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
  };
}

function sendError(res, error) {
  const status = Number(error?.status);
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    error: sanitizeContentRuntimeErrorMessage(error, "内容生产流水线操作失败"),
    code: cleanText(error?.code || "CONTENT_PIPELINE_REQUEST_FAILED", 160),
    ...(error?.billing ? { billing: clone(error.billing) } : {}),
  });
}

export function createContentProductionPipelineRouter(dependencies = {}) {
  const router = Router();
  const getRuntime = dependencies.getRuntime || getDefaultRuntime;
  const profileStore =
    dependencies.profileStore ||
    createContentTenantProfileStore({
      getTenantConfigFn: getTenantConfig,
      setTenantConfigFn: setTenantConfig,
    });
  const resolveStructuredBriefFn =
    dependencies.resolveStructuredBriefFn || resolveContentStructuredBrief;
  const providerAvailableFn =
    dependencies.providerAvailableFn || yunwuAvailable;
  const materialProviderAvailableFn =
    dependencies.materialProviderAvailableFn ||
    (() => getRuntime()?.capabilities?.licensedMaterialProvider === true);
  const precheckByRoleFn = dependencies.precheckByRoleFn || precheckByRole;
  const estimateMaxCreditsFn =
    dependencies.estimateMaxCreditsFn || estimateMaxCredits;
  const resolveImageModelFn =
    dependencies.resolveImageModelFn || (() => routing().image);
  const nowFn = dependencies.nowFn || (() => new Date());
  const scheduleFn = dependencies.scheduleFn || ((task) => setImmediate(task));
  const runWithTenantFn = dependencies.runWithTenantFn || runWithTenant;
  const logOpFn = dependencies.logOpFn || logOp;
  const notifyFn = dependencies.notifyFn || notify;
  const listTenantUsersFn =
    dependencies.listTenantUsersFn ||
    ((tenantId) =>
      q.all(
        `SELECT id,name,role,manager_id,status FROM users
      WHERE tenant_id=? ORDER BY id`,
        tenantId,
      ));

  if (
    typeof getRuntime !== "function" ||
    typeof resolveStructuredBriefFn !== "function" ||
    typeof providerAvailableFn !== "function" ||
    typeof materialProviderAvailableFn !== "function" ||
    typeof precheckByRoleFn !== "function" ||
    typeof estimateMaxCreditsFn !== "function" ||
    typeof resolveImageModelFn !== "function" ||
    typeof nowFn !== "function" ||
    typeof scheduleFn !== "function" ||
    typeof runWithTenantFn !== "function"
  ) {
    throw new TypeError("内容流水线路由依赖不完整");
  }

  const runtime = () => {
    const value = getRuntime();
    if (!value?.pipeline) throw new TypeError("内容流水线运行时未初始化");
    return value;
  };

  const stopMutationWhenBillingUnsettled = ({ state, action }) => {
    const tenantId = Number(state?.tenantId);
    const pipelineId = Number(state?.id);
    const stationIdx = Number(state?.currentStation);
    if (!Number.isInteger(stationIdx) || stationIdx < 0 || stationIdx > 9)
      return;
    const billingEvidence = contentPipelineUnsettledStationBilling({
      tenantId,
      pipelineId,
      stationIdx,
    });
    if (!billingEvidence) return;
    const station = (state?.stations || []).find(
      (item) => Number(item?.stationIdx) === stationIdx,
    );
    const failure = {
      code: "CONTENT_PIPELINE_UNSETTLED_HOLD_BLOCKS_RERUN",
      name: "ContentPipelineUnsettledHoldBlocksRerun",
      message: `工位${stationIdx}仍有未释放预授权或待对账provider attempt，已禁止${action}与重跑API`,
      stationIdx,
      employeeKey: station?.employeeKey || null,
      handlerId: station?.handlerId || null,
      deliveryStage: "billing_reconciliation",
      failedAt: new Date().toISOString(),
    };
    if (
      state.status !== "billing_pending" &&
      typeof runtime().repository?.markPreDeliveryBillingPending ===
        "function" &&
      station?.output == null &&
      ["running", "failed", "pending"].includes(String(station?.status || ""))
    ) {
      runtime().repository.markPreDeliveryBillingPending({
        tenantId,
        pipelineId,
        stationIdx,
        expectedAttempt: Number(station?.attempt),
        billingEvidence,
        failure,
        handlerEvidence: station?.handlerEvidence || null,
        contextSnapshot: station?.contextSnapshot || null,
      });
    }
    throw new ContentProductionPipelineRouteError(
      failure.message,
      409,
      "CONTENT_PIPELINE_BILLING_PENDING_RECONCILIATION",
    );
  };

  const inspectFor = (req, pipelineId) => {
    const state = runtime().pipeline.inspect({
      tenantId: Number(req.user.tenant_id || curTenant()),
      pipelineId,
    });
    return assertPipelineAccess(req.user, state);
  };

  const pendingReviewProjection = ({ user, state, users }) => {
    const station = pipelinePendingStation(state);
    const boundaryCode = pipelineApprovalBoundaryCode(state);
    const creator = users.find(
      (item) => Number(item.id) === Number(state.createdBy),
    );
    const capability = pipelineReviewCapability(user, state);
    return {
      pipelineId: Number(state.id),
      pipelineTitle: cleanText(state.title || `内容流水线#${state.id}`, 240),
      stationIdx: station
        ? Number(station.stationIdx)
        : Number(state.pendingStation),
      stationName:
        station?.employeeName ||
        CONTENT_EMPLOYEES[Number(state.pendingStation)]?.name ||
        `内容工位${state.pendingStation}`,
      creator: {
        id: Number(state.createdBy),
        name: cleanText(creator?.name || `用户#${state.createdBy}`, 120),
        role: cleanText(creator?.role, 64) || null,
      },
      approvalBoundary: {
        code: boundaryCode || null,
        label:
          PIPELINE_APPROVAL_BOUNDARY_LABELS[boundaryCode] || "边界证据异常",
      },
      canReview: capability.canReview,
      reviewBlockedReason: capability.reason || null,
      createdAt: state.createdAt || null,
      updatedAt: state.updatedAt || null,
    };
  };

  const notifyPendingReviewAudience = ({ tenantId, state }) => {
    const boundaryCode = pipelineApprovalBoundaryCode(state);
    if (!boundaryCode) return;
    const users = listTenantUsersFn(tenantId);
    const creator = users.find(
      (item) => Number(item.id) === Number(state.createdBy),
    );
    const station = pipelinePendingStation(state);
    const stationIdx = Number(state.pendingStation);
    const stationName =
      station?.employeeName ||
      CONTENT_EMPLOYEES[stationIdx]?.name ||
      `内容工位${stationIdx}`;
    const boundaryLabel = PIPELINE_APPROVAL_BOUNDARY_LABELS[boundaryCode];
    const audienceIds = contentPipelineReviewAudienceIds({
      users,
      creatorId: state.createdBy,
      boundaryCode,
    });
    for (const userId of audienceIds) {
      notifyFn(
        userId,
        "content",
        boundaryCode === "force"
          ? `内容流水线#${state.id}待终审`
          : `内容流水线#${state.id}待审阅`,
        `${cleanText(state.title, 120)} · 工位${stationIdx}·${stationName} · ${boundaryLabel} · 创建人：${cleanText(creator?.name || `用户#${state.createdBy}`, 80)}`,
        `/content?pipelineId=${state.id}`,
      );
    }
  };

  const artifactFor = (req, pipelineId, stationIdx, artifactId) => {
    const state = inspectFor(req, pipelineId);
    const station = (state.stations || []).find(
      (item) => Number(item.stationIdx) === Number(stationIdx),
    );
    if (!station || typeof runtime().repository?.getArtifact !== "function") {
      throw new ContentProductionPipelineRouteError(
        "流水线工位产物不存在",
        404,
        "CONTENT_PIPELINE_ARTIFACT_NOT_FOUND",
      );
    }
    const artifact = runtime().repository.getArtifact(
      Number(req.user.tenant_id || curTenant()),
      pipelineId,
      stationIdx,
      artifactId,
    );
    if (!artifact || typeof artifact.content !== "string") {
      throw new ContentProductionPipelineRouteError(
        "流水线工位产物不存在",
        404,
        "CONTENT_PIPELINE_ARTIFACT_NOT_FOUND",
      );
    }
    const expectedMediaType = PIPELINE_ARTIFACT_MEDIA_TYPES[artifact.kind];
    const actualSha256 = createHash("sha256")
      .update(artifact.content, "utf8")
      .digest("hex");
    if (!expectedMediaType || actualSha256 !== artifact.sha256) {
      throw new ContentProductionPipelineRouteError(
        "流水线工位产物完整性校验失败，已禁止预览和下载",
        409,
        "CONTENT_PIPELINE_ARTIFACT_INTEGRITY_FAILED",
      );
    }
    const filename =
      cleanText(artifact.filename, 180)
        .replace(/[\r\n]/gu, "")
        .replace(/[^a-zA-Z0-9._-]/gu, "-") ||
      `pipeline-${pipelineId}-artifact-${artifactId}`;
    return { state, station, artifact, filename, expectedMediaType };
  };

  const providerAssetFor = (req, pipelineId, stationIdx, materialId) => {
    const state = inspectFor(req, pipelineId);
    const station = (state.stations || []).find(
      (item) => Number(item.stationIdx) === Number(stationIdx),
    );
    if (!station) {
      throw new ContentProductionPipelineRouteError(
        "流水线provider素材不存在",
        404,
        "CONTENT_PIPELINE_PROVIDER_ASSET_NOT_FOUND",
      );
    }
    let sourceStation = materialIdsForStation(station).includes(materialId)
      ? station
      : null;
    if (!sourceStation && Number(stationIdx) === 8) {
      const mediaStation = (state.stations || []).find(
        (item) => Number(item.stationIdx) === 5,
      );
      if (
        mediaStation &&
        materialIdsForStation(mediaStation).includes(materialId)
      ) {
        sourceStation = mediaStation;
      }
    }
    if (!sourceStation) {
      throw new ContentProductionPipelineRouteError(
        "流水线工位证据未引用该provider素材",
        404,
        "CONTENT_PIPELINE_PROVIDER_ASSET_NOT_FOUND",
      );
    }
    const tenantId = Number(req.user.tenant_id || curTenant());
    const material = q.get(
      `SELECT id,tenant_id,name,type,url,source_type,source_id,
        body_snapshot,artifact_snapshot_json,snapshot_hash
      FROM materials
      WHERE tenant_id=? AND id=? AND source_type='content_pipeline_provider' AND source_id=?`,
      tenantId,
      materialId,
      pipelineId,
    );
    if (!material) {
      throw new ContentProductionPipelineRouteError(
        "流水线provider素材不存在",
        404,
        "CONTENT_PIPELINE_PROVIDER_ASSET_NOT_FOUND",
      );
    }
    const metadata = jsonRecord(material.artifact_snapshot_json);
    const sourceStationIdx = Number(sourceStation.stationIdx);
    const mimeType = cleanText(metadata.mimeType, 100).toLowerCase();
    if (
      Number(metadata.pipelineId) !== pipelineId ||
      Number(metadata.employeeIdx) !== sourceStationIdx ||
      !PIPELINE_PROVIDER_ASSET_MEDIA_TYPES.has(mimeType)
    ) {
      throw new ContentProductionPipelineRouteError(
        "流水线provider素材归属或MIME证据不一致，已禁止读取",
        409,
        "CONTENT_PIPELINE_PROVIDER_ASSET_INTEGRITY_FAILED",
      );
    }
    const bodySnapshot = String(material.body_snapshot || "");
    let captured = null;
    if (bodySnapshot) {
      captured = decodeProviderDataImage(bodySnapshot, mimeType);
      const actualSha256 = createHash("sha256")
        .update(captured.bytes)
        .digest("hex");
      if (
        actualSha256 !== material.snapshot_hash ||
        (metadata.contentSha256 && metadata.contentSha256 !== actualSha256) ||
        (metadata.byteSize !== undefined &&
          Number(metadata.byteSize) !== captured.bytes.length)
      ) {
        throw new ContentProductionPipelineRouteError(
          "流水线provider图片字节完整性校验失败，已禁止预览和下载",
          409,
          "CONTENT_PIPELINE_PROVIDER_ASSET_INTEGRITY_FAILED",
        );
      }
    } else {
      const remoteUrl = String(material.url || "");
      const actualSha256 = createHash("sha256")
        .update(remoteUrl, "utf8")
        .digest("hex");
      if (!remoteUrl || actualSha256 !== material.snapshot_hash) {
        throw new ContentProductionPipelineRouteError(
          "流水线provider临时URL完整性校验失败，已禁止读取",
          409,
          "CONTENT_PIPELINE_PROVIDER_ASSET_INTEGRITY_FAILED",
        );
      }
      // 仅兼容历史URL-only记录；新产物必须在落库前固化为body_snapshot。
      // 这里不做代理请求，避免服务端SSRF；只允许无凭据的公网HTTP(S)跳转。
      const parsed = parseProviderAssetRemoteUrl(remoteUrl);
      captured = { remoteUrl: parsed.toString(), mimeType };
    }
    return {
      state,
      station,
      sourceStation,
      material,
      metadata,
      captured,
      mimeType,
      filename: providerAssetFilename(material, { mimeType }),
    };
  };

  const providerAssetResponseHeaders = ({ found, disposition }) => {
    const availability = found.captured.bytes
      ? artifactAvailability(found.station)
      : { availability: "remote_reference", finalUsable: false };
    return {
      "Cache-Control": "private, no-store",
      "Content-Type": found.mimeType,
      "Content-Disposition": `${disposition}; filename="${found.filename}"`,
      "Content-Security-Policy":
        "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Download-Options": "noopen",
      "X-Provider-Asset-Availability": availability.availability,
      "X-Provider-Asset-Final-Usable": String(availability.finalUsable),
      "X-Provider-Asset-Source-Station": String(found.sourceStation.stationIdx),
    };
  };

  const artifactResponseHeaders = ({
    filename,
    station,
    disposition,
    mediaType,
  }) => ({
    "Cache-Control": "private, no-store",
    "Content-Type": `${mediaType}; charset=utf-8`,
    "Content-Disposition": `${disposition}; filename="${filename}"`,
    "Content-Security-Policy":
      "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Download-Options": "noopen",
    "X-Artifact-Availability": artifactAvailability(station).availability,
    "X-Artifact-Final-Usable": String(
      artifactAvailability(station).finalUsable,
    ),
  });

  const requireBackgroundAiGuard = (req) => {
    if (typeof req.aiGuard?.defer !== "function") {
      throw new ContentProductionPipelineRouteError(
        "AI并发保护未生效，已在任务状态变更前停止操作",
        503,
        "CONTENT_PIPELINE_AI_GUARD_REQUIRED",
      );
    }
    return req.aiGuard;
  };

  const queueResume = ({ req, pipelineId, action = "resume" }) => {
    const tenantId = Number(req.user.tenant_id || curTenant());
    const actor = clone(req.user);
    const releaseLease = requireBackgroundAiGuard(req).defer(PIPELINE_LEASE_MS);
    if (typeof releaseLease !== "function") {
      throw new ContentProductionPipelineRouteError(
        "AI并发保护未返回有效租约，已停止排队",
        503,
        "CONTENT_PIPELINE_AI_GUARD_LEASE_INVALID",
      );
    }
    try {
      scheduleFn(async () => {
        try {
          const result = await runWithTenantFn(tenantId, () =>
            action === "retry"
              ? runtime().pipeline.retry({ tenantId, pipelineId })
              : runtime().pipeline.resume({ tenantId, pipelineId }),
          );
          const stationLabel =
            result.status === "awaiting_approval"
              ? `已停在工位${result.pendingStation}待审阅`
              : result.status === "awaiting_metrics"
                ? "已形成发布包，等待回传真实发布记录与指标后生成复盘"
                : result.status === "completed"
                  ? "已完成0→9全部工位"
                  : result.status === "billing_pending"
                    ? "产物已保存，已停站待账务对账"
                    : `当前状态：${result.status}`;
          try {
            runWithTenantFn(tenantId, () => {
              if (result.status === "awaiting_approval") {
                notifyPendingReviewAudience({ tenantId, state: result });
              } else {
                notifyFn(
                  actor.id,
                  "content",
                  `内容流水线#${pipelineId}状态更新`,
                  stationLabel,
                  `/content?pipelineId=${pipelineId}`,
                );
              }
            });
          } catch {
            /* 通知失败不改变业务产物 */
          }
        } catch (error) {
          console.error(
            `[content-pipeline] ${action} pipeline#${pipelineId} failed:`,
            sanitizeContentRuntimeErrorMessage(error),
          );
        } finally {
          releaseLease();
        }
      });
    } catch (error) {
      releaseLease();
      throw error;
    }
  };

  router.post("/pipelines", (req, res) => {
    try {
      if (!isRecord(req.body) || !isRecord(req.body.brief)) {
        throw new ContentProductionPipelineRouteError(
          "brief字段必填且必须是Paihuo Brief对象",
        );
      }
      if (!providerAvailableFn()) {
        throw new ContentProductionPipelineRouteError(
          "当前未连通云雾真实API，已在建任务和占用积分前停止",
          503,
          "CONTENT_PIPELINE_YUNWU_REQUIRED",
        );
      }
      requireBackgroundAiGuard(req);
      const tenantId = Number(req.user.tenant_id || curTenant());
      precheckByRoleFn(req.user.id, "text", req.user.role);
      const storedProfile = profileStore.load(tenantId);
      const structuredBrief = resolveStructuredBriefFn({
        tenantId,
        persistentProfile: storedProfile?.profile || {},
        explicitInput: req.body.brief,
      });
      const imageMode = cleanText(
        structuredBrief?.paihuoBrief?.image_mode ||
          structuredBrief?.paihuoBrief?.imageMode ||
          "ai",
        20,
      );
      if (
        ["real", "mix"].includes(imageMode) &&
        materialProviderAvailableFn({ tenantId, user: clone(req.user) }) !==
          true
      ) {
        throw new ContentProductionPipelineRouteError(
          "真实素材/混合配图尚未配置可核验授权来源，当前只能使用AI配图；任务尚未创建，也未占用积分。",
          503,
          "CONTENT_PIPELINE_LICENSED_MATERIAL_PROVIDER_UNAVAILABLE",
        );
      }
      const workflow = workflowInput(req.body, req.user);
      if (req.body?.workflow?.paidMediaAuthorized === true) {
        const imageModel = cleanText(resolveImageModelFn(), 160);
        if (!imageModel) {
          throw new ContentProductionPipelineRouteError(
            "当前图片模型未配置，不能签发付费媒体授权",
            503,
            "CONTENT_PIPELINE_IMAGE_MODEL_UNAVAILABLE",
          );
        }
        workflow.paidMediaAuthorization = createContentPaidMediaAuthorization({
          task: structuredBrief.paihuoBrief,
          actor: clone(req.user),
          imageModel,
          estimatedUnitCredits: estimateMaxCreditsFn("image", imageModel),
          now: nowFn,
        });
      }
      const state = runtime().pipeline.create({
        tenantId,
        createdBy: req.user.id,
        title: structuredBrief.paihuoBrief.direction,
        task: clone(structuredBrief.paihuoBrief),
        persona: clone(structuredBrief.handlerContext.profile.persona),
        settings: {
          companyProfile: clone(structuredBrief.handlerContext.companyProfile),
          structuredBriefEvidence: clone(structuredBrief.evidence),
          contentProfileRevision: Number(storedProfile?.revision || 0),
        },
        workflow,
      });
      queueResume({ req, pipelineId: state.id });
      logOpFn(
        req.user,
        "内容生产仓",
        "启动完整团队流水线",
        `pipeline#${state.id}:${state.title}；真实云API、逐岗产物落库；${
          workflow?.approvalPolicy?.mode === "internal_auto"
            ? "内部自动接力、未设置停审工位"
            : "按服务端锁定停站规则执行"
        }；未执行外发`,
      );
      res.set("Cache-Control", "private, no-store");
      res.set("Retry-After", "2");
      return res.status(202).json({
        pipeline: publicPipeline(state),
        queued: true,
        pollAfterMs: 2_000,
        pollUrl: `/content/pipelines/${state.id}`,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/pipelines", (req, res) => {
    try {
      const tenantId = Number(req.user.tenant_id || curTenant());
      const creatorFilter = hasFullDataAccess(req.user)
        ? null
        : isManagerRole(req.user)
          ? null
          : req.user.id;
      const listed = runtime().pipeline.list({
        tenantId,
        createdBy: creatorFilter,
        limit: PIPELINE_LIST_LIMIT,
      });
      const pipelines = listed.jobs
        .filter((job) => canAccessOwner(req.user, job.createdBy))
        .map((job) =>
          publicPipeline(
            runtime().pipeline.inspect({ tenantId, pipelineId: job.id }),
          ),
        );
      res.set("Cache-Control", "private, no-store");
      return res.json({
        schemaVersion: listed.schemaVersion,
        mode: listed.mode,
        pipelines,
        total: pipelines.length,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/pipelines/pending-reviews", (req, res) => {
    try {
      const tenantId = Number(req.user.tenant_id || curTenant());
      if (!isManagerRole(req.user)) {
        res.set("Cache-Control", "private, no-store");
        return res.json({
          schemaVersion: "nanowork.content-pipeline-pending-reviews/1",
          reviews: [],
          total: 0,
        });
      }
      const listed = runtime().pipeline.list({
        tenantId,
        createdBy: null,
        limit: PIPELINE_PENDING_REVIEW_LIMIT,
      });
      const users = listTenantUsersFn(tenantId);
      const reviews = listed.jobs
        .filter((job) => job?.status === "awaiting_approval")
        .filter((job) => canAccessOwner(req.user, job.createdBy))
        .map((job) =>
          runtime().pipeline.inspect({ tenantId, pipelineId: job.id }),
        )
        .filter((state) => state?.status === "awaiting_approval")
        .map((state) =>
          pendingReviewProjection({ user: req.user, state, users }),
        );
      res.set("Cache-Control", "private, no-store");
      return res.json({
        schemaVersion: "nanowork.content-pipeline-pending-reviews/1",
        reviews,
        total: reviews.length,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/pipelines/paid-media-estimate", (req, res) => {
    try {
      if (!PIPELINE_FINAL_REVIEW_ROLES.has(cleanText(req.user?.role, 64))) {
        throw new ContentProductionPipelineRouteError(
          "只有老板、管理员或平台超管可以查看付费媒体授权上限",
          403,
          "CONTENT_PAID_MEDIA_AUTHORITY_REQUIRED",
        );
      }
      const rawCount = req.query?.imageCount;
      const imageCount =
        rawCount === undefined || rawCount === "" || rawCount === "auto"
          ? null
          : Number(rawCount);
      const maximumImageCount = contentPaidMediaMaximumImageCount({
        image_mode: "ai",
        image_count: imageCount,
      });
      const imageModel = cleanText(resolveImageModelFn(), 160);
      if (!imageModel) {
        throw new ContentProductionPipelineRouteError(
          "当前图片模型未配置，不能计算付费媒体授权上限",
          503,
          "CONTENT_PIPELINE_IMAGE_MODEL_UNAVAILABLE",
        );
      }
      const estimatedUnitCredits = estimateMaxCreditsFn("image", imageModel);
      const pricing = contentPaidMediaPricingSnapshot({
        imageModel,
        estimatedUnitCredits,
        pricingVersion: CONTENT_PAID_MEDIA_PRICING_VERSION,
      });
      res.set("Cache-Control", "private, no-store");
      return res.json({
        estimate: {
          imageModel: pricing.imageModel,
          pricingVersion: pricing.pricingVersion,
          pricingFingerprint: pricing.pricingFingerprint,
          maximumImageCount,
          estimatedUnitCredits: pricing.estimatedUnitCredits,
          estimatedMaximumCredits: estimatedUnitCredits * maximumImageCount,
          authorizationValidHours: 24,
          externalPublishAllowed: false,
        },
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/pipelines/:id", (req, res) => {
    try {
      const state = inspectFor(
        req,
        positiveInteger(req.params.id, "pipelineId"),
      );
      res.set("Cache-Control", "private, no-store");
      return res.json({ pipeline: publicPipeline(state) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get(
    "/pipelines/:id/stations/:stationIdx/artifacts/:artifactId/preview",
    (req, res) => {
      try {
        const pipelineId = positiveInteger(req.params.id, "pipelineId");
        const artifactId = positiveInteger(req.params.artifactId, "artifactId");
        const stationIdx = Number(req.params.stationIdx);
        if (!Number.isInteger(stationIdx) || stationIdx < 0 || stationIdx > 9) {
          throw new ContentProductionPipelineRouteError(
            "stationIdx必须是0..9之间的整数",
          );
        }
        const found = artifactFor(req, pipelineId, stationIdx, artifactId);
        // HTML/SVG预览也强制按纯文本返回。UI只打开这个隔离端点，不把模型HTML
        // 注入当前React页面，因此产物中的脚本、表单和外链都不会执行。
        res.set(
          artifactResponseHeaders({
            filename: found.filename,
            station: found.station,
            disposition: "inline",
            mediaType: "text/plain",
          }),
        );
        res.set("X-Original-Content-Type", found.expectedMediaType);
        return res.send(found.artifact.content);
      } catch (error) {
        return sendError(res, error);
      }
    },
  );

  router.get(
    "/pipelines/:id/stations/:stationIdx/artifacts/:artifactId/download",
    (req, res) => {
      try {
        const pipelineId = positiveInteger(req.params.id, "pipelineId");
        const artifactId = positiveInteger(req.params.artifactId, "artifactId");
        const stationIdx = Number(req.params.stationIdx);
        if (!Number.isInteger(stationIdx) || stationIdx < 0 || stationIdx > 9) {
          throw new ContentProductionPipelineRouteError(
            "stationIdx必须是0..9之间的整数",
          );
        }
        const found = artifactFor(req, pipelineId, stationIdx, artifactId);
        res.set(
          artifactResponseHeaders({
            filename: found.filename,
            station: found.station,
            disposition: "attachment",
            mediaType: found.expectedMediaType,
          }),
        );
        return res.send(found.artifact.content);
      } catch (error) {
        return sendError(res, error);
      }
    },
  );

  const sendProviderAsset = (req, res, disposition) => {
    try {
      const pipelineId = positiveInteger(req.params.id, "pipelineId");
      const materialId = positiveInteger(req.params.materialId, "materialId");
      const stationIdx = Number(req.params.stationIdx);
      if (!Number.isInteger(stationIdx) || stationIdx < 0 || stationIdx > 9) {
        throw new ContentProductionPipelineRouteError(
          "stationIdx必须是0..9之间的整数",
        );
      }
      const found = providerAssetFor(req, pipelineId, stationIdx, materialId);
      res.set(providerAssetResponseHeaders({ found, disposition }));
      if (found.captured.bytes) return res.send(found.captured.bytes);
      res.removeHeader("Content-Disposition");
      res.removeHeader("Content-Type");
      return res.redirect(302, found.captured.remoteUrl);
    } catch (error) {
      return sendError(res, error);
    }
  };

  router.get(
    "/pipelines/:id/stations/:stationIdx/provider-assets/:materialId/preview",
    (req, res) => sendProviderAsset(req, res, "inline"),
  );

  router.get(
    "/pipelines/:id/stations/:stationIdx/provider-assets/:materialId/download",
    (req, res) => sendProviderAsset(req, res, "attachment"),
  );

  router.post("/pipelines/:id/review", async (req, res) => {
    try {
      const pipelineId = positiveInteger(req.params.id, "pipelineId");
      const current = inspectFor(req, pipelineId);
      if (current.status === "awaiting_metrics") {
        throw new ContentProductionPipelineRouteError(
          "复盘官正在等待真实发布记录与数值指标，请使用“回传发布数据”，不能用审批绕过",
          422,
          "CONTENT_PIPELINE_METRICS_REQUIRED",
        );
      }
      if (!isManagerRole(req.user)) {
        throw new ContentProductionPipelineRouteError(
          "当前账号没有内容工位审阅权限",
          403,
          "CONTENT_PIPELINE_REVIEW_ROLE_FORBIDDEN",
        );
      }
      const tenantId = Number(req.user.tenant_id || curTenant());
      const action = req.body?.action;
      if (!["approve", "reject"].includes(action)) {
        throw new ContentProductionPipelineRouteError(
          "action必须是approve或reject",
        );
      }
      requireBackgroundAiGuard(req);
      const reviewedStation = current.pendingStation;
      const state = await runtime().pipeline.review({
        tenantId,
        pipelineId,
        actor: clone(req.user),
        action,
        selection: req.body?.selection ?? null,
        resumeAfterApproval: false,
      });
      if (action === "approve" && state.status === "running") {
        queueResume({ req, pipelineId });
      }
      logOpFn(
        req.user,
        "内容生产仓",
        action === "reject" ? "驳回流水线工位" : "审阅流水线工位",
        `pipeline#${pipelineId};station#${reviewedStation};action=${action}`,
      );
      return res
        .status(action === "approve" && state.status === "running" ? 202 : 200)
        .json({
          pipeline: publicPipeline(state),
          queued: action === "approve" && state.status === "running",
        });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/pipelines/:id/paid-media-authorization", (req, res) => {
    try {
      const pipelineId = positiveInteger(req.params.id, "pipelineId");
      const current = inspectFor(req, pipelineId);
      if (!PIPELINE_FINAL_REVIEW_ROLES.has(cleanText(req.user?.role, 64))) {
        throw new ContentProductionPipelineRouteError(
          "只有老板、管理员或平台超管可以授权付费媒体provider",
          403,
          "CONTENT_PAID_MEDIA_AUTHORITY_REQUIRED",
        );
      }
      if (req.body?.authorized !== true) {
        throw new ContentProductionPipelineRouteError(
          "必须明确提交authorized=true确认本任务的付费媒体积分上限",
          400,
          "CONTENT_PAID_MEDIA_AUTHORIZATION_CONFIRMATION_REQUIRED",
        );
      }
      const imageModel = cleanText(resolveImageModelFn(), 160);
      if (!imageModel) {
        throw new ContentProductionPipelineRouteError(
          "当前图片模型未配置，不能签发付费媒体授权",
          503,
          "CONTENT_PIPELINE_IMAGE_MODEL_UNAVAILABLE",
        );
      }
      const shouldResume = current.status === "awaiting_media_authorization";
      if (shouldResume) requireBackgroundAiGuard(req);
      const tenantId = Number(req.user.tenant_id || curTenant());
      const policy = createContentPaidMediaAuthorization({
        task: current.task,
        actor: clone(req.user),
        imageModel,
        estimatedUnitCredits: estimateMaxCreditsFn("image", imageModel),
        now: nowFn,
      });
      const state = runtime().pipeline.authorizePaidMedia({
        tenantId,
        pipelineId,
        actor: clone(req.user),
        policy,
      });
      if (shouldResume) queueResume({ req, pipelineId });
      logOpFn(
        req.user,
        "内容生产仓",
        "授权付费媒体provider",
        `pipeline#${pipelineId};maxImages=${policy.maximumImageCount};maxCredits=${policy.estimatedMaximumCredits};externalPublish=false`,
      );
      res.set("Cache-Control", "private, no-store");
      return res.status(shouldResume ? 202 : 200).json({
        pipeline: publicPipeline(state),
        queued: shouldResume,
        authorization: {
          maximumImageCount: policy.maximumImageCount,
          estimatedUnitCredits: policy.estimatedUnitCredits,
          estimatedMaximumCredits: policy.estimatedMaximumCredits,
          authorizedAt: policy.authorizedAt,
          expiresAt: policy.expiresAt,
          externalPublishAllowed: false,
        },
        ...(shouldResume
          ? {
              pollAfterMs: 2_000,
              pollUrl: `/content/pipelines/${pipelineId}`,
            }
          : {}),
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/pipelines/:id/metrics", (req, res) => {
    try {
      const pipelineId = positiveInteger(req.params.id, "pipelineId");
      const current = inspectFor(req, pipelineId);
      if (!isManagerRole(req.user)) {
        throw new ContentProductionPipelineRouteError(
          "只有老板或管理层可以回传发布指标",
          403,
          "CONTENT_PIPELINE_METRICS_ROLE_FORBIDDEN",
        );
      }
      if (current.status !== "awaiting_metrics") {
        throw new ContentProductionPipelineRouteError(
          "流水线当前不在等待发布指标状态",
          409,
          "CONTENT_PIPELINE_NOT_AWAITING_METRICS",
        );
      }
      requireBackgroundAiGuard(req);
      const tenantId = Number(req.user.tenant_id || curTenant());
      const state = runtime().pipeline.submitMetrics({
        tenantId,
        pipelineId,
        actor: clone(req.user),
        publication: req.body?.publication,
        metrics: req.body?.metrics,
        evidenceNote: req.body?.evidenceNote,
      });
      const shouldResume = state.status === "running";
      if (shouldResume) queueResume({ req, pipelineId });
      logOpFn(
        req.user,
        "内容生产仓",
        shouldResume
          ? "目标平台指标已齐并恢复复盘官"
          : "人工录入单个平台发布指标",
        `pipeline#${pipelineId};platform=${cleanText(req.body?.publication?.platform, 40)};metrics=${Object.keys(
          isRecord(req.body?.metrics) ? req.body.metrics : {},
        )
          .sort()
          .join(",")};verification=manual_unverified`,
      );
      return res.status(shouldResume ? 202 : 200).json({
        pipeline: publicPipeline(state),
        queued: shouldResume,
        ...(shouldResume
          ? {
              pollAfterMs: 2_000,
              pollUrl: `/content/pipelines/${pipelineId}`,
            }
          : {}),
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/pipelines/:id/retry", (req, res) => {
    try {
      const pipelineId = positiveInteger(req.params.id, "pipelineId");
      const state = inspectFor(req, pipelineId);
      if (state.status !== "failed") {
        throw new ContentProductionPipelineRouteError(
          "只能重试真实执行失败的流水线；待对账任务不会重跑API",
          409,
          "CONTENT_PIPELINE_NOT_FAILED",
        );
      }
      stopMutationWhenBillingUnsettled({ state, action: "失败重试" });
      requireBackgroundAiGuard(req);
      queueResume({ req, pipelineId, action: "retry" });
      return res
        .status(202)
        .json({ pipeline: publicPipeline(state), queued: true });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/pipelines/:id/recover", (req, res) => {
    try {
      const pipelineId = positiveInteger(req.params.id, "pipelineId");
      const inspected = inspectFor(req, pipelineId);
      if (!isManagerRole(req.user)) {
        throw new ContentProductionPipelineRouteError(
          "中断工位恢复只能由管理层执行",
          403,
          "CONTENT_PIPELINE_RECOVERY_ROLE_FORBIDDEN",
        );
      }
      stopMutationWhenBillingUnsettled({
        state: inspected,
        action: "中断恢复",
      });
      requireBackgroundAiGuard(req);
      const tenantId = Number(req.user.tenant_id || curTenant());
      const state = runtime().pipeline.recoverInterrupted({
        tenantId,
        pipelineId,
      });
      queueResume({ req, pipelineId });
      return res
        .status(202)
        .json({ pipeline: publicPipeline(state), queued: true });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/pipelines/:id/pause", (req, res) => {
    try {
      const pipelineId = positiveInteger(req.params.id, "pipelineId");
      const inspected = inspectFor(req, pipelineId);
      if (!isManagerRole(req.user)) {
        throw new ContentProductionPipelineRouteError(
          "暂停流水线只能由管理层执行",
          403,
          "CONTENT_PIPELINE_PAUSE_ROLE_FORBIDDEN",
        );
      }
      if (inspected.status === "paused") {
        return res.status(200).json({
          pipeline: publicPipeline(inspected),
          queued: false,
        });
      }
      const tenantId = Number(req.user.tenant_id || curTenant());
      const state = runtime().pipeline.pause({
        tenantId,
        pipelineId,
        reason: cleanText(req.body?.reason || "user_requested", 160),
      });
      logOpFn(
        req.user,
        "内容生产仓",
        "暂停团队流水线",
        `pipeline#${pipelineId};当前工位${state.currentStation};未执行外发`,
      );
      return res.status(200).json({
        pipeline: publicPipeline(state),
        queued: false,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/pipelines/:id/cancel", (req, res) => {
    try {
      const pipelineId = positiveInteger(req.params.id, "pipelineId");
      const inspected = inspectFor(req, pipelineId);
      if (!isManagerRole(req.user)) {
        throw new ContentProductionPipelineRouteError(
          "取消流水线只能由管理层执行",
          403,
          "CONTENT_PIPELINE_CANCEL_ROLE_FORBIDDEN",
        );
      }
      if (inspected.status === "cancelled") {
        return res.status(200).json({
          pipeline: publicPipeline(inspected),
          queued: false,
        });
      }
      const tenantId = Number(req.user.tenant_id || curTenant());
      const state = runtime().pipeline.cancel({
        tenantId,
        pipelineId,
        reason: cleanText(req.body?.reason || "user_requested", 160),
      });
      logOpFn(
        req.user,
        "内容生产仓",
        "取消团队流水线",
        `pipeline#${pipelineId};未交付hold先释放；已交付/已结算历史保留`,
      );
      return res.status(200).json({
        pipeline: publicPipeline(state),
        queued: false,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/pipelines/:id/resume", (req, res) => {
    try {
      const pipelineId = positiveInteger(req.params.id, "pipelineId");
      let state = inspectFor(req, pipelineId);
      if (state.status === "billing_pending") {
        const unsettled = contentPipelineUnsettledStationBilling({
          tenantId: Number(req.user.tenant_id || curTenant()),
          pipelineId,
          stationIdx: Number(state.currentStation),
        });
        if (unsettled) {
          stopMutationWhenBillingUnsettled({ state, action: "继续运行" });
        }
        state = runtime().repository.recoverSettledBillingPending({
          tenantId: Number(req.user.tenant_id || curTenant()),
          pipelineId,
        });
        state = inspectFor(req, pipelineId);
      }
      if (
        !["running", "paused"].includes(state.status) &&
        !pipelinePredictiveRetroWait(state)
      ) {
        return res
          .status(200)
          .json({ pipeline: publicPipeline(state), queued: false });
      }
      stopMutationWhenBillingUnsettled({ state, action: "继续运行" });
      requireBackgroundAiGuard(req);
      if (state.status === "paused") {
        const tenantId = Number(req.user.tenant_id || curTenant());
        state = runtime().pipeline.resumePaused({ tenantId, pipelineId });
      }
      queueResume({ req, pipelineId });
      return res
        .status(202)
        .json({ pipeline: publicPipeline(state), queued: true });
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

export default createContentProductionPipelineRouter();
