const text = value => String(value ?? '').trim();

// 面向人的运行状态。数据库枚举和兼容字段可以继续保留，但页面不能再用
// “可用 / 降级 / 禁用”这类没有说明能力边界的词代替真实结论。
export const READINESS_STATUS_META = Object.freeze({
  connected: Object.freeze({ label: '已验证就绪', color: 'green', badge: 'success' }),
  local_ready: Object.freeze({ label: '本地能力已就绪', color: 'blue', badge: 'success' }),
  configured_unverified: Object.freeze({ label: '已配置，需验证', color: 'gold', badge: 'warning' }),
  degraded: Object.freeze({ label: '真实通道未配置', color: 'orange', badge: 'warning' }),
  blocked: Object.freeze({ label: '前置条件未满足', color: 'red', badge: 'error' }),
  manual_only: Object.freeze({ label: '仅支持人工操作', color: 'default', badge: 'default' }),
  disabled: Object.freeze({ label: '已关闭', color: 'default', badge: 'default' }),
  requires_input: Object.freeze({ label: '需提供实时数据', color: 'purple', badge: 'warning' }),
});

const READINESS_VERIFICATION_LABEL = Object.freeze({
  passed: '最近验证通过',
  failed: '最近验证失败',
  stale: '验证已过期',
  never: '尚未验证',
  not_applicable: '无需验证',
});

export function runtimeReadinessMeta(item) {
  if (item?.verification === 'failed') {
    return { label: '最近验证失败', color: 'red', badge: 'error' };
  }
  if (item?.verification === 'stale') {
    return { label: '验证已过期', color: 'orange', badge: 'warning' };
  }
  return READINESS_STATUS_META[item?.effective] || { label: '状态未上报', color: 'default', badge: 'default' };
}

export function runtimeReadinessConfigLabel(item) {
  if (item?.configuration === 'not_required') return '无需配置';
  if (item?.configuration === 'ready') return '配置完整';
  if (item?.configuration === 'partial') return '配置不完整';
  return '需要配置';
}

export function runtimeReadinessVerificationLabel(item) {
  return READINESS_VERIFICATION_LABEL[item?.verification] || '验证状态未上报';
}

export function dashboardFeishuPresentation(feishu) {
  if (!feishu || typeof feishu !== 'object') {
    return {
      state: 'unknown',
      label: '飞书状态未读取',
      color: 'default',
      description: '当前页面没有取得飞书运行状态，不能据此判断是否已连接。',
    };
  }

  const readiness = feishu.readiness && typeof feishu.readiness === 'object' ? feishu.readiness : {};
  const verifiedReady =
    readiness.connected === true && readiness.canPerformExternalAction === true && readiness.verification === 'passed';
  if (verifiedReady) {
    return {
      state: 'ready',
      label: '飞书已验证就绪',
      color: 'success',
      description: '最近一次显式测试发送通过，当前配置允许执行飞书消息或日历动作。',
    };
  }
  if (readiness.verification === 'failed') {
    return {
      state: 'failed',
      label: '飞书验证失败',
      color: 'error',
      description: '最近一次显式测试失败，请修复配置后重新测试。',
    };
  }
  if (readiness.verification === 'stale') {
    return {
      state: 'stale',
      label: '飞书验证已过期',
      color: 'warning',
      description: '配置已变化或验证已过期，需要重新发送测试消息。',
    };
  }
  if (feishu.enabled === true) {
    return {
      state: 'needs_verification',
      label: '飞书需连接验证',
      color: 'warning',
      description: '配置开关已启用，但尚无有效的测试发送证据，不能标记为已连接。',
    };
  }
  if (feishu.appReady === true || ['ready', 'partial'].includes(text(readiness.configuration))) {
    return {
      state: 'needs_activation',
      label: '飞书待启用',
      color: 'default',
      description: '已有部分或完整配置；启用企业同步后，还需发送测试消息完成验证。',
    };
  }
  return {
    state: 'needs_configuration',
    label: '飞书需配置',
    color: 'default',
    description: '请先配置企业应用、在职接收人和同步开关，再发送测试消息。',
  };
}

export function activityCalendarSyncPresentation(info) {
  if (!info || typeof info !== 'object') {
    return {
      state: 'unknown',
      ready: false,
      label: '日历直写状态未读取',
      color: 'default',
      message: '当前没有取得飞书日历运行状态；仍可使用下方 .ics 文件人工导入或订阅。',
    };
  }
  const readiness = info.readiness && typeof info.readiness === 'object' ? info.readiness : {};
  const verifiedReady =
    info.autoSyncReady === true &&
    readiness.connected === true &&
    readiness.canPerformExternalAction === true &&
    readiness.verification === 'passed';
  if (verifiedReady) {
    return {
      state: 'ready',
      ready: true,
      label: '日历直写已验证就绪',
      color: 'success',
      message: `最近一次飞书测试通过；活动变更将同步给 ${Number(info.managers?.count) || 0} 位老板或管理层。`,
    };
  }
  if (readiness.verification === 'failed') {
    return {
      state: 'failed',
      ready: false,
      label: '日历直写验证失败',
      color: 'error',
      message: '最近一次飞书测试失败；修复配置并重新测试前，请使用 .ics 人工导入或订阅。',
    };
  }
  if (readiness.verification === 'stale') {
    return {
      state: 'stale',
      ready: false,
      label: '日历直写验证已过期',
      color: 'warning',
      message: '配置已变化或验证已过期；重新测试前，请使用 .ics 人工导入或订阅。',
    };
  }
  if (info.configuredSyncEnabled === true) {
    return {
      state: 'needs_verification',
      ready: false,
      label: '日历直写需连接验证',
      color: 'warning',
      message: '企业应用和同步开关已配置，但尚无有效测试证据；验证前请使用 .ics 人工导入或订阅。',
    };
  }
  if (info.appMode === true) {
    return {
      state: 'needs_activation',
      ready: false,
      label: '日历直写待启用',
      color: 'default',
      message: '应用凭据已配置；启用同步并通过测试前，请使用 .ics 人工导入或订阅。',
    };
  }
  return {
    state: 'needs_configuration',
    ready: false,
    label: '日历直写需配置',
    color: 'default',
    message: '飞书企业应用尚未配置；当前请使用 .ics 人工导入或订阅。',
  };
}

export function generatedArtifactStatusLabel(status) {
  const raw = text(status);
  if (raw === '可用') return '文件已生成';
  if (raw === '已入档') return '已归档到知识库';
  if (raw === '已隔离' || raw === '隔离') return '已隔离（不能用于业务）';
  return raw || '文件已生成';
}
