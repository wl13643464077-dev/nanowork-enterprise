const FEISHU_OPEN_API = "https://open.feishu.cn/open-apis";
export const FEISHU_BITABLE_BATCH_SIZE = 100;
export const PRIVATE_CALENDAR_FIELDS = Object.freeze([
  "日期",
  "星期",
  "节点",
  "朋友圈文案",
  "社群话术",
]);

export class FeishuBitableError extends Error {
  constructor(message, { code = "FEISHU_BITABLE_FAILED", status = 502 } = {}) {
    super(message);
    this.name = "FeishuBitableError";
    this.code = code;
    this.status = status;
  }
}

function configurationError(message, code = "FEISHU_BITABLE_CONFIG_INVALID") {
  return new FeishuBitableError(message, { code, status: 400 });
}

function providerError(action, code = "FEISHU_BITABLE_PROVIDER_FAILED") {
  return new FeishuBitableError(`${action}暂时不可用，请稍后重试`, {
    code,
    status: 502,
  });
}

function validBitableHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return (
    host.endsWith(".feishu.cn") ||
    host === "larksuite.com" ||
    host.endsWith(".larksuite.com")
  );
}

function validBitableQuery(searchParams) {
  const allowed = new Set(["table", "view"]);
  const seen = new Set();
  for (const [key, value] of searchParams) {
    if (
      !allowed.has(key) ||
      seen.has(key) ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(value)
    ) {
      return false;
    }
    seen.add(key);
  }
  return true;
}

export function parseFeishuBitableUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw configurationError(
      "请先在企业飞书配置中保存多维表格链接",
      "FEISHU_BITABLE_NOT_CONFIGURED",
    );
  }
  if (raw.length > 2_048) {
    throw configurationError("飞书多维表格链接格式不正确");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw configurationError("飞书多维表格链接格式不正确");
  }
  const path = parsed.pathname.match(
    /^\/(base|wiki)\/([A-Za-z0-9]{15,64})\/?$/u,
  );
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hash ||
    !validBitableQuery(parsed.searchParams) ||
    !validBitableHost(parsed.hostname) ||
    !path
  ) {
    throw configurationError("飞书多维表格链接格式不正确");
  }
  return {
    appToken: path[2],
    linkKind: path[1],
    hostname: parsed.hostname.toLowerCase(),
  };
}

function normalizeFields(fields) {
  if (!Array.isArray(fields) || !fields.length || fields.length > 20) {
    throw configurationError("飞书数据表字段配置不完整");
  }
  const normalized = fields.map((field) => String(field || "").trim());
  if (
    normalized.some((field) => !field || field.length > 100) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw configurationError("飞书数据表字段配置不完整");
  }
  return normalized;
}

function normalizeRecords(records, fields) {
  if (!Array.isArray(records) || !records.length || records.length > 5_000) {
    throw configurationError("没有可同步的数据");
  }
  return records.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw configurationError("待同步数据格式不正确");
    }
    const unknown = Object.keys(record).find((key) => !fields.includes(key));
    if (unknown) {
      throw configurationError("待同步数据包含未定义字段");
    }
    return Object.fromEntries(
      fields.map((field) => {
        const text = String(record[field] ?? "")
          .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "")
          .trim();
        if (text.length > 5_000) {
          throw configurationError("待同步数据单字段超过5000字");
        }
        return [field, text];
      }),
    );
  });
}

async function requestJson(
  fetchFn,
  url,
  { action, timeoutMs = 60_000, ...init },
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    if (!response || response.ok !== true) throw providerError(action);
    let data;
    try {
      data = await response.json();
    } catch {
      throw providerError(action);
    }
    if (!data || typeof data !== "object" || Number(data.code) !== 0) {
      throw providerError(action);
    }
    return data;
  } catch (error) {
    if (error instanceof FeishuBitableError) throw error;
    throw providerError(action);
  } finally {
    clearTimeout(timer);
  }
}

function apiHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json; charset=utf-8",
  };
}

export async function ensureFeishuBitableTable({
  fetchFn = fetch,
  accessToken,
  appToken,
  tableName,
  fields,
  timeoutMs,
}) {
  let pageToken = "";
  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams({ page_size: "100" });
    if (pageToken) query.set("page_token", pageToken);
    const listed = await requestJson(
      fetchFn,
      `${FEISHU_OPEN_API}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables?${query}`,
      {
        action: "读取飞书多维表格",
        timeoutMs,
        headers: apiHeaders(accessToken),
      },
    );
    const data = listed.data || {};
    const items = Array.isArray(data.items) ? data.items : [];
    const existing = items.find(
      (item) => item && String(item.name || "") === tableName,
    );
    if (existing) {
      const tableId = String(existing.table_id || "").trim();
      if (!tableId) throw providerError("读取飞书多维表格");
      return { tableId, created: false };
    }
    if (!data.has_more) break;
    pageToken = String(data.page_token || "").trim();
    if (!pageToken) throw providerError("读取飞书多维表格");
  }

  const created = await requestJson(
    fetchFn,
    `${FEISHU_OPEN_API}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`,
    {
      action: "创建飞书数据表",
      method: "POST",
      timeoutMs,
      headers: apiHeaders(accessToken),
      body: JSON.stringify({
        table: {
          name: tableName,
          default_view_name: "表格",
          fields: fields.map((fieldName) => ({
            field_name: fieldName,
            type: 1,
          })),
        },
      }),
    },
  );
  const tableId = String(
    created.data?.table_id || created.data?.table?.table_id || "",
  ).trim();
  if (!tableId) throw providerError("创建飞书数据表");
  return { tableId, created: true };
}

export async function writeFeishuBitableBatches({
  fetchFn = fetch,
  accessToken,
  appToken,
  tableId,
  records,
  idempotencyField,
  timeoutMs,
}) {
  const recordKey = (value) => {
    if (Array.isArray(value)) return value.map(recordKey).join("").trim();
    if (value && typeof value === "object") {
      return String(value.text ?? value.name ?? value.value ?? "").trim();
    }
    return String(value ?? "").trim();
  };
  const batchWrite = async (kind, items) => {
    for (
      let offset = 0;
      offset < items.length;
      offset += FEISHU_BITABLE_BATCH_SIZE
    ) {
      const batch = items.slice(offset, offset + FEISHU_BITABLE_BATCH_SIZE);
      await requestJson(
        fetchFn,
        `${FEISHU_OPEN_API}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/batch_${kind}`,
        {
          action: "写入飞书多维表格",
          method: "POST",
          timeoutMs,
          headers: apiHeaders(accessToken),
          body: JSON.stringify({ records: batch }),
        },
      );
    }
  };

  if (idempotencyField) {
    const inputKeys = new Set();
    for (const fields of records) {
      const key = recordKey(fields[idempotencyField]);
      if (!key || inputKeys.has(key)) {
        throw configurationError("待同步数据的幂等字段为空或重复");
      }
      inputKeys.add(key);
    }

    const existingByKey = new Map();
    let pageToken = "";
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ page_size: "500" });
      if (pageToken) query.set("page_token", pageToken);
      const listed = await requestJson(
        fetchFn,
        `${FEISHU_OPEN_API}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records?${query}`,
        {
          action: "读取飞书多维表格记录",
          timeoutMs,
          headers: apiHeaders(accessToken),
        },
      );
      const data = listed.data || {};
      for (const item of Array.isArray(data.items) ? data.items : []) {
        const recordId = String(item?.record_id || item?.recordId || "").trim();
        const key = recordKey(item?.fields?.[idempotencyField]);
        if (recordId && key && !existingByKey.has(key)) {
          existingByKey.set(key, recordId);
        }
      }
      if (!data.has_more) break;
      pageToken = String(data.page_token || "").trim();
      if (!pageToken) throw providerError("读取飞书多维表格记录");
    }

    const creates = [];
    const updates = [];
    for (const fields of records) {
      const recordId = existingByKey.get(recordKey(fields[idempotencyField]));
      if (recordId) updates.push({ record_id: recordId, fields });
      else creates.push({ fields });
    }
    await batchWrite("update", updates);
    await batchWrite("create", creates);
    return records.length;
  }

  let synced = 0;
  for (
    let offset = 0;
    offset < records.length;
    offset += FEISHU_BITABLE_BATCH_SIZE
  ) {
    const batch = records.slice(offset, offset + FEISHU_BITABLE_BATCH_SIZE);
    await requestJson(
      fetchFn,
      `${FEISHU_OPEN_API}/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/batch_create`,
      {
        action: "写入飞书多维表格",
        method: "POST",
        timeoutMs,
        headers: apiHeaders(accessToken),
        body: JSON.stringify({
          records: batch.map((fields) => ({ fields })),
        }),
      },
    );
    synced += batch.length;
  }
  return synced;
}

export async function syncFeishuBitableRows({
  bitableUrl,
  tableName,
  fields,
  records,
  idempotencyField,
  tokenFn,
  fetchFn = fetch,
  timeoutMs = 60_000,
}) {
  const { appToken } = parseFeishuBitableUrl(bitableUrl);
  const normalizedTableName = String(tableName || "").trim();
  if (!normalizedTableName || normalizedTableName.length > 100) {
    throw configurationError("飞书数据表名称不正确");
  }
  const normalizedFields = normalizeFields(fields);
  const normalizedRecords = normalizeRecords(records, normalizedFields);
  const normalizedIdempotencyField = String(idempotencyField || "").trim();
  if (
    normalizedIdempotencyField &&
    !normalizedFields.includes(normalizedIdempotencyField)
  ) {
    throw configurationError("飞书幂等字段未包含在数据表字段中");
  }
  if (typeof tokenFn !== "function") {
    throw configurationError(
      "未配置飞书企业应用凭据",
      "FEISHU_CREDENTIALS_NOT_CONFIGURED",
    );
  }
  let accessToken;
  try {
    accessToken = String(await tokenFn()).trim();
  } catch (error) {
    if (/(?:未配置|凭据|App ID\/Secret)/u.test(String(error?.message || ""))) {
      throw configurationError(
        "未配置飞书企业应用凭据",
        "FEISHU_CREDENTIALS_NOT_CONFIGURED",
      );
    }
    throw providerError("飞书鉴权", "FEISHU_AUTH_FAILED");
  }
  if (!accessToken) {
    throw providerError("飞书鉴权", "FEISHU_AUTH_FAILED");
  }
  const table = await ensureFeishuBitableTable({
    fetchFn,
    accessToken,
    appToken,
    tableName: normalizedTableName,
    fields: normalizedFields,
    timeoutMs,
  });
  const synced = await writeFeishuBitableBatches({
    fetchFn,
    accessToken,
    appToken,
    tableId: table.tableId,
    records: normalizedRecords,
    idempotencyField: normalizedIdempotencyField,
    timeoutMs,
  });
  return {
    table: normalizedTableName,
    tableId: table.tableId,
    created: table.created,
    synced,
  };
}

export function privateCalendarRecords(calendar) {
  const days = Array.isArray(calendar?.days) ? calendar.days : [];
  if (!days.length) throw configurationError("私域日历结构不完整");
  return days.map((day) => ({
    日期: String(day.date || ""),
    星期: String(day.weekday || ""),
    节点: String(day.festival || ""),
    朋友圈文案: String(day.moment || ""),
    社群话术: String(day.group || ""),
  }));
}

export async function syncPrivateCalendarToFeishu({
  calendar,
  bitableUrl,
  tokenFn,
  fetchFn = fetch,
  timeoutMs,
}) {
  const month = String(calendar?.month || "").trim();
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month)) {
    throw configurationError("私域日历月份不正确");
  }
  return syncFeishuBitableRows({
    bitableUrl,
    tableName: `私域日历${month}`,
    fields: [...PRIVATE_CALENDAR_FIELDS],
    records: privateCalendarRecords(calendar),
    idempotencyField: "日期",
    tokenFn,
    fetchFn,
    timeoutMs,
  });
}
