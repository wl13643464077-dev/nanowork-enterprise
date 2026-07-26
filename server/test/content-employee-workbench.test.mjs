import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTENT_EMPLOYEES,
  EMPLOYEE_SKILL_PROFILES,
} from '../src/catalog/content-crew.js';
import {
  CONTENT_EMPLOYEE_TASK_LIMITS,
  ContentEmployeeWorkbenchInputError,
  buildContentEmployeeConnectorExecution,
  buildContentEmployeeWorkbenchProfile,
  compileContentEmployeeSoloPrompt,
  executeContentDailyPackParts,
} from '../src/engines/content-employee-workbench.js';

const taskFor = employee => ({
  direction: `请以${employee.name}岗位完成本次专项任务`,
  industry: '连锁餐饮',
  material: '这是老板提供的任务材料。',
  feedback: '所有假设必须标注，交付前完成自检。',
  length: 'std',
});

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
        'workConfig',
        'jobProfile',
        'dispatch',
        'provenance',
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
    assert.equal(profile.skillLibrary.required[0].verificationStatus, 'factory_required');

    assert.equal(profile.skillLibrary.historical.length, history.expectedSkillCount);
    assert.equal(profile.skillLibrary.defaultInjected.length, history.expectedSkillCount + 1);
    for (const skill of profile.skillLibrary.historical) {
      assert.equal(skill.verificationStatus, 'legacy_unverified');
      assert.equal(skill.defaultInjected, true);
      assert.equal(skill.currentPlatformFact, false);
      assert.equal(skill.locked, true);
    }

    assert.deepEqual(profile.prompts.soloPrompt, employee.soloPrompt);
    assert.deepEqual(profile.prompts.pipelinePrompt, employee.pipelinePrompt);
    assert.deepEqual(profile.workConfig.factoryDefault, employee.defaultWorkConfig);
    assert.deepEqual(profile.dispatch.form, employee.dispatchForm);
    assert.ok(profile.dispatch.guidance);
    assert.match(profile.dispatch.guidance.intro, new RegExp(employee.name, 'u'));
    assert.ok(profile.dispatch.guidance.materialChecklist.length >= 2);
    assert.ok(profile.dispatch.guidance.deliverableChecklist.length >= 2);
    assert.ok(profile.dispatch.guidance.taskExamples.length >= 3);
    assert.deepEqual(profile.jobProfile.outputSchema, employee.outputSchema);
    assert.deepEqual(profile.jobProfile.connectorPolicy, employee.connectorPolicy);
    assert.doesNotMatch(JSON.stringify(profile), /\bV1(?:\.0)?\b/u);
    assert.equal(profile.provenance.employee.legacyIdx, employee.idx);
    assert.equal(profile.provenance.historicalSkills.snapshot.sha256, history.skills[0].sourceSnapshot.sha256);
    assert.ok(Object.isFrozen(profile));
  }
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
    assert.ok(result.prompt.includes(employee.soloPrompt.template));
    assert.ok(result.prompt.includes(employee.workMethod.approval.description));
    assert.ok(result.prompt.includes('当前岗位最终输出契约'));
    assert.ok(result.prompt.includes(employee.outputSchema.contract));
    assert.ok(employee.outputKeys.every(key => result.prompt.includes(key)));
    assert.ok(result.prompt.includes('历史待核验技能不得作为当前平台事实'));
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
      assert.ok(result.snapshot.capabilities.some(item => item.name === capability.name));
    }
    for (const skill of history.skills) {
      assert.ok(result.prompt.includes(skill.title), `${employee.name}缺历史技能标题：${skill.title}`);
      assert.ok(result.prompt.includes(skill.detail), `${employee.name}缺历史技能原文：${skill.title}`);
      assert.ok(result.prompt.includes(skill.source), `${employee.name}缺历史技能来源：${skill.title}`);
      assert.ok(result.snapshot.skillLibrary.historical.some(item => item.title === skill.title));
    }
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
  assert.match(result.prompt, /不得绕过.*人工审批/u);
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
    () => buildContentEmployeeWorkbenchProfile(10),
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
