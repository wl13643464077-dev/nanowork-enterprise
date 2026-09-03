import path from "node:path";

import { q } from "../db.js";

const PROVIDER = Object.freeze({
  name: "imagehunt-authorized-library",
  model: "licensed-material-search-v1",
  mode: "local",
});

const ALLOWED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    throw Object.assign(new Error(`${label}必须是1-${maximum}的整数`), {
      status: 400,
      code: "LICENSED_MATERIAL_REQUEST_INVALID",
    });
  }
  return number;
}

function compactText(value, maximum = 4_000) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function normalizedText(value) {
  return compactText(value)
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function safeJsonObject(value) {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stringList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [value];
  } catch {
    return value.split(/[,\uff0c;\uff1b|/]+/u);
  }
}

function normalizedStringList(...values) {
  return [
    ...new Set(
      values
        .flatMap((value) => stringList(value))
        .map((value) => compactText(value, 160))
        .filter(Boolean),
    ),
  ];
}

function localFileUrlForTenant(value, tenantId) {
  const url = compactText(value, 1_000);
  const prefix = `/uploads/files/${tenantId}/`;
  if (!url.startsWith(prefix) || /[?#\\]/u.test(url)) return null;
  try {
    const decoded = decodeURIComponent(url);
    if (!decoded.startsWith(prefix) || decoded.includes("\\")) return null;
    const segments = decoded.slice(prefix.length).split("/");
    if (
      segments.length < 2 ||
      segments.some(
        (segment) => !segment || segment === "." || segment === "..",
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return url;
}

function externalSourceUrl(value) {
  const raw = compactText(value, 1_500);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function safeFileName(url, materialId, mimeType) {
  const extension = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  }[mimeType];
  try {
    const decoded = decodeURIComponent(path.posix.basename(url));
    const cleaned = compactText(decoded, 200).replace(/[\\/]/gu, "_");
    if (cleaned) return cleaned;
  } catch {
    // The URL was already validated; a conservative generated name is enough.
  }
  return `imagehunt-material-${materialId}.${extension}`;
}

function eligibleMaterial(row, tenantId) {
  if (!row || Number(row.tenant_id) !== tenantId) return null;
  if (compactText(row.source_type, 40) !== "imagehunt") return null;
  const artifact = safeJsonObject(row.artifact_snapshot_json);
  const rights = isRecord(artifact?.rights) ? artifact.rights : null;
  const license = compactText(rights?.license, 200);
  if (rights?.confirmed !== true || rights?.commercialUse !== true || !license)
    return null;

  const fileUrl = localFileUrlForTenant(artifact.fileUrl, tenantId);
  if (!fileUrl || compactText(row.url, 1_000) !== fileUrl) return null;
  const mimeType = compactText(artifact.mimeType, 80).toLocaleLowerCase(
    "en-US",
  );
  if (!ALLOWED_IMAGE_MIME.has(mimeType)) return null;

  const attribution = compactText(rights.attribution, 300) || null;
  const sourceUrl =
    externalSourceUrl(artifact.sourceUrl) ||
    externalSourceUrl(artifact.originalImageUrl);
  return {
    id: Number(row.id),
    name: compactText(row.name, 240),
    tags: normalizedStringList(row.tags),
    note: compactText(row.note, 1_000),
    body: compactText(row.body_snapshot, 4_000),
    createdAt: compactText(row.created_at, 80),
    fileUrl,
    mimeType,
    fileName: safeFileName(fileUrl, Number(row.id), mimeType),
    sourceUrl,
    rights: {
      confirmed: true,
      license,
      attribution,
      commercialUse: true,
    },
    artifact,
  };
}

function cjkNgrams(value) {
  const output = new Set();
  for (const segment of value.match(/[\p{Script=Han}]+/gu) || []) {
    if (segment.length >= 2 && segment.length <= 24) output.add(segment);
    for (const size of [2, 3, 4]) {
      if (segment.length < size) continue;
      for (let index = 0; index <= segment.length - size; index += 1) {
        output.add(segment.slice(index, index + size));
        if (output.size >= 160) return output;
      }
    }
  }
  return output;
}

function queryTerms(value) {
  const normalized = normalizedText(value);
  if (!normalized) return { phrase: "", terms: [] };
  const terms = new Set(
    normalized
      .split(" ")
      .filter((term) => term.length >= 2)
      .slice(0, 80),
  );
  for (const gram of cjkNgrams(normalized)) terms.add(gram);
  return { phrase: normalized, terms: [...terms].slice(0, 200) };
}

function materialSearchText(material) {
  const artifact = material.artifact;
  return normalizedText(
    [
      material.name,
      material.tags.join(" "),
      material.note,
      material.body,
      artifact.provider,
      artifact.searchQuery,
      artifact.query,
      material.rights.attribution,
    ].join(" "),
  );
}

function relevance(material, weightedQueries) {
  const document = materialSearchText(material);
  let score = 0;
  for (const { value, weight } of weightedQueries) {
    const { phrase, terms } = queryTerms(value);
    if (!phrase) continue;
    if (phrase.length >= 2 && document.includes(phrase)) {
      score += weight * (12 + Math.min(phrase.length, 24));
    }
    for (const term of terms) {
      if (document.includes(term)) {
        score += weight * (term.length >= 4 ? 3 : term.length >= 3 ? 2 : 1);
      }
    }
  }
  return score;
}

function hasSubstantiveContentMatch(material, queries) {
  const document = materialSearchText(material);
  return queries.some(({ value }) => {
    const { phrase, terms } = queryTerms(value);
    if (!phrase) return false;
    if (phrase.length <= 2 && document.includes(phrase)) return true;
    return terms.some((term) => term.length >= 3 && document.includes(term));
  });
}

function requestedPlan(input) {
  const runtime = isRecord(input.runtime) ? input.runtime : {};
  const request = isRecord(input.request) ? input.request : {};
  const variables = isRecord(runtime.variables) ? runtime.variables : {};
  const mediaRequest = isRecord(variables.media_request)
    ? variables.media_request
    : {};
  const candidates = [
    input.imagePlan,
    runtime.imagePlan,
    request.imagePlan,
    request.image_plan,
    mediaRequest.plan,
  ];
  const source = candidates.find(Array.isArray) || [];
  return source
    .slice(0, 12)
    .map((item) => {
      if (!isRecord(item)) return null;
      const slot = compactText(item.slot, 160);
      const desc = compactText(item.desc || item.description, 2_000);
      if (!slot || !desc) return null;
      return {
        slot,
        desc,
        platform: compactText(item.platform, 120),
      };
    })
    .filter(Boolean);
}

function requestContext(input) {
  const runtime = isRecord(input.runtime) ? input.runtime : {};
  const request = isRecord(input.request) ? input.request : {};
  const plan = requestedPlan(input);
  const prompt =
    compactText(input.prompt, 4_000) ||
    compactText(request.prompt, 4_000) ||
    compactText(runtime.prompt, 4_000);
  const platforms = normalizedStringList(
    input.platforms,
    request.platforms,
    runtime.platforms,
    plan.map((item) => item.platform),
  );
  return { prompt, platforms, plan };
}

function genericSlot(index, prompt, platforms) {
  const subject = prompt || platforms.join("、") || "本次内容任务";
  return {
    slot: `配图${index + 1}`,
    desc: compactText(`从已授权素材库中匹配：${subject}`, 2_000),
    platform: "",
  };
}

function selectMaterials(materials, count, context) {
  const selected = [];
  const remaining = new Set(materials.map((material) => material.id));
  const globalQueries = [
    { value: context.prompt, weight: 8 },
    { value: context.platforms.join(" "), weight: 5 },
    {
      value: context.plan.map((item) => `${item.slot} ${item.desc}`).join(" "),
      weight: 2,
    },
  ];

  for (let index = 0; index < count && remaining.size > 0; index += 1) {
    const plannedSlot = context.plan[index] || null;
    const slot =
      plannedSlot || genericSlot(index, context.prompt, context.platforms);
    const contentQueries = [
      { value: context.prompt, weight: 8 },
      ...(plannedSlot
        ? [
            { value: slot.slot, weight: 8 },
            { value: slot.desc, weight: 12 },
          ]
        : []),
    ];
    const queries = [
      ...globalQueries,
      { value: slot.slot, weight: 8 },
      { value: slot.desc, weight: 12 },
      { value: slot.platform, weight: 8 },
    ];
    const candidate = materials
      .filter((material) => remaining.has(material.id))
      .map((material) => ({
        material,
        score: relevance(material, queries),
        contentScore: relevance(material, contentQueries),
      }))
      .filter((item) =>
        hasSubstantiveContentMatch(item.material, contentQueries),
      )
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.contentScore - left.contentScore ||
          right.material.id - left.material.id,
      )[0];
    if (!candidate) break;
    remaining.delete(candidate.material.id);
    selected.push({ material: candidate.material, slot });
  }
  return selected;
}

function defaultListRows(tenantId) {
  return q.all(
    `SELECT id,tenant_id,name,type,tags,url,source_type,note,body_snapshot,
      artifact_snapshot_json,created_at
    FROM materials
    WHERE tenant_id=? AND source_type='imagehunt'
    ORDER BY id DESC
    LIMIT 500`,
    tenantId,
  );
}

function abortIfRequested(signal) {
  if (!signal?.aborted) return;
  throw Object.assign(new Error("已取消已授权素材检索"), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

export function createLicensedMaterialSearch({
  listRowsFn = defaultListRows,
} = {}) {
  if (typeof listRowsFn !== "function") {
    throw new TypeError("licensed material search缺少listRowsFn");
  }
  return async function licensedMaterialSearch(input = {}) {
    const tenantId = positiveInteger(input.tenantId, "tenantId");
    const count = positiveInteger(input.count, "count", 12);
    abortIfRequested(input.signal);
    const rows = await listRowsFn(tenantId);
    abortIfRequested(input.signal);
    if (!Array.isArray(rows)) {
      throw Object.assign(new Error("已授权素材库返回了非法数据"), {
        status: 500,
        code: "LICENSED_MATERIAL_STORE_INVALID",
      });
    }
    const eligible = rows
      .map((row) => eligibleMaterial(row, tenantId))
      .filter(Boolean);
    const context = requestContext(input);
    const selected = selectMaterials(eligible, count, context);
    const assets = selected.map(({ material, slot }) => ({
      url: material.fileUrl,
      mimeType: material.mimeType,
      fileName: material.fileName,
      slot: slot.slot,
      desc: slot.desc,
      sourceUrl: material.sourceUrl,
      rights: material.rights,
      materialId: material.id,
    }));

    return {
      assets,
      provider: { ...PROVIDER },
      model: PROVIDER.model,
      mode: PROVIDER.mode,
      usage: {
        requestedCount: count,
        returnedCount: assets.length,
        imageCount: assets.length,
        scannedCount: rows.length,
        eligibleCount: eligible.length,
        networkRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        tokenUsageApplicable: false,
        pricingMode: "tenant_local_authorized_library",
      },
      cost: {
        credits: 0,
        pricingMode: "tenant_local_authorized_library",
      },
    };
  };
}

export const searchLicensedMaterials = createLicensedMaterialSearch();

export default searchLicensedMaterials;
