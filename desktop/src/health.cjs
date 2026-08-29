"use strict";

const { normalizeServerUrl } = require("./config.cjs");

async function checkServerHealth(serverUrl, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const origin = normalizeServerUrl(serverUrl);
  const healthUrl = new URL("/api/health", `${origin}/`).href;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(healthUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: `服务暂时不可用（HTTP ${response.status}）`,
      };
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (payload?.ok !== true || payload?.db === "down") {
      return {
        ok: false,
        status: response.status,
        message: "服务返回了无效的健康检查结果",
      };
    }
    return { ok: true, status: response.status, message: "服务连接正常" };
  } catch (error) {
    const timedOut = controller.signal.aborted || error?.name === "AbortError";
    return {
      ok: false,
      status: null,
      message: timedOut
        ? "连接超时，请检查网络或服务器地址"
        : "无法连接服务器，请检查网络或服务器地址",
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { checkServerHealth };
