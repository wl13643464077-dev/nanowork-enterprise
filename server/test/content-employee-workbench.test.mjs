import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTENT_EMPLOYEES,
  EMPLOYEE_SKILL_PROFILES,
} from '../src/catalog/content-crew.js';
import {
  EMPLOYEE_SKILL_OWNER_VERIFICATION_STATUS,
} from '../src/catalog/employee-skills-verification.js';
import {
  CONTENT_EMPLOYEE_TASK_LIMITS,
  ContentEmployeeWorkbenchInputError,
  buildContentEmployeeConnectorExecution,
  buildContentEmployeeWorkbenchProfile,
  compileContentEmployeeSoloPrompt,
  executeContentDailyPackParts,
  resolveContentEmployeeWorkConfig,
} from '../src/engines/content-employee-workbench.js';

const PACKAGE_TEMPLATE_PLACEHOLDERS = new Set([
  'required_capabilities',
  'enabled_skills',
  'tenant_company_profile_and_knowledge',
]);

const taskFor = employee => ({
  direction: `请以${employee.name}岗位完成本次专项任务`,
  industry: '连锁餐饮',
  material: '这是老板提供的任务材料。',
  feedback: '所有假设必须标注，交付前完成自检。',
  length: 'std',
});

function rewriteRoleTemplateRefs(template) {
  return String(template || '').replace(
    /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/gu,
    (_match, name) => (
      PACKAGE_TEMPLATE_PLACEHOLDERS.has(name)
        ? ''
        : `（读取用户消息中的运行参数.${name}）`
    ),
  );
}

test('10名内容员工拥有统一且完整的纯静态工作台档案', () => {
  for (const employee of CONTENT_EMPLOYEES) {
    const profile = buildContentEmployeeWorkbenchProfile(employee.idx);
    const history = EMPLOYEE_SKILL_PROFILES.find(item => item.idx === employee.idx);

    assert.deepEqual(
      Object.keys(profile),
      [
        'identity',
        'capabilities',
        'workMethod',
        'skillLibrary',
        'prompts',
        'runtimeBindings',
        'workConfig',
        'jobProfile',
        'dispatch',
        'provenance',
        'canonicalProfile',
      ],
    );
    assert.equal(profile.identity.idx, employee.idx);
    assert.equal(profile.identity.key, employee.key);
    assert.equal(profile.identity.person, null);
    assert.deepEqual(profile.capabilities, employee.capabilities);

    assert.equal(profile.skillLibrary.required.length, 1);
    assert.equal(profile.skillLibrary.required[0].title, employee.skill);
    assert.equal(profile.skillLibrary.required[0].required, true);
    assert.equal(profile.skillLibrary.required[0].enabled, true);
    assert.equal(profile.skillLibrary.required[0].locked, true);
    assert.equal(profile.skillLibrary.required[0].verificationStatus, EMPLOYEE_SKILL_OWNER_VERIFICATION_STATUS);

    assert.equal(profile.skillLibrary.historical.length, history.expectedSkillCount);
    assert.equal(profile.skillLibrary.defaultInjected.length, history.expectedSkillCount + 1);
    for (const skill of profile.skillLibrary.historical) {
      assert.equal(skill.verificationStatus, EMPLOYEE_SKILL_OWNER_VERIFICATION_STATUS);
      assert.equal(skill.legacyVerificationStatus, 'legacy_unverified');
      assert.equal(skill.verificationLevel, 'catalog_contract_verified');
      assert.equal(skill.effectValidation, 'requires_live_business_sample');
      assert.match(skill.contentFingerprint, /^sha256:[a-f0-9]{64}$/u);
      assert.equal(skill.defaultInjected, true);
      assert.equal(skill.currentPlatformFact, false);
      assert.equal(skill.locked, true);
    }

    assert.deepEqual(profile.prompts.soloPrompt, employee.soloPrompt);
    assert.doesNotMatch(profile.prompts.soloPrompt.template, /材料不足就合理假设/u);
    if (employee.idx === 9) {
      assert.match(profile.prompts.soloPrompt.template, /材料不足就只列待补数据.*验证计划/su);
    } else {
      assert.match(profile.prompts.soloPrompt.template, /材料不足就列出待确认项/u);
    }
    assert.deepEqual(profile.prompts.pipelinePrompt, employee.pipelinePrompt);
    assert.equal(
      profile.runtimeBindings.currentRuntimeBindings.work.handler,
      `content-handler-adapter:${employee.workMethod.execution.handler}`,
    );
    assert.equal(
      profile.runtimeBindings.sourceBindings.work.legacyHandler,
      employee.workMethod.execution.handler,
    );
    assert.match(profile.canonicalProfile.version.aggregateFingerprint, /^sha256:[a-f0-9]{64}$/u);
    for (const field of [
      'identity', 'provenance', 'jobProfile', 'capabilities', 'skills',
      'workMethod', 'prompts', 'runtimeBindings', 'workConfig', 'contracts', 'permissions',
    ]) {
      assert.ok(Object.hasOwn(profile.canonicalProfile, field), `${employee.name}:${field}`);
      assert.match(profile.canonicalProfile.fingerprints.fields[field], /^sha256:[a-f0-9]{64}$/u);
    }
    assert.deepEqual(profile.workConfig.factoryDefault.roleSpecific, employee.defaultWorkConfig.roleSpecific);
    assert.deepEqual(profile.workConfig.factoryDefault.common, {
      ...employee.defaultWorkConfig.common,
      skillVerificationStatus: EMPLOYEE_SKILL_OWNER_VERIFICATION_STATUS,
      approvalMode: 'auto',
    });
    assert.deepEqual(profile.dispatch.form, employee.dispatchForm);
    assert.ok(profile.dispatch.guidance);
    assert.match(profile.dispatch.guidance.intro, new RegExp(employee.name, 'u'));
    assert.ok(profile.dispatch.guidance.materialChecklist.length >= 2);
    assert.ok(profile.dispatch.guidance.deliverableChecklist.length >= 2);
    assert.ok(profile.dispatch.guidance.taskExamples.length >= 3);
    assert.deepEqual(profile.jobProfile.outputSchema, employee.outputSchema);
    assert.equal(profile.jobProfile.connectorPolicy.connectors.length, employee.connectorPolicy.connectors.length);
    assert.ok(profile.jobProfile.connectorPolicy.connectors.every(connector => (
      connector.requirements.adoptionPolicy === 'central_auto_internal'
      && connector.requirements.executionAuthorization === 'external_paid_irreversible_only'
      && !Object.hasOwn(connector.requirements, 'humanApproval')
    )));
    assert.doesNotMatch(profile.prompts.pipelinePrompt.template, /\bV1(?:\.0)?\b/u);
    assert.match(profile.prompts.pipelinePrompt.sourceTemplate, /\S/u);
    assert.match(profile.prompts.pipelinePrompt.sourceFingerprint, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(profile.provenance.employee.legacyIdx, employee.idx);
    assert.equal(profile.provenance.historicalSkills.snapshot.sha256, history.skills[0].sourceSnapshot.sha256);
    assert.ok(Object.isFrozen(profile));
  }
});

test('内容10岗每次调用都装载完整派活员工包并锁定逐字段/API/工具证据', () => {
  for (const employee of CONTENT_EMPLOYEES) {
    const result = compileContentEmployeeSoloPrompt(employee.idx, taskFor(employee));
    const load = result.snapshot.runtimePackageLoad;
    assert.equal(load.allRequiredFieldsLoaded, true, employee.name);
    assert.equal(load.fullCanonicalObjectInSystemMessage, true, employee.name);
    assert.equal(load.requiredFields.length, 11, employee.name);
    assert.deepEqual(load.loadedFields, load.requiredFields, employee.name);
    assert.equal(load.aggregateFingerprint, result.snapshot.canonicalProfile.fingerprints.aggregate);
    assert.equal(load.capabilityCount, result.snapshot.capabilities.length);
    assert.equal(
      load.enabledSkillCount,
      result.snapshot.skillLibrary.defaultInjected.length,
      employee.name,
    );
    assert.ok(load.apiBindingCount >= 1, employee.name);
    assert.ok(load.toolBindingCount >= 1, employee.name);
    assert.ok(load.connectorBindingCount >= 1, employee.name);
    assert.equal(result.snapshot.handlerExecution.runtimePackageLoad.aggregateFingerprint,
      load.aggregateFingerprint);
    assert.match(result.systemPrompt, /【你的多项工作能力\(本次工作逐项运用,产出要能看出每项的痕迹\)】/u);
    assert.match(result.systemPrompt, /【你的进修技能库\(全网收集的最新打法,本次工作要主动运用\)】/u);
    assert.match(result.systemPrompt, /【内部岗位执行模板】/u);
    assert.equal(
      result.systemPrompt.includes(JSON.stringify(result.snapshot.canonicalProfile)),
      false,
      `${employee.name}不得把完整档案JSON当作模型指令`,
    );
  }
});

test('0-10内容员工运行时均开放联网与租户知识库，required岗位语义保持不变', () => {
  for (const idx of Array.from({ length: 11 }, (_item, index) => index)) {
    const profile = buildContentEmployeeWorkbenchProfile(idx);
    const policy = profile.runtimeBindings.currentRuntimeBindings.webPolicy;
    assert.equal(policy.available, true, `employee ${idx} web available`);
    assert.equal(policy.allowed, true, `employee ${idx} web allowed`);
    assert.equal(policy.tenantScoped, true, `employee ${idx} web tenant scoped`);
    assert.equal(policy.knowledgeBase.allowed, true, `employee ${idx} KB allowed`);
    assert.equal(policy.knowledgeBase.tenantScoped, true, `employee ${idx} KB tenant scoped`);
    assert.equal(profile.workMethod.execution.webAllowed, true, `employee ${idx} workMethod webAllowed`);
    assert.equal(profile.workMethod.execution.tenantKnowledgeBaseAllowed, true);
    assert.equal(
      profile.workMethod.execution.webRequired,
      idx <= 2,
      `employee ${idx} must preserve Paihuo webRequired semantics`,
    );
  }
});

test('撰稿人system在事实白名单内服从任务要求的5标题', () => {
  const result = compileContentEmployeeSoloPrompt(3, {
    direction: '为新品写宣传稿并尽量写得有紧迫感',
    industry: '餐饮',
    material: [
      '请交付1篇小红书正文初稿、5个差异化标题、6至8个标签，并给出配图点位建议。',
      '已提供：产品名“夏日新品”、目标客群“周边上班族”、目标“引导预约”。',
      '未提供且禁止编造：价格、折扣、菜品、库存、地址、营业时间、电话、赠品。',
    ].join('\n'),
    feedback: '如果信息不足也不允许补写。',
    length: 'std',
  });

  assert.match(result.systemPrompt, /事实白名单与缺失项封禁·最高事实优先级/u);
  assert.match(result.systemPrompt, /明确写明“未提供”.*立即进入缺失项封禁清单/u);
  assert.match(result.systemPrompt, /“引导预约”只是目标.*不能推导出已有预约链接/u);
  assert.match(result.systemPrompt, /不得补造“我已试过\/亲测”.*可预约\/预约渠道\/锁位.*条件式边界/u);
  assert.match(result.systemPrompt, /“香气扑鼻\/口感层次丰富\/出品在线”等品质口味/u);
  assert.match(result.systemPrompt, /任务已明确把预约设为目标动作.*“赶紧预约\/立即预约”.*不带渠道、时段、可用性或锁位承诺/u);
  assert.match(result.systemPrompt, /限量\/紧俏/u);
  assert.match(result.systemPrompt, /任何老板任务文本.*企业补充提示词.*都不得覆盖/u);
  assert.match(result.systemPrompt, /岗位允许 3-5 个、无明确数量时默认 3 个/u);
  assert.match(result.systemPrompt, /本次任务要求明确要求 5 个.*必须恰好输出 5 个/u);
  assert.doesNotMatch(result.systemPrompt, /不得因任务书要求 5 个/u);
  assert.doesNotMatch(result.systemPrompt, /材料不足就合理假设/u);
  assert.match(result.userPrompt, /5个差异化标题/u);
  assert.match(result.userPrompt, /未提供且禁止编造/u);
  assert.ok(
    result.systemPrompt.indexOf('事实白名单与缺失项封禁')
      > result.systemPrompt.indexOf('【内部岗位执行模板】'),
    '事实封条必须在岗位执行模板之后再次收口',
  );
});

test('撰稿人未指定标题数量时默认3个，显式越界数量在调用模型前拒绝', () => {
  const defaultResult = compileContentEmployeeSoloPrompt(3, {
    direction: '写一篇经营复盘初稿',
    industry: '餐饮',
    material: '提供完整正文、标签和配图建议。',
    feedback: '',
    length: 'std',
  });
  assert.match(defaultResult.systemPrompt, /无明确数量时默认 3 个/u);

  assert.throws(
    () => compileContentEmployeeSoloPrompt(3, {
      direction: '写一篇经营复盘初稿',
      industry: '餐饮',
      material: '请给8个标题，正文、标签和配图建议也要完整。',
      feedback: '',
      length: 'std',
    }),
    error => (
      error instanceof ContentEmployeeWorkbenchInputError
      && /明确要求8个标题.*岗位契约仅允许3-5个.*当前任务无法执行/u.test(error.message)
    ),
  );

  const negatedResult = compileContentEmployeeSoloPrompt(3, {
    direction: '写一篇经营复盘初稿',
    industry: '餐饮',
    material: '不要给5个标题，按岗位默认数量交付正文、标签和配图建议。',
    feedback: '',
    length: 'std',
  });
  assert.match(negatedResult.systemPrompt, /无明确数量时默认 3 个/u);
  assert.doesNotMatch(negatedResult.systemPrompt, /明确要求 5 个/u);

  for (const material of [
    '不要只给3个标题，多给几个；正文和配图建议保持完整。',
    '不要恰好给3个标题，请根据内容需要在岗位范围内安排。',
    '别只写三个标题，正文、标签和配图建议也要交付。',
  ]) {
    const negatedScope = compileContentEmployeeSoloPrompt(3, {
      direction: '写一篇经营复盘初稿',
      industry: '餐饮',
      material,
      feedback: '',
      length: 'std',
    });
    assert.match(negatedScope.systemPrompt, /无明确数量时默认 3 个/u, material);
    assert.doesNotMatch(negatedScope.systemPrompt, /明确要求 3 个/u, material);
  }

  const historicalFeedback = compileContentEmployeeSoloPrompt(3, {
    direction: '复核标题数量反馈',
    industry: '餐饮',
    material: '请给3个标题',
    feedback: '上次让你给3个标题，这次不要只给3个标题。',
    length: 'std',
  });
  assert.match(historicalFeedback.systemPrompt, /无明确数量时默认 3 个/u);
  assert.doesNotMatch(historicalFeedback.systemPrompt, /明确要求 3 个/u);
});

test('撰稿人出厂默认使用gpt-5.5，企业显式模型覆盖继续生效', () => {
  const employee = CONTENT_EMPLOYEES[3];
  const profile = buildContentEmployeeWorkbenchProfile(3);
  assert.equal(employee.key, 'draft');
  assert.equal(employee.defaultWorkConfig.common.textModel, 'gpt-5.5');
  assert.equal(profile.workConfig.factoryDefault.common.textModel, 'gpt-5.5');
  assert.equal(resolveContentEmployeeWorkConfig(3).textModel, 'gpt-5.5');
  assert.equal(resolveContentEmployeeWorkConfig(3, {
    textModel: 'deepseek-v4-flash',
  }).textModel, 'deepseek-v4-flash');
});

test('复盘官技能进入system供主动运用，之后追加当前事实核验覆盖层', () => {
  const result = compileContentEmployeeSoloPrompt(9, {
    direction: '复盘本周内容效果与下轮迭代',
    industry: '餐饮实体门店',
    material: '未提供真实发布记录、效果指标、历史基线或已核验来源。',
    feedback: '缺数据时只输出采集和验证计划。',
    length: 'std',
  });
  const history = result.snapshot.skillLibrary.historical;
  assert.equal(history.length, 6);
  assert.ok(history.every(skill => typeof skill.detail === 'string' && skill.detail.length > 0));
  assert.match(JSON.stringify(history), /40%|30%|0\.62|4\.1倍/u);

  assert.match(result.systemPrompt, /【你的进修技能库\(全网收集的最新打法,本次工作要主动运用\)】/u);
  const injected = history.filter(skill => result.systemPrompt.includes(`【${skill.title}】`));
  assert.ok(injected.length >= 1, '复盘官至少要主动运用一张历史技能卡');
  for (const skill of injected) {
    assert.ok(result.systemPrompt.includes(skill.detail), skill.title);
    assert.equal(result.systemPrompt.includes(skill.contentFingerprint), false, skill.title);
  }
  const overlayOffset = result.systemPrompt.indexOf(
    '派活源定义与历史技能的当前事实核验安全覆盖层',
  );
  assert.ok(overlayOffset > result.systemPrompt.indexOf('【内部岗位执行模板】'));
  assert.match(result.systemPrompt.slice(overlayOffset), /平台规则.*不是当前事实/su);
  assert.match(result.systemPrompt.slice(overlayOffset), /技能卡只提供做法.*不是当前事实来源/su);
  assert.match(result.systemPrompt.slice(overlayOffset), /无真实发布记录.*发布后复盘计划.*T\+1\/T\+3\/T\+7/su);
});

test('10名内容员工拥有逐工位派活话术，不再共用餐饮成本占位示例', () => {
  const guidance = CONTENT_EMPLOYEES.map(employee => (
    buildContentEmployeeWorkbenchProfile(employee.idx).dispatch.guidance
  ));
  assert.equal(new Set(guidance.map(item => item.titlePlaceholder)).size, 10);
  assert.ok(guidance.every(item => !item.titlePlaceholder.includes('本月食材成本上涨')));
  assert.match(guidance[0].intro, /当前热点.*行业变化.*账号人设.*内容目标/u);
  assert.doesNotMatch(guidance[0].intro, /通用占位题|不负责/u);
  assert.match(guidance[0].taskExamples.join(' '), /热点|选题|趋势/u);
  assert.match(guidance[1].taskExamples.join(' '), /核验|资料|事实/u);
  assert.match(guidance[2].taskExamples.join(' '), /爆款|样本|差异/u);
  assert.match(guidance[3].taskExamples.join(' '), /写|正文|初稿/u);
  assert.match(guidance[4].taskExamples.join(' '), /人设|语气|改写/u);
  assert.match(guidance[5].taskExamples.join(' '), /配图|视频|素材/u);
  assert.match(guidance[6].taskExamples.join(' '), /封面|标题/u);
  assert.match(guidance[7].taskExamples.join(' '), /HTML|演绎|长页/u);
  assert.match(guidance[8].taskExamples.join(' '), /发布|平台|终审/u);
  assert.match(guidance[9].taskExamples.join(' '), /复盘|数据|迭代/u);
});

test('10名员工的独立派活提示词逐人完整、互不串岗且快照可复核', () => {
  const compiled = CONTENT_EMPLOYEES.map(employee => (
    compileContentEmployeeSoloPrompt(employee.idx, taskFor(employee))
  ));
  assert.equal(new Set(compiled.map(item => item.promptHash)).size, 10);

  for (const [order, employee] of CONTENT_EMPLOYEES.entries()) {
    const result = compiled[order];
    const history = EMPLOYEE_SKILL_PROFILES.find(item => item.idx === employee.idx);

    assert.match(result.promptHash, /^[a-f0-9]{64}$/);
    assert.ok(result.prompt.includes(`岗位编号：${employee.idx}`));
    assert.ok(result.prompt.includes(`岗位名称：${employee.name}`));
    assert.ok(result.prompt.includes(`岗位 Skill：${employee.skill}`));
    assert.ok(
      result.systemPrompt.includes(rewriteRoleTemplateRefs(employee.soloPrompt.template)),
      `${employee.name}缺单独派活执行模板`,
    );
    assert.ok(result.prompt.includes('内部产出通过岗位质量门与账务结算后'));
    assert.ok(result.prompt.includes('老板执行授权'));
    assert.equal(result.snapshot.workMethod.approval.code, 'central_auto');
    assert.ok(result.prompt.includes('当前岗位最终输出契约'));
    assert.ok(result.prompt.includes(employee.outputSchema.contract));
    assert.ok(employee.outputKeys.every(key => result.prompt.includes(key)));
    assert.match(result.systemPrompt, /【你的多项工作能力\(本次工作逐项运用,产出要能看出每项的痕迹\)】/u);
    assert.match(result.systemPrompt, /【你的进修技能库\(全网收集的最新打法,本次工作要主动运用\)】/u);
    assert.match(result.systemPrompt, /技能卡只提供做法.*不是当前事实来源/su);
    assert.equal(result.snapshot.identity.idx, employee.idx);
    assert.equal(result.snapshot.identity.key, employee.key);
    assert.equal(result.snapshot.promptHash, result.promptHash);
    assert.equal(result.snapshot.capabilities.length, employee.capabilities.length);
    assert.equal(result.snapshot.skillLibrary.historical.length, history.expectedSkillCount);
    assert.equal(
      compileContentEmployeeSoloPrompt(employee.idx, taskFor(employee)).promptHash,
      result.promptHash,
      `${employee.name}相同输入必须得到确定性哈希`,
    );
    for (const other of CONTENT_EMPLOYEES.filter(item => item.idx !== employee.idx)) {
      assert.equal(
        result.prompt.includes(`岗位编号：${other.idx}\n岗位键：${other.key}`),
        false,
        `${employee.name}不得串入${other.name}身份`,
      );
    }

    for (const capability of employee.capabilities) {
      assert.ok(result.prompt.includes(capability.name), `${employee.name}缺能力标题：${capability.name}`);
      assert.ok(result.prompt.includes(capability.desc), `${employee.name}缺能力详情：${capability.name}`);
      assert.equal(
        result.systemPrompt.includes(JSON.stringify(capability.sourceDefinition)),
        false,
        `${employee.name}能力源JSON不应当作指令：${capability.name}`,
      );
      assert.equal(
        result.systemPrompt.includes(capability.sourceFingerprint),
        false,
        `${employee.name}能力指纹不应当作指令：${capability.name}`,
      );
      assert.ok(result.snapshot.capabilities.some(item => item.name === capability.name));
      assert.equal(
        result.snapshot.capabilities.find(item => item.name === capability.name).sourceFingerprint,
        capability.sourceFingerprint,
      );
    }
    assert.equal(
      result.snapshot.prompts.pipelinePrompt.sourceTemplate,
      employee.pipelinePrompt.sourceTemplate,
    );
    assert.equal(
      result.snapshot.prompts.pipelinePrompt.sourceFingerprint,
      employee.pipelinePrompt.sourceFingerprint,
    );
    const injectedSkills = history.skills.filter(skill => (
      result.systemPrompt.includes(`【${skill.title}】`)
    ));
    assert.ok(injectedSkills.length >= 1, `${employee.name}至少要主动运用一张历史技能`);
    assert.ok(injectedSkills.length <= 12, `${employee.name}技能注入不得超过派活12条上限`);
    for (const skill of history.skills) {
      const snapshotSkill = result.snapshot.skillLibrary.historical
        .find(item => item.title === skill.title);
      assert.equal(snapshotSkill.detail, skill.detail, `${employee.name}快照必须保留历史技能原文`);
      assert.equal(snapshotSkill.contentFingerprint, skill.contentFingerprint);
      assert.equal(result.systemPrompt.includes(skill.contentFingerprint), false);
    }
    for (const skill of injectedSkills) {
      assert.ok(result.systemPrompt.includes(skill.detail), `${employee.name}缺已选技能详情：${skill.title}`);
    }
    const safetyOverlay = result.systemPrompt.indexOf(
      '派活源定义与历史技能的当前事实核验安全覆盖层',
    );
    assert.ok(
      safetyOverlay > result.systemPrompt.indexOf('【内部岗位执行模板】'),
      `${employee.name}安全覆盖层必须追加在执行模板之后`,
    );
  }
});

test('内容流水线system按派活build_prompt分层：能力逐项运用、技能主动运用、执行模板，不把完整档案JSON当指令', () => {
  for (const employee of CONTENT_EMPLOYEES) {
    const result = compileContentEmployeeSoloPrompt(employee.idx, taskFor(employee), {
      executionMode: 'pipeline',
    });
    const rewrittenPipeline = rewriteRoleTemplateRefs(employee.pipelinePrompt.template);
    assert.equal(result.executionMode, 'pipeline', employee.name);
    assert.match(result.systemPrompt, /本次是 0→9 流水线工位/u);
    assert.match(result.systemPrompt, /【你的多项工作能力\(本次工作逐项运用,产出要能看出每项的痕迹\)】/u);
    assert.match(result.systemPrompt, /【你的进修技能库\(全网收集的最新打法,本次工作要主动运用\)】/u);
    assert.ok(result.systemPrompt.includes('【内部岗位执行模板】'));
    assert.ok(
      result.systemPrompt.includes(rewrittenPipeline),
      `${employee.name}流水线必须装入改写后的岗位执行模板`,
    );
    assert.equal(
      result.systemPrompt.includes(JSON.stringify(result.snapshot.canonicalProfile)),
      false,
      employee.name,
    );
    for (const capability of employee.capabilities) {
      assert.ok(result.systemPrompt.includes(`- ${capability.name}:${capability.desc}`), capability.name);
    }
    assert.ok(Array.isArray(result.sensitive));
    assert.ok(result.sensitive.some(item => String(item).includes(employee.duty)));
  }
});

test('演绎师继续以HTML为主能力，PPT仅为附加connector', () => {
  const profile = buildContentEmployeeWorkbenchProfile(7);
  const result = compileContentEmployeeSoloPrompt(7, taskFor(CONTENT_EMPLOYEES[7]));
  assert.equal(profile.jobProfile.outputSchema.primaryArtifact, 'html');
  assert.ok(profile.jobProfile.connectorPolicy.connectors.some(item => (
    item.kind === 'html' && item.primary === true && item.addon === false
  )));
  assert.ok(profile.jobProfile.connectorPolicy.connectors.some(item => (
    item.kind === 'ppt' && item.primary === false && item.addon === true
  )));
  assert.ok(result.prompt.includes('"kind":"html"'));
  assert.ok(result.prompt.includes('"kind":"ppt"'));
});

test('专用连接器执行上下文保留完整岗位能力并追加企业覆盖，不再只贴员工元数据', () => {
  const employee = CONTENT_EMPLOYEES[3];
  const tenantOverlay = {
    revision: 7,
    workConfig: {
      textModel: 'tenant-copy-model',
      outputLength: 'full',
      approvalMode: '老板审核',
      timeoutSeconds: 180,
    },
    promptOverride: 'A店补充：只使用本店已书面确认的菜品、价格和库存。',
    customSkills: [
      {
        id: 'content-custom:3:a',
        title: 'A店菜品事实核验',
        detail: '逐项核对菜名、价格、库存和活动时间。',
        source: 'A店内容SOP',
        enabled: true,
      },
      {
        id: 'content-custom:3:disabled',
        title: '已停用旧技能',
        detail: '本次不得进入有效提示词。',
        source: '旧SOP',
        enabled: false,
      },
    ],
  };
  const result = buildContentEmployeeConnectorExecution(3, taskFor(employee), {
    connectorKind: 'copy',
    connectorContract: {
      name: 'copy-text',
      outputFormat: 'text/markdown',
      instruction: '只输出本次文案连接器需要的可审阅正文。',
    },
    tenantOverlay,
  });

  assert.equal(result.profileVersion, 'content-3-r7');
  assert.match(result.promptHash, /^[a-f0-9]{64}$/u);
  assert.equal(result.connector.kind, 'copy');
  assert.equal(result.connector.primary, true);
  assert.equal(result.connector.addon, false);
  assert.equal(result.config.textModel, 'tenant-copy-model');
  assert.equal(result.config.outputLength, 'full');
  assert.equal(result.config.timeoutSeconds, 180);
  assert.match(result.prompt, /A店补充：只使用本店已书面确认/u);
  assert.match(result.prompt, /A店菜品事实核验.*逐项核对菜名/u);
  assert.doesNotMatch(result.prompt, /已停用旧技能/u);
  assert.match(result.prompt, /本次专用连接器输出契约/u);
  assert.match(result.prompt, /只输出本次文案连接器需要的可审阅正文/u);
  assert.match(result.prompt, /不得绕过.*老板执行授权/u);
  for (const capability of employee.capabilities) {
    assert.match(result.prompt, new RegExp(capability.name, 'u'));
    assert.match(result.prompt, new RegExp(capability.desc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
  }
  for (const skill of result.profile.skillLibrary.defaultInjected) {
    assert.ok(result.prompt.includes(skill.title), skill.title);
    assert.ok(result.prompt.includes(skill.detail), skill.title);
  }
  assert.equal(result.snapshot.identity.idx, 3);
  assert.equal(result.snapshot.capabilities.length, employee.capabilities.length);
  assert.equal(result.snapshot.enterpriseOverlay.revision, 7);
  assert.equal(result.snapshot.enterpriseOverlay.customSkills.length, 2);
  assert.equal(result.snapshot.enterpriseOverlay.enabledCustomSkillCount, 1);
  assert.equal(result.snapshot.enterpriseOverlay.promptOverrideAppended, true);
  assert.equal(result.snapshot.enterpriseOverlay.promptTextStored, false);
  assert.equal(result.snapshot.connector.kind, 'copy');
  assert.equal(result.snapshot.connector.nativePrimaryArtifact, 'markdown');
  assert.equal(
    buildContentEmployeeConnectorExecution(3, taskFor(employee), {
      connectorKind: 'copy',
      connectorContract: {
        name: 'copy-text',
        outputFormat: 'text/markdown',
        instruction: '只输出本次文案连接器需要的可审阅正文。',
      },
      tenantOverlay,
    }).promptHash,
    result.promptHash,
  );
});

test('专用连接器按租户覆盖隔离且PPT明确只是演绎师HTML主能力之上的addon', () => {
  const task = taskFor(CONTENT_EMPLOYEES[7]);
  const baseOptions = {
    connectorKind: 'ppt',
    connectorContract: {
      name: 'ppt-deck-json',
      outputFormat: 'application/json',
      instruction: '输出PPT页结构JSON。',
    },
  };
  const tenantA = buildContentEmployeeConnectorExecution(7, task, {
    ...baseOptions,
    tenantOverlay: {
      revision: 2,
      workConfig: { outputLength: 'full' },
      promptOverride: 'A企业专属演绎规范',
      customSkills: [{ title: 'A企业演绎技能', detail: '只在A企业使用', source: 'A企业', enabled: true }],
    },
  });
  const tenantB = buildContentEmployeeConnectorExecution(7, task, {
    ...baseOptions,
    tenantOverlay: {
      revision: 4,
      workConfig: { outputLength: 'lite' },
      promptOverride: 'B企业秘密演绎规范',
      customSkills: [{ title: 'B企业私有技能', detail: '不得进入A企业', source: 'B企业', enabled: true }],
    },
  });

  assert.notEqual(tenantA.promptHash, tenantB.promptHash);
  assert.match(tenantA.prompt, /A企业专属演绎规范/u);
  assert.doesNotMatch(tenantA.prompt, /B企业秘密演绎规范|B企业私有技能/u);
  assert.equal(tenantA.connector.kind, 'ppt');
  assert.equal(tenantA.connector.primary, false);
  assert.equal(tenantA.connector.addon, true);
  assert.equal(tenantA.snapshot.connector.nativePrimaryArtifact, 'html');
  assert.match(tenantA.prompt, /HTML.*主产物.*PPT.*附加/u);
  assert.throws(
    () => buildContentEmployeeConnectorExecution(7, task, {
      ...baseOptions,
      connectorKind: 'copy',
      tenantOverlay: {},
    }),
    /不支持连接器/u,
  );
});

test('日更包子任务独立结算并明确返回partial或failed，不吞掉失败', async () => {
  const parts = [
    { type: '短视频脚本', count: 3 },
    { type: '朋友圈文案', count: 5 },
    { type: '社群话题', count: 3 },
  ];
  const mixed = await executeContentDailyPackParts(parts, async part => {
    if (part.type === '朋友圈文案') throw new Error('朋友圈模型超时');
    return { type: part.type, count: part.count, id: part.count };
  });
  assert.equal(mixed.status, 'partial');
  assert.deepEqual(mixed.successes.map(item => item.type), ['短视频脚本', '社群话题']);
  assert.deepEqual(mixed.failures, [
    { type: '朋友圈文案', count: 5, error: '朋友圈模型超时' },
  ]);

  const failed = await executeContentDailyPackParts(parts, async part => {
    throw new Error(`${part.type}不可用`);
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.successes.length, 0);
  assert.equal(failed.failures.length, 3);
  assert.match(failed.failures[0].error, /不可用/u);
});

test('日更包执行器默认串行，显式并发2时最大在途2且结果按输入顺序返回', async () => {
  const parts = [
    { type: 'A', count: 1, delay: 35 },
    { type: 'B', count: 2, delay: 4 },
    { type: 'C', count: 3, delay: 12 },
    { type: 'D', count: 4, delay: 1 },
  ];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  let serialInFlight = 0;
  let serialPeak = 0;
  await executeContentDailyPackParts(parts, async part => {
    serialInFlight += 1;
    serialPeak = Math.max(serialPeak, serialInFlight);
    try {
      await sleep(1);
      return { type: part.type, count: part.count };
    } finally {
      serialInFlight -= 1;
    }
  });
  assert.equal(serialPeak, 1, '未显式传并发度时必须保持旧的串行语义');

  let inFlight = 0;
  let peak = 0;
  const completionOrder = [];
  const concurrent = await executeContentDailyPackParts(
    parts,
    async part => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await sleep(part.delay);
        completionOrder.push(part.type);
        if (part.type === 'B') {
          const error = new Error('B上游失败');
          error.billing = { state: 'released', chargedCredits: 0 };
          throw error;
        }
        return { type: part.type, count: part.count };
      } finally {
        inFlight -= 1;
      }
    },
    { concurrency: 2 },
  );

  assert.equal(peak, 2);
  assert.notDeepEqual(completionOrder, ['A', 'B', 'C', 'D'], '用例必须确实造成乱序完成');
  assert.deepEqual(concurrent.successes.map(item => item.type), ['A', 'C', 'D']);
  assert.deepEqual(concurrent.failures.map(item => item.type), ['B']);
  assert.equal(concurrent.failures[0].billing.state, 'released');
  assert.equal(concurrent.status, 'partial');
});

test('任务输入逐字段限长限型，模板与敏感占位符保持原文且不读取环境值', () => {
  const sensitive = '{tenant_company_profile_and_knowledge} / ${OPENAI_API_KEY} / {{api_key}}';
  const secret = 'SHOULD_NEVER_BE_EXPANDED_BY_STATIC_COMPILER';
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = secret;
  try {
    const result = compileContentEmployeeSoloPrompt(0, {
      ...taskFor(CONTENT_EMPLOYEES[0]),
      material: sensitive,
    });
    assert.ok(result.prompt.includes(sensitive));
    assert.ok(result.prompt.includes('{tenant_company_profile_and_knowledge}'));
    assert.equal(result.prompt.includes(secret), false);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }

  const invalidCases = [
    () => buildContentEmployeeWorkbenchProfile('0'),
    () => buildContentEmployeeWorkbenchProfile(11),
    () => compileContentEmployeeSoloPrompt(0, null),
    () => compileContentEmployeeSoloPrompt(0, new Date()),
    () => compileContentEmployeeSoloPrompt(0, { direction: '' }),
    () => compileContentEmployeeSoloPrompt(0, { direction: 42 }),
    () => compileContentEmployeeSoloPrompt(0, { direction: '任务', industry: [] }),
    () => compileContentEmployeeSoloPrompt(0, { direction: '任务', material: {} }),
    () => compileContentEmployeeSoloPrompt(0, { direction: '任务', feedback: false }),
    () => compileContentEmployeeSoloPrompt(0, { direction: '任务', length: '无限' }),
    () => compileContentEmployeeSoloPrompt(0, { direction: '任务', unknown: '不允许' }),
    () => compileContentEmployeeSoloPrompt(0, {
      direction: 'x'.repeat(CONTENT_EMPLOYEE_TASK_LIMITS.direction + 1),
    }),
  ];
  for (const invalid of invalidCases) {
    assert.throws(invalid, ContentEmployeeWorkbenchInputError);
  }
});
