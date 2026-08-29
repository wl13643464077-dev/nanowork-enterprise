import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Select,
  Skeleton,
  Space,
  Steps,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ApartmentOutlined,
  ApiOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  AudioOutlined,
  BookOutlined,
  CodeOutlined,
  ClockCircleOutlined,
  DownloadOutlined,
  ExperimentOutlined,
  EyeOutlined,
  FileTextOutlined,
  IdcardOutlined,
  InteractionOutlined,
  LockOutlined,
  MessageOutlined,
  PaperClipOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  SendOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, getUser } from '../api/client';
import { refineVoiceIntent, useVoiceInput } from './useVoiceInput';
import type {
  EmployeeCapability,
  EmployeeDispatch,
  EmployeeExecutionProgress,
  EmployeeJobProfile,
  EmployeeRuntimeTask,
  EmployeeRuntimeBindingItem,
  EmployeeRuntimeBindings,
  EmployeeRunBilling,
  EmployeeRunListResponse,
  EmployeeSkillLearningRun,
  EmployeeWorkbenchRun,
  EmployeeSkill,
  EmployeeSkillLibrary,
  EmployeeWorkbenchDomain,
  EmployeeWorkbenchIdentityHint,
  EmployeeWorkbenchProfile,
  EmployeeWorkConfig,
  EmployeeWorkMethod,
  WorkConfigField,
} from '../api/employeeWorkbenchTypes';
import type { ContentEmployeeDispatchFormValues } from '../api/contentProfileTypes';
import { Markdown } from './Markdown';
import { ArtifactActions } from './ArtifactActions';
import ContentEmployeeResult from './ContentEmployeeResult';
import EmployeeExecutionTimeline from './EmployeeExecutionTimeline';
import EmployeeResearchPlan from './EmployeeResearchPlan';
import EmployeeAvatar from './EmployeeAvatar';
import EmployeeEvolution from './EmployeeEvolution';
import EmployeeVisualOverview from './EmployeeVisualOverview';
import BusinessFlowTrace, { type BusinessFlowSourceType } from './BusinessFlowTrace';
import ContentBrandPersonaEditor from './ContentBrandPersonaEditor';
import { UnifiedFilePicker, type UploadedFileRef } from './UnifiedFilePicker';
import { buildPaihuoContentBrief } from './contentBriefForm.js';
import { restaurantOutputPresentation } from './restaurantOutputPresentation.js';
import { buildRestaurantTaskPollWarning, RESTAURANT_TASK_POLL_INTERVAL_MS } from './restaurantTaskPolling.js';
import './EmployeeWorkbench.css';

type Props = {
  open: boolean;
  domain: EmployeeWorkbenchDomain;
  idx: number | null;
  initialRunId?: number | null;
  initialTaskId?: string | number | null;
  // 「一句话找人」等入口带来的派活预填：打开工作台时填进派活输入框，老板可改可删。
  initialDirective?: string | null;
  identityHint?: EmployeeWorkbenchIdentityHint | null;
  onClose: () => void;
};

type MutationName = 'prompt' | 'config' | 'skills';

type RestaurantTaskPollWarning = ReturnType<typeof buildRestaurantTaskPollWarning> & {
  taskId: string;
};

type DispatchFormValues = Partial<ContentEmployeeDispatchFormValues> & {
  question?: string;
  goal?: string;
  materials?: string;
};

type EmployeeSourceDeliverable = {
  id: number;
  title?: string;
  format?: string;
  label?: string;
  mime?: string;
  fileName?: string;
  size?: number;
  status?: string;
  downloadUrl?: string;
};

const EMPTY_PROFILE_PARTS = {
  capabilities: [],
  workMethod: {},
  skillLibrary: {},
  prompts: {},
  workConfig: {},
  jobProfile: {},
  runtimeBindings: {},
  runtime: {},
  dispatch: {},
  permissions: {},
  provenance: {},
};

function normalizeProfile(data: unknown): EmployeeWorkbenchProfile {
  const wrapped = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const raw =
    wrapped.profile && typeof wrapped.profile === 'object' ? (wrapped.profile as Record<string, unknown>) : wrapped;
  if (!raw.identity || typeof raw.identity !== 'object') throw new Error('员工工作台接口缺少 identity');
  const identity = raw.identity as Record<string, unknown>;
  if (!Number.isInteger(Number(identity.idx)) || typeof identity.name !== 'string' || !identity.name.trim()) {
    throw new Error('员工工作台返回的身份信息不完整');
  }
  return {
    ...EMPTY_PROFILE_PARTS,
    ...raw,
    identity: { ...identity, idx: Number(identity.idx) },
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities : [],
    workMethod: objectOrEmpty(raw.workMethod),
    skillLibrary: objectOrEmpty(raw.skillLibrary),
    prompts: objectOrEmpty(raw.prompts),
    workConfig: objectOrEmpty(raw.workConfig),
    jobProfile: objectOrEmpty(raw.jobProfile),
    runtimeBindings: objectOrEmpty(raw.runtimeBindings),
    runtime: objectOrEmpty(raw.runtime),
    dispatch: objectOrEmpty(raw.dispatch),
    permissions: objectOrEmpty(raw.permissions),
    provenance: objectOrEmpty(raw.provenance),
  } as EmployeeWorkbenchProfile;
}

function objectOrEmpty<T extends object>(value: unknown): T {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : ({} as T);
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

// 权威对象里的能力名/说明可能带 Markdown 记号（**加粗**、`代码`）；
// 展示层只做去记号，不改动权威数据本身。
function plainDisplayText(value: unknown) {
  return String(value ?? '')
    .replace(/\*\*|__|[*`#]/gu, '')
    .trim();
}

const RUN_STATUS_COLOR: Record<string, string> = {
  生成中: 'processing',
  待派活: 'default',
  待人工审阅: 'gold',
  '可验收（待提交人工审阅）': 'gold',
  '业务暂不可采用（待账务对账）': 'orange',
  '已自动采用（可用于业务）': 'green',
  '已人工采纳（可用于业务）': 'green',
  待处理: 'default',
  已发布: 'green',
  '历史失败（后续已修复）': 'blue',
  '失败需处理（执行异常）': 'red',
  '失败需返工（质检未通过）': 'red',
  '失败需返工（人工审阅未通过）': 'red',
};

const DISPATCH_GUIDE_PREFERENCE_VERSION = 'v1';

function safeLocalStorageGet(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 隐私模式或存储不可用时只影响展示偏好，不影响派活。
  }
}

function isTaskRunning(status: unknown) {
  return text(status) === '生成中';
}

function canonicalDisplayStatus(value: unknown, completedLabel = '已自动采用（可用于业务）') {
  const raw = text(value);
  const labels: Record<string, string> = {
    失败: '失败需处理（执行异常）',
    待审阅: '待人工审阅',
    待审核: '待人工审阅',
    预授权待对账: '业务暂不可采用（待账务对账）',
    计费待对账: '业务暂不可采用（待账务对账）',
    待账务对账: '业务暂不可采用（待账务对账）',
    已采纳: '已人工采纳（可用于业务）',
    已通过: '已人工采纳（可用于业务）',
    已完成: completedLabel,
    已驳回: '失败需返工（人工审阅未通过）',
    '生成失败（可重跑）': '失败需处理（执行异常）',
    '执行失败（可重跑）': '失败需处理（执行异常）',
    '质检失败（可重跑）': '失败需返工（质检未通过）',
    '质检未通过（可重跑）': '失败需返工（质检未通过）',
    '审核未通过（可重跑）': '失败需返工（人工审阅未通过）',
    '人工审核未通过（可重跑）': '失败需返工（人工审阅未通过）',
  };
  return labels[raw] || raw;
}

function runStatus(run: EmployeeWorkbenchRun) {
  if (run.remediated === true) return '历史失败（后续已修复）';
  const provided = canonicalDisplayStatus(run.displayStatus);
  if (provided) return provided;
  if (run.status === '失败' || run.aiMode === 'failed') {
    return run.contract?.valid === false ? '失败需返工（质检未通过）' : '失败需处理（执行异常）';
  }
  if (run.status === '生成中') return '生成中';
  if (run.aiMode === 'template' || run.contract?.valid !== true) return '失败需返工（质检未通过）';
  if (run.status === '已驳回') return '失败需返工（人工审阅未通过）';
  if (run.status === '已完成') {
    return run.review?.decision === 'adopt' ? '已人工采纳（可用于业务）' : '已自动采用（可用于业务）';
  }
  return '待处理';
}

function restaurantStatus(task: EmployeeRuntimeTask) {
  const provided = canonicalDisplayStatus(task.displayStatus);
  if (provided) return provided;
  if (task.failed || text(task.status) === '失败') {
    return task.aiMode === 'template' ||
      task.ai_mode === 'template' ||
      task.executionSnapshot?.outputContract?.valid === false
      ? '失败需返工（质检未通过）'
      : '失败需处理（执行异常）';
  }
  if (text(task.status) === '执行中') {
    return task.employee_profile_version || task.internalProfileApplied ? '生成中' : '待派活';
  }
  if (text(task.status) === '生成中') return '生成中';
  if (
    task.aiMode === 'template' ||
    task.ai_mode === 'template' ||
    task.executionSnapshot?.outputContract?.valid === false
  )
    return '失败需返工（质检未通过）';
  if (text(task.status) === '已驳回') return '失败需返工（人工审阅未通过）';
  if (text(task.status) === '已完成') return '已自动采用（可用于业务）';
  return '待处理';
}

function isBusinessUsableStatus(status: string) {
  return ['已自动采用（可用于业务）', '已人工采纳（可用于业务）'].includes(status);
}

const OPERATIONAL_STATUS_LABELS: Record<string, string> = {
  blocked_pending_privileged_review: '待老板或管理员复核',
  draft_pending_human_review: '待人工审阅',
  pending_human_review: '待人工审阅',
  pending_settlement: '待结算',
  pending_release: '待释放预授权',
  pending_reconciliation: '业务暂不可采用（待账务对账）',
  needs_review: '需人工复核',
  compliant: '符合要求',
  blocked: '需补齐业务条件',
  settled: '已结算',
  released: '预授权已释放（已退款）',
  held: '预授权占扣中',
  clear: '无异常',
  pass: '已通过',
  runtime_bound: '已绑定生产运行时',
  required_at_dispatch: '每次派活必用',
  bound_callable: '已绑定可调用处理器',
  reimplemented_verified: '已按派活结构重建并验证',
  current_runtime_reimplementation: '当前项目可执行适配层',
  local_contract_assist: '本地契约工具',
  verified_input_assist: '已验证输入辅助',
  employee_generation: '数字员工云生成',
  single_employee_dispatch: '单员工派活',
  single_station: '单工位执行',
  every_dispatch: '每次派活',
  every_invocation: '每次调用',
  when_task_requires: '任务需要时',
  required: '必须使用',
  allowed: '按需使用',
};

function localizeOperationalStatus(value: unknown) {
  let result = typeof value === 'string' ? value : String(value ?? '');
  for (const [status, label] of Object.entries(OPERATIONAL_STATUS_LABELS).sort(
    ([left], [right]) => right.length - left.length,
  )) {
    result = result.replace(new RegExp(`\\b${status}\\b`, 'gu'), label);
  }
  return result;
}

function billingStateLabel(billing?: EmployeeRunBilling | null, runStatus?: string) {
  const state = text(billing?.state);
  if (state === 'released') return '预授权已释放（已退款）';
  if (state === 'pending_reconciliation') return '待账务对账（业务未放行）';
  if (state === 'held') return runStatus === '生成中' ? '预授权占扣中' : '待账务对账（业务未放行）';
  if (state === 'settled') {
    return billing?.chargedCredits == null ? '积分已结算' : `积分已结算（实扣 ${billing.chargedCredits}）`;
  }
  return state ? localizeOperationalStatus(state) : '';
}

function runTime(value?: string | null) {
  return text(value).replace('T', ' ').slice(0, 16) || '时间未记录';
}

function isWaitingForFirstModelCharacter(progress?: EmployeeExecutionProgress | null) {
  if (!progress || progress.receivedChars !== 0) return false;
  const stage = text(progress.currentStage);
  return !stage || stage === 'generate' || stage === 'repair';
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.map(plainDisplayText).filter(Boolean) : [];
}

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value))
    return localizeOperationalStatus(
      value.map(item => (typeof item === 'object' ? JSON.stringify(item) : String(item))).join('、') || '—',
    );
  if (typeof value === 'object') return localizeOperationalStatus(JSON.stringify(value));
  return localizeOperationalStatus(value);
}

function skillTitle(skill: EmployeeSkill) {
  return text(skill.title) || text(skill.name);
}

function skillDescription(skill: EmployeeSkill) {
  return text(skill.detail) || text(skill.description);
}

function uniqueSkills(skills: EmployeeSkill[]) {
  const seen = new Set<string>();
  return skills.filter(skill => {
    const key = String(skill.id ?? skill.key ?? `${skillTitle(skill)}|${skill.source || ''}`);
    if (!skillTitle(skill) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function splitSkills(library: EmployeeSkillLibrary) {
  const flat = Array.isArray(library.skills) ? library.skills : [];
  const isVerifiedDefaultSkill = (skill: EmployeeSkill) =>
    skill.verificationStatus === 'owner_verified_enabled' ||
    (skill as EmployeeSkill & { legacyVerificationStatus?: string }).legacyVerificationStatus === 'legacy_unverified' ||
    (skill.verificationLevel === 'catalog_contract_verified' && skill.defaultInjected === true);
  const factory = uniqueSkills([
    ...(library.factory || []),
    ...(library.builtIn || []),
    ...(library.factorySkills || []),
    ...(library.required || []),
    ...(library.optional || []).filter(isVerifiedDefaultSkill),
    ...(library.learned || []).filter(isVerifiedDefaultSkill),
    ...(library.optional || []).filter(skill => !isVerifiedDefaultSkill(skill)),
    ...(library.historical || []).filter(isVerifiedDefaultSkill),
    ...(library.pending || []).filter(isVerifiedDefaultSkill),
    ...(library.pendingVerification || []).filter(isVerifiedDefaultSkill),
    ...(library.historicalSkills || []).filter(isVerifiedDefaultSkill),
    ...flat.filter(skill => skill.kind === 'factory'),
    ...flat.filter(isVerifiedDefaultSkill),
  ]);
  const learned = uniqueSkills([
    ...(library.learned || []).filter(skill => skill.origin === 'learned' || skill.kind === 'learned'),
    ...flat.filter(skill => skill.origin === 'learned' || skill.kind === 'learned'),
  ]);
  const learnedIds = new Set(learned.map(skill => String(skill.id ?? skill.key ?? skillTitle(skill))));
  const custom = uniqueSkills([
    ...(library.custom || []),
    ...(library.customSkills || []),
    ...(library.learned || []).filter(skill => !isVerifiedDefaultSkill(skill) && skill.origin !== 'learned'),
    ...flat.filter(skill => skill.kind === 'custom'),
  ]).filter(skill => !learnedIds.has(String(skill.id ?? skill.key ?? skillTitle(skill))));
  // 保留 historical 数据键以兼容旧接口，产品界面统一呈现已验证技能。
  return { factory, historical: [], learned, custom };
}

function departmentName(identity: EmployeeWorkbenchProfile['identity']) {
  return typeof identity.department === 'string' ? identity.department : text(identity.department?.name);
}

function identityColor(identity: EmployeeWorkbenchProfile['identity'] | EmployeeWorkbenchIdentityHint) {
  if (identity.color) return identity.color;
  const department = 'department' in identity ? identity.department : null;
  return department && typeof department === 'object' ? text(department.color) : '';
}

function SectionHeading({ title, description, extra }: { title: string; description: string; extra?: ReactNode }) {
  return (
    <div className="ewb-section-heading">
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {extra}
    </div>
  );
}

function HonestEmpty({ description }: { description: string }) {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={description} />;
}

function LockedCapabilities({ capabilities }: { capabilities: EmployeeCapability[] }) {
  const visible = capabilities.filter(capability => plainDisplayText(capability.name));
  if (!visible.length) return <HonestEmpty description="接口没有返回这名员工的能力清单" />;
  return (
    <div className="ewb-capabilities">
      {visible.map((capability, index) => {
        const displayName = plainDisplayText(capability.name);
        const required = capability.required !== false;
        return (
          <article
            className="ewb-capability"
            aria-label={`${displayName}，${required ? '岗位必备能力' : '附加能力'}`}
            key={capability.id || capability.key || `${displayName}-${index}`}
          >
            <span className="ewb-capability-icon" aria-hidden>
              <ThunderboltOutlined />
            </span>
            <div className="ewb-card-copy">
              <strong>{displayName}</strong>
              <p>
                {plainDisplayText(capability.description) || plainDisplayText(capability.desc) || '接口未提供能力说明'}
              </p>
              <div className="ewb-card-meta">
                <Tag color={required ? 'blue' : 'default'} icon={required ? <LockOutlined /> : undefined}>
                  {required
                    ? '岗位必备 · 始终启用'
                    : capability.enabled === false
                      ? '附加能力 · 当前未启用'
                      : '附加能力 · 当前启用'}
                </Tag>
                {capability.source && <Tag>{capability.source}</Tag>}
              </div>
            </div>
            {required ? (
              <Tag color="success" icon={<LockOutlined />} aria-label={`${displayName}由岗位锁定且每次执行必定加载`}>
                执行时必定加载
              </Tag>
            ) : (
              <Tag color={capability.enabled === false ? 'default' : 'success'}>
                {capability.enabled === false ? '本次不加载' : '本次加载'}
              </Tag>
            )}
          </article>
        );
      })}
    </div>
  );
}

function WorkMethodTab({ method }: { method: EmployeeWorkMethod }) {
  const inputs = stringList(method.inputs || method.requiredInputs);
  const steps = stringList(method.steps);
  const deliverables = stringList(method.deliverables);
  const hasFlow = inputs.length || steps.length || deliverables.length;
  return (
    <div className="ewb-section">
      <SectionHeading
        title="工作方式"
        description="您只需写清要解决的问题；岗位会自行补齐公开信息并调用技能、知识库和联网工具，内部资料有则按需补充。"
      />
      <Alert
        type="info"
        showIcon
        message="一句话即可派活"
        description="公开的地点、竞品、地图、评价、平台规则与实时信息由系统自行联网获取；照片、交易、排班等企业内部资料没有也能先开工，有则会让结果更准确。"
      />
      {!hasFlow ? (
        <HonestEmpty description="接口没有返回这名员工的工作方式" />
      ) : (
        <div className="ewb-flow" aria-label="员工工作流程">
          <div className="ewb-flow-node">
            <h4>
              <ArrowDownOutlined /> 系统自行补齐与核验（内部资料缺失不阻塞开工）
            </h4>
            {inputs.length ? (
              <ul>
                {inputs.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            ) : (
              <HonestEmpty description="未配置额外信息清单，仍可直接一句话派活" />
            )}
          </div>
          <div className="ewb-flow-arrow" aria-hidden>
            →
          </div>
          <div className="ewb-flow-node primary">
            <h4>
              <InteractionOutlined /> 完整工作流
            </h4>
            {steps.length ? (
              <ol>
                {steps.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ol>
            ) : (
              <HonestEmpty description="未配置工作步骤" />
            )}
          </div>
          <div className="ewb-flow-arrow" aria-hidden>
            →
          </div>
          <div className="ewb-flow-node">
            <h4>
              <ArrowUpOutlined /> 最终交付
            </h4>
            {deliverables.length ? (
              <ul>
                {deliverables.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            ) : (
              <HonestEmpty description="未配置交付物" />
            )}
          </div>
        </div>
      )}
      {(method.approval || method.qualityGate || method.qualityGates?.length || method.handoff) && (
        <div className="ewb-method-meta">
          {method.approval && (
            <div>
              <span>放行方式</span>
              <strong>{method.approval}</strong>
            </div>
          )}
          {(method.qualityGate || method.qualityGates?.length) && (
            <div>
              <span>质量关卡</span>
              <strong>{method.qualityGate || method.qualityGates?.join('；')}</strong>
            </div>
          )}
          {method.handoff && (
            <div>
              <span>交棒方式</span>
              <strong>{method.handoff}</strong>
            </div>
          )}
        </div>
      )}
      {!!method.safetyBoundaries?.length && (
        <Alert type="warning" showIcon message="岗位安全边界" description={method.safetyBoundaries.join('；')} />
      )}
      {method.executionBoundary && <Alert type="info" showIcon message={method.executionBoundary} />}
      {method.manualMarkdown && (
        <details className="ewb-raw-details">
          <summary>查看完整岗位工作手册</summary>
          <pre className="ewb-codebox">{method.manualMarkdown}</pre>
        </details>
      )}
      {method.raw !== undefined && (
        <details className="ewb-raw-details">
          <summary>查看原始工作方式配置</summary>
          <pre className="ewb-codebox">{JSON.stringify(method.raw, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

function runtimeBindingTitle(item: EmployeeRuntimeBindingItem, fallback: string) {
  return text(item.id) || text(item.kind) || fallback;
}

function RuntimeBindingCard({
  item,
  fallback,
  icon,
}: {
  item: EmployeeRuntimeBindingItem;
  fallback: string;
  icon: ReactNode;
}) {
  const binding =
    text(item.businessEndpoint) ||
    text(item.endpoint) ||
    text(item.route) ||
    text(item.binding) ||
    text(item.handler) ||
    text(item.legacyHandler);
  const legacyHandler = text(item.legacyHandler);
  return (
    <article className="ewb-runtime-card">
      <span className="ewb-capability-icon">{icon}</span>
      <div className="ewb-card-copy">
        <strong>{runtimeBindingTitle(item, fallback)}</strong>
        <p>{binding || '后端已登记，但未返回可审计的调用绑定'}</p>
        {legacyHandler && legacyHandler !== binding && (
          <code className="ewb-runtime-code">派活原 handler：{legacyHandler}</code>
        )}
        <div className="ewb-card-meta">
          {item.status && (
            <Tag color={item.status === 'runtime_bound' ? 'success' : 'blue'}>
              {localizeOperationalStatus(item.status)}
            </Tag>
          )}
          {item.mode && <Tag>{localizeOperationalStatus(item.mode)}</Tag>}
          {item.invocation && <Tag>{localizeOperationalStatus(item.invocation)}</Tag>}
          {item.required === true && <Tag color="success">每次执行必加载</Tag>}
          {item.primary === true && <Tag color="blue">主连接器</Tag>}
          {item.addon === true && <Tag>附加连接器</Tag>}
        </div>
      </div>
    </article>
  );
}

function RuntimeBindingGroup({
  title,
  items,
  empty,
}: {
  title: string;
  items: EmployeeRuntimeBindingItem[];
  empty: string;
}) {
  return (
    <section className="ewb-runtime-group">
      <h4>{title}</h4>
      {items.length ? (
        <div className="ewb-runtime-grid">
          {items.map((item, index) => (
            <RuntimeBindingCard
              key={`${runtimeBindingTitle(item, title)}-${index}`}
              item={item}
              fallback={`${title} ${index + 1}`}
              icon={<ApiOutlined />}
            />
          ))}
        </div>
      ) : (
        <HonestEmpty description={empty} />
      )}
    </section>
  );
}

function RuntimeBindingsTab({ bindings }: { bindings: EmployeeRuntimeBindings }) {
  const current = objectOrEmpty<EmployeeRuntimeBindings>(bindings.currentRuntimeBindings || bindings);
  const source = objectOrEmpty<NonNullable<EmployeeRuntimeBindings['sourceBindings']>>(bindings.sourceBindings);
  const sourceWork = objectOrEmpty<Record<string, unknown>>(source.work);
  const work = objectOrEmpty<NonNullable<EmployeeRuntimeBindings['work']>>(current.work);
  const webPolicy = objectOrEmpty<NonNullable<EmployeeRuntimeBindings['webPolicy']>>(current.webPolicy);
  const models = Object.entries(objectOrEmpty<NonNullable<EmployeeRuntimeBindings['models']>>(current.models));
  const apis = Array.isArray(current.apis) ? current.apis : [];
  const tools = Array.isArray(current.tools) ? current.tools : [];
  const connectors = Array.isArray(current.connectors) ? current.connectors : [];
  const sourceHandler = text(sourceWork.legacyHandler) || text(work.legacyHandler) || text(work.sourceHandlerReference);
  const hasBindings = Boolean(text(work.handler) || models.length || apis.length || tools.length || connectors.length);
  if (!hasBindings) {
    return (
      <div className="ewb-section">
        <SectionHeading
          title="API 与工具"
          description="展示这名员工真正执行时使用的 handler、模型路由、联网策略、API、工具和连接器。"
        />
        <HonestEmpty description="接口没有返回这名员工的运行绑定，不会用静态文案冒充" />
      </div>
    );
  }
  return (
    <div className="ewb-section">
      <SectionHeading
        title="API 与工具"
        description="以下内容与能力、Skills、提示词和工作配置来自同一份权威员工对象，任务执行时按该对象锁定。"
      />
      <Alert
        type="info"
        showIcon
        message={text(work.handler) ? `实际执行 Handler：${work.handler}` : '执行 Handler 未返回'}
        description="页面只展示路由和权限策略，不会向前端下发 API Key、Token 或密码。"
      />
      {bindings.parityBoundary && (
        <Alert type="warning" showIcon message="派活原绑定与当前运行绑定边界" description={bindings.parityBoundary} />
      )}
      <Descriptions
        className="ewb-description"
        bordered
        size="small"
        column={{ xs: 1, sm: 2 }}
        items={[
          { key: 'mode', label: '执行模式', children: displayValue(work.mode) },
          { key: 'handler', label: '执行 Handler', children: displayValue(work.handler) },
          {
            key: 'legacy',
            label: '派活原 Handler',
            children: displayValue(sourceHandler || work.legacyPipelineBuilder),
          },
          { key: 'validation', label: '交付验证', children: displayValue(work.outputValidation) },
          { key: 'webMode', label: '联网模式', children: displayValue(webPolicy.defaultMode) },
          { key: 'cadence', label: '联网频率', children: displayValue(webPolicy.cadence) },
          { key: 'evidence', label: '联网证据', children: displayValue(webPolicy.evidenceRequired) },
          { key: 'failure', label: '联网失败策略', children: displayValue(webPolicy.failurePolicy) },
        ]}
      />
      <section className="ewb-runtime-group">
        <h4>模型路由</h4>
        <div className="ewb-runtime-grid">
          {models.map(([kind, model]) => (
            <RuntimeBindingCard
              key={kind}
              fallback={`${kind} 模型`}
              icon={<ThunderboltOutlined />}
              item={{
                id: `${kind} 模型`,
                route: text(model.route),
                invocation: text(model.invocation),
                status: model.factoryModel ? `出厂模型 ${model.factoryModel}` : '跟随企业模型路由',
              }}
            />
          ))}
        </div>
      </section>
      <RuntimeBindingGroup title="API" items={apis} empty="没有返回 API 绑定" />
      <RuntimeBindingGroup title="工具" items={tools} empty="没有返回工具绑定" />
      <RuntimeBindingGroup title="连接器" items={connectors} empty="没有返回连接器绑定" />
    </div>
  );
}

function SkillCard({
  skill,
  kind,
  editable,
  saving,
  onToggle,
  onDelete,
}: {
  skill: EmployeeSkill;
  kind: 'factory' | 'historical' | 'learned' | 'custom';
  editable: boolean;
  saving: boolean;
  onToggle?: () => void;
  onDelete?: () => void;
}) {
  const enabled = skill.enabled !== false;
  const ownerVerified =
    skill.verificationStatus === 'owner_verified_enabled' || skill.verificationLevel === 'catalog_contract_verified';
  const kindLabel = ownerVerified
    ? '已验证并默认启用'
    : kind === 'factory'
      ? '出厂岗位 Skill'
      : kind === 'learned'
        ? '全网进修技能'
        : '企业自定义技能';
  return (
    <article className="ewb-skill-card">
      <span className="ewb-capability-icon">
        {ownerVerified || kind === 'factory' ? <LockOutlined /> : <ThunderboltOutlined />}
      </span>
      <div className="ewb-card-copy">
        <strong>{skillTitle(skill)}</strong>
        <p>{skillDescription(skill) || '接口未提供技能说明'}</p>
        <div className="ewb-card-meta">
          <Tag color={ownerVerified || kind === 'factory' ? 'blue' : 'purple'}>{kindLabel}</Tag>
          {skill.source && <Tag>{skill.source}</Tag>}
          {ownerVerified && <Tag icon={<LockOutlined />}>执行时必定加载</Tag>}
        </div>
      </div>
      <div className="ewb-skill-actions">
        {kind === 'factory' && skill.required !== false ? (
          <Tag color="success" icon={<LockOutlined />} aria-label={`${skillTitle(skill)}出厂锁定且每次执行必定加载`}>
            执行时必定加载
          </Tag>
        ) : (
          kind === 'factory' && (
            <Tooltip title={saving ? '正在保存技能配置' : editable ? '可按需调整这项附加技能' : '当前账号只有查看权限'}>
              <span>
                <Switch
                  size="small"
                  checked={enabled}
                  disabled={!editable || saving}
                  onChange={onToggle}
                  aria-label={`${enabled ? '停用' : '启用'}${skillTitle(skill)}`}
                />
              </span>
            </Tooltip>
          )
        )}
        {(kind === 'custom' || kind === 'learned') && (
          <>
            <Tooltip
              title={
                saving
                  ? '正在保存技能配置'
                  : editable
                    ? `启用或停用${kind === 'learned' ? '全网进修技能' : '本企业自定义技能'}`
                    : '当前账号只有查看权限'
              }
            >
              <span>
                <Switch
                  size="small"
                  checked={enabled}
                  disabled={!editable || saving}
                  onChange={onToggle}
                  aria-label={`${enabled ? '停用' : '启用'}${skillTitle(skill)}`}
                />
              </span>
            </Tooltip>
            {editable && kind === 'custom' && (
              <Button
                size="small"
                danger
                type="text"
                disabled={saving}
                onClick={onDelete}
                aria-label={`删除${skillTitle(skill)}`}
              >
                删除
              </Button>
            )}
          </>
        )}
      </div>
    </article>
  );
}

function ConfigField({ field }: { field: WorkConfigField }) {
  const options = (field.options || []).map(option =>
    typeof option === 'string' ? { label: option, value: option } : option,
  );
  if (field.type === 'boolean') return <Switch />;
  if (field.type === 'number') return <InputNumber style={{ width: '100%' }} />;
  if (field.type === 'select') return <Select options={options} />;
  if (field.type === 'multiselect') return <Select mode="multiple" options={options} />;
  if (field.type === 'textarea') return <Input.TextArea rows={4} />;
  return <Input />;
}

function profileDescriptionItems(profile: EmployeeJobProfile, identity: EmployeeWorkbenchProfile['identity']) {
  const explicit = Array.isArray(profile.fields)
    ? profile.fields.filter(item => text(item?.label) && text(item?.value) && !/(?:版本|修订)/u.test(text(item.label)))
    : [];
  const generated = [
    { label: '岗位职责', value: profile.duty || profile.responsibilities?.join('；') || identity.duty },
    {
      label: '岗位介绍',
      value: profile.intro || profile.useCases?.join('；') || identity.intro || identity.description,
    },
    { label: '所属部门', value: profile.department || departmentName(identity) },
    { label: '所属分部', value: profile.group || identity.group },
    { label: '岗位键', value: profile.roleKey },
    { label: '岗位名称', value: profile.roleTitle },
    { label: '生产阶段', value: profile.moduleGroup },
    { label: '岗位 Skill', value: profile.positionSkill },
    { label: '专业角色', value: profile.role },
    { label: '适用范围', value: profile.scope },
    { label: '不负责事项', value: profile.nonGoals?.join('；') },
    { label: 'KPI / 验收', value: profile.kpis?.join('；') },
    { label: '执行所需信息（公开信息由系统补齐）', value: profile.requiredInputs?.join('；') },
    { label: '预期交付', value: profile.expectedDeliverables?.join('；') },
    { label: '原生输出字段', value: profile.outputKeys?.join('、') },
    { label: '质量标准', value: profile.qualityStandards?.join('；') },
    { label: '协同分部', value: profile.collaborators?.join('、') },
    { label: '岗位权限', value: profile.authority === undefined ? '' : displayValue(profile.authority) },
    { label: '服务级别', value: profile.serviceLevel === undefined ? '' : displayValue(profile.serviceLevel) },
    { label: '输出契约', value: profile.outputSchema === undefined ? '' : displayValue(profile.outputSchema) },
    { label: '连接器策略', value: profile.connectorPolicy === undefined ? '' : displayValue(profile.connectorPolicy) },
    { label: '已完成任务', value: Number.isFinite(profile.completedRuns) ? `${profile.completedRuns} 单` : '' },
    { label: '员工编号', value: profile.employeeCode || String(profile.employeeNumber ?? identity.idx) },
    { label: '档案来源', value: profile.source },
  ].filter(item => text(item.value));
  const explicitLabels = new Set(explicit.map(item => item.label));
  return [...explicit, ...generated.filter(item => !explicitLabels.has(item.label))];
}

function dispatchTypes(dispatch: EmployeeDispatch) {
  return (dispatch.types || dispatch.taskTypes || [])
    .map(option => (typeof option === 'string' ? { label: option, value: option } : option))
    .filter(option => text(option?.label) && text(option?.value));
}

const KNOWN_CONFIG_FIELDS: WorkConfigField[] = [
  { key: 'textModel', label: '文本模型', description: '留空表示跟随企业全局模型。' },
  { key: 'visionModel', label: '视觉模型', description: '留空表示跟随企业全局模型。' },
  {
    key: 'webMode',
    label: '联网方式',
    type: 'select',
    options: [
      { label: '岗位要求联网', value: 'required' },
      { label: '按需联网', value: 'allowed' },
      { label: '关闭联网', value: 'off' },
    ],
  },
  { key: 'knowledgeScopes', label: '知识范围', type: 'multiselect', options: ['餐饮产业知识库', '员工产出'] },
  {
    key: 'outputLength',
    label: '交付篇幅',
    type: 'select',
    options: [
      { label: '标准', value: 'standard' },
      { label: '完整', value: 'full' },
    ],
  },
  {
    key: 'timeoutSeconds',
    label: '模型与返工容错（秒）',
    type: 'number',
    description: '单轮最多300秒、最多3次有效候选；900秒为当前最大值。',
  },
  {
    key: 'approvalMode',
    label: '审批方式',
    type: 'select',
    options: [
      { label: '老板审阅', value: 'owner_review' },
      { label: '管理层审阅', value: 'manager_review' },
      { label: '自动形成草稿', value: 'auto_draft' },
    ],
  },
  { key: 'maxCost', label: '单次成本上限', type: 'number' },
  { key: 'language', label: '输出语言' },
];

function configValues(config: EmployeeWorkConfig) {
  if (config.values && typeof config.values === 'object') return config.values;
  const metadata = new Set(['fields', 'schema', 'version', 'mode', 'summary', 'boundary']);
  return Object.fromEntries(Object.entries(config).filter(([key, value]) => !metadata.has(key) && value !== undefined));
}

function effectiveConfigFields(config: EmployeeWorkConfig) {
  const declared = config.fields || config.schema?.fields || [];
  if (declared.length) return declared;
  const keys = new Set(Object.keys(configValues(config)));
  return KNOWN_CONFIG_FIELDS.filter(field => keys.has(field.key));
}

function SourceDeliverables({
  items,
  loading,
  error,
  onRetry,
}: {
  items: EmployeeSourceDeliverable[];
  loading: boolean;
  error: string;
  onRetry: () => void;
}) {
  if (!loading && !error && !items.length) return null;
  return (
    <div className="ewb-source-deliverables" aria-live="polite">
      <div className="ewb-source-deliverables-head">
        <span>
          <FileTextOutlined aria-hidden="true" />
          <strong>交付文件</strong>
          <small>根据本次真实报告自动生成</small>
        </span>
        {loading && <Tag color="processing">正在准备…</Tag>}
      </div>
      {!!items.length && (
        <Space size={[6, 6]} wrap>
          {items.map(item => (
            <Button
              key={item.id}
              icon={<DownloadOutlined />}
              href={item.downloadUrl}
              target="_blank"
              rel="noreferrer"
              disabled={!item.downloadUrl}
            >
              下载 {item.label || item.format?.toUpperCase() || item.fileName || '文件'}
            </Button>
          ))}
        </Space>
      )}
      {error && (
        <div className="ewb-source-deliverables-error">
          <span>{error}</span>
          <Button size="small" onClick={onRetry}>
            重试生成
          </Button>
        </div>
      )}
    </div>
  );
}

export default function EmployeeWorkbench(props: Props) {
  const instanceKey =
    props.open && props.idx !== null
      ? `${props.domain}-${props.idx}-${props.initialRunId || 'run'}-${props.initialTaskId || 'task'}-${props.initialDirective ? 'prefilled' : 'blank'}`
      : 'closed';
  return <EmployeeWorkbenchInstance key={instanceKey} {...props} />;
}

function EmployeeWorkbenchInstance({
  open,
  domain,
  idx,
  initialRunId,
  initialTaskId,
  initialDirective,
  identityHint,
  onClose,
}: Props) {
  const [profile, setProfile] = useState<EmployeeWorkbenchProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [activeTab, setActiveTab] = useState('overview');
  const [backendProfileOpen, setBackendProfileOpen] = useState(false);
  const [saving, setSaving] = useState<MutationName | 'dispatch' | ''>('');
  const [promptDraft, setPromptDraft] = useState('');
  const [customSkillOpen, setCustomSkillOpen] = useState(false);
  const [skillLearningRun, setSkillLearningRun] = useState<EmployeeSkillLearningRun | null>(null);
  const [skillLearningLoading, setSkillLearningLoading] = useState(false);
  const [lastSnapshot, setLastSnapshot] = useState<Record<string, unknown> | null>(null);
  // 餐饮域派活后的任务进度（content 域走 runs 列表，restaurant 域走 /marshals/tasks/:id/status）
  const [restaurantTask, setRestaurantTask] = useState<EmployeeRuntimeTask | null>(null);
  const [restaurantPollWarning, setRestaurantPollWarning] = useState<RestaurantTaskPollWarning | null>(null);
  const [restaurantTaskLoading, setRestaurantTaskLoading] = useState('');
  const [restaurantTasksRefreshing, setRestaurantTasksRefreshing] = useState(false);
  const [restaurantTasksLoadingMore, setRestaurantTasksLoadingMore] = useState(false);
  const [dispatchFiles, setDispatchFiles] = useState<UploadedFileRef[]>([]);
  const [runs, setRuns] = useState<EmployeeWorkbenchRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState('');
  const [selectedRun, setSelectedRun] = useState<EmployeeWorkbenchRun | null>(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [adoptRun, setAdoptRun] = useState<EmployeeWorkbenchRun | null>(null);
  const [adoptCandidateIndex, setAdoptCandidateIndex] = useState<number | null>(null);
  const [rejectRun, setRejectRun] = useState<EmployeeWorkbenchRun | null>(null);
  const [rejectOpinion, setRejectOpinion] = useState('');
  const [dispatchGuideOpen, setDispatchGuideOpen] = useState(false);
  const [contentProfileOpen, setContentProfileOpen] = useState(false);
  const [businessFlow, setBusinessFlow] = useState<{
    sourceType: BusinessFlowSourceType;
    sourceId: number;
  } | null>(null);
  const [sourceDeliverableKey, setSourceDeliverableKey] = useState('');
  const [sourceDeliverables, setSourceDeliverables] = useState<EmployeeSourceDeliverable[]>([]);
  const [sourceDeliverablesLoading, setSourceDeliverablesLoading] = useState(false);
  const [sourceDeliverablesError, setSourceDeliverablesError] = useState('');
  const requestSerial = useRef(0);
  const runRequestSerial = useRef(0);
  const sourceDeliverableRequestSerial = useRef(0);
  const [dispatchForm] = Form.useForm<DispatchFormValues>();
  // 派活输入语音化（全部数字员工共用）：识别在本机浏览器完成，不扣积分；
  // 说完后由 AI 按经营语境整理意图（轻量真实调用），纠正同音错字。
  const [dispatchVoiceRefining, setDispatchVoiceRefining] = useState(false);
  const dispatchVoice = useVoiceInput(
    () => text(dispatchForm.getFieldValue('question')),
    next => dispatchForm.setFieldValue('question', next),
    {
      onFinish: finalText => {
        setDispatchVoiceRefining(true);
        void refineVoiceIntent(finalText)
          .then(refined => {
            if (refined && refined !== finalText) {
              dispatchForm.setFieldValue('question', refined);
              message.success('已按你的意思整理好任务描述，确认后发送');
            }
          })
          .finally(() => setDispatchVoiceRefining(false));
      },
    },
  );
  const [configForm] = Form.useForm();
  const [customSkillForm] = Form.useForm();

  const profileVersionForGuide =
    text(profile?.jobProfile.profileVersion) ||
    text(profile?.provenance.profileVersion) ||
    text(profile?.provenance.sourceVersion) ||
    'current';
  const currentUser = getUser();
  const canManageContentProfile =
    domain === 'content' && ['boss', 'admin', 'platform_super'].includes(currentUser?.role || '');
  const tenantId = Number(currentUser?.tenant?.id ?? currentUser?.tenant_id);
  const userId = Number(currentUser?.id);
  const dispatchGuidePreferenceKey = !profile
    ? ''
    : idx !== null && Number.isSafeInteger(tenantId) && tenantId > 0 && Number.isSafeInteger(userId) && userId > 0
      ? domain === 'restaurant'
        ? `nanowork.employee-workbench.dispatch-guide.seen.${DISPATCH_GUIDE_PREFERENCE_VERSION}:${tenantId}:${userId}:restaurant`
        : `nanowork.employee-workbench.dispatch-guide.seen.${DISPATCH_GUIDE_PREFERENCE_VERSION}:${tenantId}:${userId}:${domain}:${idx}:${encodeURIComponent(profileVersionForGuide)}`
      : 'unscoped';
  const dispatchGuideId = `employee-dispatch-guide-${domain}-${idx ?? 'closed'}`;
  const taskCenterId = `employee-task-center-${domain}-${idx ?? 'closed'}`;
  const contentResultId = `employee-content-result-${idx ?? 'closed'}`;
  const restaurantResultId = `employee-restaurant-result-${idx ?? 'closed'}`;
  const dispatchFormId = `employee-dispatch-form-${domain}-${idx ?? 'closed'}`;

  const applyProfile = useCallback(
    (normalized: EmployeeWorkbenchProfile, preserveDispatchDraft = false) => {
      const prompts = normalized.prompts || {};
      setPromptDraft(text(prompts.overrideTemplate) || text(prompts.override));
      configForm.setFieldsValue(configValues(normalized.workConfig || {}));
      if (!preserveDispatchDraft) {
        const types = dispatchTypes(normalized.dispatch);
        dispatchForm.setFieldsValue({
          question: text(initialDirective) || '',
          title: '',
          requirement: '',
          industry: '',
          feedback: '',
          dueAt: undefined,
          type: normalized.dispatch.defaultType || normalized.dispatch.defaultTaskType || types[0]?.value,
          ...(domain === 'content'
            ? {
                platforms: ['小红书'],
                imageMode: 'ai',
                imageCount: null,
                enableDeck: false,
                refLink: '',
                xhsStyle: null,
                dyStyle: null,
              }
            : {}),
        });
      }
      setProfile(normalized);
    },
    [configForm, dispatchForm, domain, initialDirective],
  );

  const loadRuns = useCallback(async () => {
    if (!open || domain !== 'content' || idx === null) return;
    const serial = ++runRequestSerial.current;
    setRunsLoading(true);
    setRunsError('');
    try {
      const data = (await api.get(`/employee-workbench/content/${idx}/runs?limit=8`)) as EmployeeRunListResponse;
      if (serial !== runRequestSerial.current) return;
      const nextRuns = Array.isArray(data?.runs) ? data.runs : [];
      setRuns(nextRuns);
      setSelectedRun(current => {
        if (!current) return current;
        const summary = nextRuns.find(run => run.id === current.id);
        return summary ? { ...current, ...summary, resultMd: current.resultMd, snapshot: current.snapshot } : current;
      });
      setActiveRunId(current => current ?? nextRuns.find(run => run.status === '生成中')?.id ?? null);
    } catch (error: any) {
      if (serial === runRequestSerial.current) {
        setRunsError(error?.message || '近期任务读取失败');
      }
    } finally {
      if (serial === runRequestSerial.current) setRunsLoading(false);
    }
  }, [domain, idx, open]);

  const loadRunDetail = useCallback(
    async (id: number, { quiet = false } = {}) => {
      if (!open || domain !== 'content' || idx === null) return null;
      if (!quiet) setRunDetailLoading(true);
      try {
        const data = (await api.get(`/employee-workbench/content/${idx}/runs/${id}`)) as { run?: EmployeeWorkbenchRun };
        const run = data?.run || null;
        if (run) {
          setSelectedRun(current => (quiet && current && current.id !== run.id ? current : run));
          setRuns(current => current.map(item => (item.id === run.id ? { ...item, ...run } : item)));
          if (!quiet) {
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(() => {
                document.getElementById(contentResultId)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
              });
            });
          }
        }
        return run;
      } catch {
        return null;
      } finally {
        if (!quiet) setRunDetailLoading(false);
      }
    },
    [contentResultId, domain, idx, open],
  );

  const loadProfile = useCallback(async () => {
    if (!open || idx === null) return;
    const serial = ++requestSerial.current;
    setLoading(true);
    setLoadError('');
    setProfile(null);
    setLastSnapshot(null);
    try {
      const data = await api.get(`/employee-workbench/${domain}/${idx}`);
      const normalized = normalizeProfile(data);
      if (serial !== requestSerial.current) return;
      applyProfile(normalized);
    } catch (error: any) {
      if (serial !== requestSerial.current) return;
      setLoadError(error?.message || '员工工作台读取失败');
    } finally {
      if (serial === requestSerial.current) setLoading(false);
    }
  }, [applyProfile, domain, idx, open]);

  const refreshProfileQuietly = useCallback(async () => {
    if (!open || idx === null) return;
    try {
      const data = await api.get(`/employee-workbench/${domain}/${idx}`);
      applyProfile(normalizeProfile(data), true);
    } catch {
      // 结果已经持久化；运行统计刷新失败时保留现有档案，避免遮住结果。
    }
  }, [applyProfile, domain, idx, open]);

  const loadSourceDeliverables = useCallback(
    async (
      sourceType: 'agent_task' | 'content_employee_run',
      sourceId: number,
      { generateIfMissing = true }: { generateIfMissing?: boolean } = {},
    ) => {
      if (!open || !Number.isSafeInteger(sourceId) || sourceId <= 0) return;
      const key = `${sourceType}:${sourceId}`;
      const serial = ++sourceDeliverableRequestSerial.current;
      setSourceDeliverableKey(key);
      setSourceDeliverablesLoading(true);
      setSourceDeliverablesError('');
      try {
        let payload = (await api.get(`/files/artifacts/source/${sourceType}/${sourceId}`, { silent: true })) as {
          deliverables?: EmployeeSourceDeliverable[];
        };
        let deliverables = Array.isArray(payload?.deliverables) ? payload.deliverables : [];
        if (!deliverables.length && generateIfMissing) {
          payload = (await api.post(
            '/files/artifacts/source',
            {
              sourceType,
              sourceId,
              formats: ['pdf', 'docx', 'xlsx'],
            },
            { silent: true },
          )) as { deliverables?: EmployeeSourceDeliverable[] };
          deliverables = Array.isArray(payload?.deliverables) ? payload.deliverables : [];
        }
        if (serial !== sourceDeliverableRequestSerial.current) return;
        setSourceDeliverableKey(key);
        setSourceDeliverables(deliverables);
      } catch (error: any) {
        if (serial !== sourceDeliverableRequestSerial.current) return;
        setSourceDeliverables([]);
        setSourceDeliverablesError(error?.message || '交付文件暂时未生成');
      } finally {
        if (serial === sourceDeliverableRequestSerial.current) setSourceDeliverablesLoading(false);
      }
    },
    [open],
  );

  const loadLatestSkillLearningRun = useCallback(async () => {
    if (!open || idx === null || !profile?.permissions.canEditSkills) return null;
    try {
      const data = (await api.get(`/employee-workbench/${domain}/${idx}/learning-runs?limit=1`)) as {
        runs?: EmployeeSkillLearningRun[];
      };
      const run = data?.runs?.[0] || null;
      setSkillLearningRun(run);
      return run;
    } catch {
      return null;
    }
  }, [domain, idx, open, profile?.permissions.canEditSkills]);

  const startSkillLearning = useCallback(async () => {
    if (idx === null) return;
    setSkillLearningLoading(true);
    try {
      const data = (await api.post(`/employee-workbench/${domain}/${idx}/learn`, {})) as {
        run?: EmployeeSkillLearningRun;
        message?: string;
      };
      if (data?.run) setSkillLearningRun(data.run);
      message.success(data?.message || '员工已开始全网进修');
    } finally {
      setSkillLearningLoading(false);
    }
  }, [domain, idx]);

  useEffect(() => {
    if (!open || !backendProfileOpen || activeTab !== 'skills' || !profile?.permissions.canEditSkills) return;
    const timer = window.setTimeout(() => void loadLatestSkillLearningRun(), 0);
    return () => window.clearTimeout(timer);
  }, [activeTab, backendProfileOpen, loadLatestSkillLearningRun, open, profile?.permissions.canEditSkills]);

  const skillLearningRunId = skillLearningRun?.id;
  const skillLearningRunStatus = skillLearningRun?.status;
  useEffect(() => {
    if (!open || idx === null || !skillLearningRunId || !['queued', 'running'].includes(skillLearningRunStatus || ''))
      return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const data = (await api.get(`/employee-workbench/${domain}/${idx}/learning-runs/${skillLearningRunId}`)) as {
          run?: EmployeeSkillLearningRun;
        };
        if (cancelled || !data?.run) return;
        setSkillLearningRun(data.run);
        if (['queued', 'running'].includes(data.run.status)) {
          timer = window.setTimeout(poll, 2000);
        } else if (data.run.status === 'completed') {
          await refreshProfileQuietly();
          message.success(`全网进修完成，新增${data.run.skillsAdded}条技能`);
        } else {
          message.error(data.run.error?.message || '全网进修失败，预授权已按记录处理');
        }
      } catch {
        if (!cancelled) timer = window.setTimeout(poll, 3500);
      }
    };
    timer = window.setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [domain, idx, open, refreshProfileQuietly, skillLearningRunId, skillLearningRunStatus]);

  const loadRestaurantTask = useCallback(
    async (rawTaskId: string | number, options: { scrollToResult?: boolean } = {}) => {
      if (!open || domain !== 'restaurant') return;
      const taskId = Number(rawTaskId);
      if (!Number.isSafeInteger(taskId) || taskId <= 0) {
        message.error('任务编号无效，无法读取进度');
        return;
      }
      setRestaurantTaskLoading(String(taskId));
      setRestaurantPollWarning(null);
      try {
        const task = (await api.get(`/marshals/tasks/${taskId}/status`)) as EmployeeRuntimeTask;
        setRestaurantTask(task);
        if (!isTaskRunning(task.status)) await refreshProfileQuietly();
        if (options.scrollToResult) {
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              document.getElementById(restaurantResultId)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            });
          });
        }
      } finally {
        setRestaurantTaskLoading('');
      }
    },
    [domain, open, refreshProfileQuietly, restaurantResultId],
  );

  useEffect(() => {
    if (!open || !profile) return;
    const contentTargetReady =
      domain === 'content' && Number(initialRunId) > 0 && Number(selectedRun?.id) === Number(initialRunId);
    const restaurantTargetReady =
      domain === 'restaurant' && Number(initialTaskId) > 0 && Number(restaurantTask?.id) === Number(initialTaskId);
    if (!contentTargetReady && !restaurantTargetReady) return;
    const targetId = contentTargetReady ? contentResultId : restaurantResultId;
    const timer = window.setTimeout(() => {
      document.getElementById(targetId)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [
    contentResultId,
    domain,
    initialRunId,
    initialTaskId,
    open,
    profile,
    restaurantResultId,
    restaurantTask?.id,
    selectedRun?.id,
  ]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (
        cancelled ||
        !open ||
        domain !== 'restaurant' ||
        initialTaskId == null ||
        String(initialTaskId).trim() === ''
      ) {
        return;
      }
      void loadRestaurantTask(initialTaskId);
    });
    return () => {
      cancelled = true;
    };
  }, [domain, initialTaskId, loadRestaurantTask, open]);

  const refreshRestaurantTasks = useCallback(async () => {
    if (!open || domain !== 'restaurant' || idx === null) return;
    setRestaurantTasksRefreshing(true);
    try {
      const limit = Math.min(50, Math.max(8, profile?.runtime.recentTasks?.length || 0));
      const data = (await api.get(`/employee-workbench/restaurant/${idx}/tasks?offset=0&limit=${limit}`)) as {
        tasks?: EmployeeRuntimeTask[];
        page?: EmployeeWorkbenchProfile['runtime']['taskPage'];
        lastTask?: EmployeeRuntimeTask | null;
      };
      setProfile(current =>
        current && Number(current.identity.idx) === idx
          ? {
              ...current,
              runtime: {
                ...current.runtime,
                recentTasks: Array.isArray(data.tasks) ? data.tasks : [],
                taskPage: data.page,
                lastTask: data.lastTask || current.runtime.lastTask,
              },
            }
          : current,
      );
    } catch (error: any) {
      message.error(error?.message || '任务列表刷新失败');
    } finally {
      setRestaurantTasksRefreshing(false);
    }
  }, [domain, idx, open, profile]);

  const loadMoreRestaurantTasks = useCallback(async () => {
    if (!open || domain !== 'restaurant' || idx === null) return;
    const page = profile?.runtime.taskPage;
    if (!page?.hasMore || page.nextOffset == null) return;
    setRestaurantTasksLoadingMore(true);
    try {
      const data = (await api.get(`/employee-workbench/restaurant/${idx}/tasks?offset=${page.nextOffset}&limit=8`)) as {
        tasks?: EmployeeRuntimeTask[];
        page?: EmployeeWorkbenchProfile['runtime']['taskPage'];
      };
      setProfile(current => {
        if (!current || Number(current.identity.idx) !== idx) return current;
        const merged = [...(current.runtime.recentTasks || []), ...(Array.isArray(data.tasks) ? data.tasks : [])];
        const seen = new Set<string>();
        return {
          ...current,
          runtime: {
            ...current.runtime,
            recentTasks: merged.filter(task => {
              const key = String(task.id);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            }),
            taskPage: data.page || current.runtime.taskPage,
          },
        };
      });
    } catch (error: any) {
      message.error(error?.message || '更多任务读取失败');
    } finally {
      setRestaurantTasksLoadingMore(false);
    }
  }, [domain, idx, open, profile]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || !open) return;
      void loadProfile();
      if (domain === 'content') {
        void loadRuns();
        if (Number.isSafeInteger(initialRunId) && Number(initialRunId) > 0) {
          void loadRunDetail(Number(initialRunId)).then(run => {
            if (!cancelled && run?.status === '生成中') setActiveRunId(run.id);
          });
        }
      }
    });
    return () => {
      cancelled = true;
      requestSerial.current += 1;
      runRequestSerial.current += 1;
    };
  }, [domain, initialRunId, loadProfile, loadRunDetail, loadRuns, open]);

  useEffect(() => {
    if (!dispatchGuidePreferenceKey) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (dispatchGuidePreferenceKey === 'unscoped') {
        setDispatchGuideOpen(true);
        return;
      }
      const seen = safeLocalStorageGet(dispatchGuidePreferenceKey) === '1';
      setDispatchGuideOpen(!seen);
      if (!seen) safeLocalStorageSet(dispatchGuidePreferenceKey, '1');
    });
    return () => {
      cancelled = true;
    };
  }, [dispatchGuidePreferenceKey]);

  useEffect(() => {
    if (!open || domain !== 'content' || idx === null || activeRunId === null) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const data = (await api.get(`/employee-workbench/content/${idx}/runs/${activeRunId}`)) as {
          run?: EmployeeWorkbenchRun;
        };
        const run = data?.run;
        if (cancelled || !run) return;
        setRuns(current => {
          const exists = current.some(item => item.id === run.id);
          return exists
            ? current.map(item => (item.id === run.id ? { ...item, ...run } : item))
            : [run, ...current].slice(0, 8);
        });
        setSelectedRun(current => (!current || current.id === run.id ? run : current));
        if (run.status === '生成中') {
          timer = window.setTimeout(poll, 1500);
        } else {
          setActiveRunId(null);
          void loadRuns();
          void refreshProfileQuietly();
        }
      } catch {
        if (!cancelled) setActiveRunId(null);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeRunId, domain, idx, loadRuns, open, refreshProfileQuietly]);

  const mutate = async (name: MutationName, body: Record<string, unknown>, success: string) => {
    if (idx === null) return false;
    setSaving(name);
    try {
      const data = await api.put(`/employee-workbench/${domain}/${idx}/${name}`, body);
      const wrapped = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
      if (wrapped.profile) applyProfile(normalizeProfile(data));
      else await loadProfile();
      message.success(success);
      return true;
    } catch {
      return false;
    } finally {
      setSaving('');
    }
  };

  const titleIdentity = profile?.identity || identityHint;
  const canViewInternalProfile = profile?.permissions.canViewInternalProfile === true;
  const skills = useMemo(() => splitSkills(profile?.skillLibrary || {}), [profile?.skillLibrary]);
  const verifiedDefaultSkillCount = skills.factory.filter(
    skill =>
      skill.verificationStatus === 'owner_verified_enabled' || skill.verificationLevel === 'catalog_contract_verified',
  ).length;
  const configFields = profile ? effectiveConfigFields(profile.workConfig) : [];

  const savePrompt = () =>
    mutate(
      'prompt',
      { overrideTemplate: promptDraft },
      promptDraft.trim() ? '员工提示词覆盖已保存' : '已恢复默认提示词',
    );
  const saveConfig = async () => {
    const values = await configForm.validateFields();
    await mutate('config', { values }, '工作配置已保存，下次执行生效');
  };
  const toggleCustomSkill = (skill: EmployeeSkill) =>
    mutate(
      'skills',
      {
        skills: [{ id: skill.id, key: skill.key, title: skillTitle(skill), enabled: skill.enabled === false }],
      },
      `技能已${skill.enabled === false ? '启用' : '停用'}`,
    );
  const toggleOptionalSkill = (skill: EmployeeSkill) =>
    mutate(
      'skills',
      {
        skills: [{ id: skill.id, key: skill.key, title: skillTitle(skill), enabled: skill.enabled === false }],
      },
      `技能已${skill.enabled === false ? '启用' : '停用'}`,
    );
  const deleteCustomSkill = (skill: EmployeeSkill) => {
    const customSkills = skills.custom
      .filter(item => item !== skill)
      .map(item => ({
        title: skillTitle(item),
        detail: skillDescription(item),
        source: item.source || '',
        enabled: item.enabled !== false,
      }));
    void mutate('skills', { customSkills }, '自定义技能已删除');
  };
  const addCustomSkill = async () => {
    const values = await customSkillForm.validateFields();
    const customSkills = [
      ...skills.custom.map(item => ({
        title: skillTitle(item),
        detail: skillDescription(item),
        source: item.source || '',
        enabled: item.enabled !== false,
      })),
      { ...values, enabled: true },
    ];
    const saved = await mutate('skills', { customSkills }, '自定义技能已加入');
    if (saved) {
      setCustomSkillOpen(false);
      customSkillForm.resetFields();
    }
  };

  // 餐饮任务进度轮询：仅在生成阶段轮询；进入待审阅/完成/失败后刷新持久任务列表并停止。
  // 同步失败只是传输层告警，不改任务状态；递归 setTimeout 保证无并发轮询并有上限退避。
  useEffect(() => {
    if (!open || domain !== 'restaurant') return;
    const taskId = restaurantTask?.id;
    if (!taskId || !isTaskRunning(restaurantTask?.status)) return;
    const taskKey = String(taskId);
    let cancelled = false;
    let inFlight = false;
    let consecutiveFailures = 0;
    let timer: number | undefined;

    const schedulePoll = (delayMs: number) => {
      if (cancelled) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void pull(), delayMs);
    };
    const pull = async () => {
      if (cancelled || inFlight) return;
      if (document.visibilityState !== 'visible') {
        schedulePoll(RESTAURANT_TASK_POLL_INTERVAL_MS);
        return;
      }
      inFlight = true;
      try {
        const task = (await api.get(`/marshals/tasks/${taskId}/status`)) as EmployeeRuntimeTask;
        if (cancelled) return;
        consecutiveFailures = 0;
        setRestaurantPollWarning(null);
        setRestaurantTask(current => (current && current.id === taskId ? { ...current, ...task } : current));
        if (isTaskRunning(task.status)) schedulePoll(RESTAURANT_TASK_POLL_INTERVAL_MS);
        else void refreshProfileQuietly();
      } catch {
        if (cancelled) return;
        consecutiveFailures += 1;
        const warning = buildRestaurantTaskPollWarning(consecutiveFailures);
        setRestaurantPollWarning({ ...warning, taskId: taskKey });
        schedulePoll(warning.retryDelayMs);
      } finally {
        inFlight = false;
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !inFlight) schedulePoll(0);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    schedulePoll(RESTAURANT_TASK_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [open, domain, refreshProfileQuietly, restaurantTask?.id, restaurantTask?.status]);

  useEffect(() => {
    const sourceType = domain === 'content' ? 'content_employee_run' : 'agent_task';
    const sourceId = Number(domain === 'content' ? selectedRun?.id : restaurantTask?.id);
    const hasReport =
      domain === 'content' ? Boolean(text(selectedRun?.resultMd)) : Boolean(text(restaurantTask?.output_body));
    if (!open || !Number.isSafeInteger(sourceId) || sourceId <= 0 || !hasReport) {
      sourceDeliverableRequestSerial.current += 1;
      const timer = window.setTimeout(() => {
        setSourceDeliverableKey('');
        setSourceDeliverables([]);
        setSourceDeliverablesError('');
        setSourceDeliverablesLoading(false);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => {
      void loadSourceDeliverables(sourceType, sourceId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    domain,
    loadSourceDeliverables,
    open,
    restaurantTask?.id,
    restaurantTask?.output_body,
    selectedRun?.id,
    selectedRun?.resultMd,
  ]);

  const submitDispatch = async () => {
    if (idx === null || !profile) return;
    const values = await dispatchForm.validateFields();
    let dispatchPayload: Record<string, unknown> & { brief?: ReturnType<typeof buildPaihuoContentBrief> };
    try {
      dispatchPayload =
        domain === 'content'
          ? {
              question: values.question || values.goal || values.title,
              // 保留旧 DTO 字段，服务端可继续读取；新界面只要求 question。
              title: values.title || values.question || values.goal,
              type: values.type,
              requirement: values.requirement || values.materials,
              industry: values.industry,
              feedback: values.feedback,
              dueAt: values.dueAt,
              brief: buildPaihuoContentBrief({
                ...values,
                question: values.question || values.goal,
              } as ContentEmployeeDispatchFormValues),
            }
          : { ...values, question: values.question || values.goal || values.title };
    } catch (error: any) {
      message.error(error?.message || '内容 Brief 格式无效');
      return;
    }
    setSaving('dispatch');
    try {
      const result = await api.post(`/employee-workbench/${domain}/${idx}/dispatch`, {
        ...dispatchPayload,
        ...(dispatchFiles.length ? { fileIds: dispatchFiles.map(file => file.id) } : {}),
      });
      const payload = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
      const snapshot =
        payload.snapshot && typeof payload.snapshot === 'object' ? (payload.snapshot as Record<string, unknown>) : null;
      const billing =
        payload.billing && typeof payload.billing === 'object'
          ? (payload.billing as EmployeeWorkbenchRun['billing'])
          : null;
      setLastSnapshot(snapshot);
      const createdRunId = Number(payload.runId ?? payload.taskId);
      if (domain === 'restaurant' && Number.isSafeInteger(createdRunId) && createdRunId > 0) {
        setRestaurantPollWarning(null);
        setRestaurantTask({
          id: createdRunId,
          title: String(values.question || values.goal || values.title || `任务 #${createdRunId}`),
          type: String(values.type || '岗位交付'),
          status: String(payload.status || '生成中'),
          stepIndex: 1,
          createdAt: new Date().toISOString(),
        });
      }
      if (domain === 'content' && Number.isSafeInteger(createdRunId) && createdRunId > 0) {
        setActiveRunId(createdRunId);
        setSelectedRun({
          id: createdRunId,
          runId: createdRunId,
          employeeIdx: idx,
          employeeName: profile.identity.name,
          title: String(values.question || values.goal || values.title || ''),
          type: String(values.type || ''),
          requirement: String(values.requirement || values.materials || ''),
          industry: String(values.industry || ''),
          feedback: String(values.feedback || ''),
          status: '生成中',
          displayStatus: '生成中',
          billing,
          canReview: false,
          terminal: false,
        });
      }
      await refreshProfileQuietly();
      message.success(
        canViewInternalProfile
          ? text(payload.msg) || text(payload.message) || '任务已派发，完整能力快照已锁定'
          : '任务已派发，可在任务列表查看进度',
      );
      dispatchForm.setFieldsValue({
        question: '',
        title: '',
        requirement: '',
        industry: '',
        feedback: '',
        dueAt: undefined,
        ...(domain === 'content'
          ? {
              imageCount: null,
              enableDeck: false,
              refLink: '',
              xhsStyle: null,
              dyStyle: null,
            }
          : {}),
      });
      setDispatchFiles([]);
    } catch {
      // api 客户端已经显示了服务端错误；保留表单，方便修正后重试。
    } finally {
      setSaving('');
    }
  };

  const reviewRun = async (
    run: EmployeeWorkbenchRun,
    decision: 'adopt' | 'reject',
    opinion = '',
    selection?: { candidateIndex: number },
  ) => {
    if (domain !== 'content' || idx === null) return;
    setReviewing(true);
    try {
      const data = (await api.post(`/employee-workbench/content/${idx}/runs/${run.id}/review`, {
        decision,
        opinion,
        selection,
      })) as { run?: EmployeeWorkbenchRun; alreadyReviewed?: boolean };
      if (data.run) setSelectedRun(data.run);
      message.success(
        data.alreadyReviewed
          ? `该产出已经${decision === 'adopt' ? '采纳' : '驳回'}`
          : decision === 'adopt'
            ? idx === 8
              ? '分发官产出已人工审阅通过，并形成可继续发布登记的内容'
              : '产出已人工审阅通过'
            : '产出已驳回',
      );
      setRejectRun(null);
      setRejectOpinion('');
      setAdoptRun(null);
      setAdoptCandidateIndex(null);
      await Promise.all([loadRuns(), refreshProfileQuietly()]);
      if (data.run) setSelectedRun(data.run);
    } finally {
      setReviewing(false);
    }
  };

  const confirmAdoptRun = (run: EmployeeWorkbenchRun) => {
    if (run.handlerApproval?.candidateSelectionRequired) {
      setAdoptCandidateIndex(null);
      setAdoptRun(run);
      return;
    }
    Modal.confirm({
      title: `确认采纳「${run.title}」？`,
      content:
        idx === 8
          ? '采纳即完成人工审阅，内容通过交付门禁后可在内容列表继续做发布登记；系统不会自动对外发布。'
          : '采纳后本次内容员工运行将计入已完成并沉淀为素材；对外发布及不可逆动作仍需按岗位边界另行授权。',
      okText: '确认采纳',
      cancelText: '取消',
      onOk: () => reviewRun(run, 'adopt'),
    });
  };

  const dispatchAvailable =
    !!profile?.permissions.canDispatch && profile.dispatch.available !== false && profile.dispatch.enabled !== false;

  const dispatchTab =
    profile &&
    (() => {
      const guidance = profile.dispatch.guidance || {};
      const materialChecklist =
        stringList(guidance.materialChecklist) ||
        stringList(profile.workMethod.inputs || profile.workMethod.requiredInputs);
      const deliverableChecklist =
        stringList(guidance.deliverableChecklist) || stringList(profile.workMethod.deliverables);
      const taskExamples = stringList(guidance.taskExamples);
      const restaurantRecentTasks =
        profile.runtime.recentTasks?.length || !profile.runtime.lastTask
          ? profile.runtime.recentTasks || []
          : [profile.runtime.lastTask];
      const restaurantPublicStatus = restaurantTask ? restaurantStatus(restaurantTask) : '';
      const restaurantOutputBody = text(restaurantTask?.output_body);
      const restaurantReportView = restaurantOutputPresentation(restaurantOutputBody, {
        title: restaurantTask?.title,
        requirement: restaurantTask?.requirement,
      });
      const restaurantOutputReport = restaurantReportView.fullMarkdown;
      const deliverableSourceType = domain === 'content' ? 'content_employee_run' : 'agent_task';
      const deliverableSourceId = Number(domain === 'content' ? selectedRun?.id : restaurantTask?.id);
      const currentDeliverableKey = `${deliverableSourceType}:${deliverableSourceId}`;
      const currentSourceDeliverables = sourceDeliverableKey === currentDeliverableKey ? sourceDeliverables : [];
      const currentSourceDeliverablesLoading =
        sourceDeliverableKey === currentDeliverableKey && sourceDeliverablesLoading;
      const currentSourceDeliverablesError =
        sourceDeliverableKey === currentDeliverableKey ? sourceDeliverablesError : '';
      const retrySourceDeliverables = () => {
        if (!Number.isSafeInteger(deliverableSourceId) || deliverableSourceId <= 0) return;
        void loadSourceDeliverables(deliverableSourceType, deliverableSourceId, { generateIfMissing: true });
      };
      const activeRestaurantPollWarning =
        restaurantPollWarning?.taskId === String(restaurantTask?.id) &&
        restaurantPollWarning.terminal === false &&
        isTaskRunning(restaurantTask?.status);
      const selectedRunPublicStatus = selectedRun ? runStatus(selectedRun) : '';
      const currentPublicStatus = domain === 'content' ? selectedRunPublicStatus : restaurantPublicStatus;
      const hasCurrentSelection = domain === 'content' ? !!selectedRun : !!restaurantTask;
      const hasPendingReview = currentPublicStatus === '待人工审阅';
      const currentReviewFinished = ['已人工采纳（可用于业务）', '失败需返工（人工审阅未通过）'].includes(
        currentPublicStatus,
      );
      const dispatchPathStep =
        hasPendingReview || currentReviewFinished ? 2 : hasCurrentSelection || lastSnapshot ? 1 : 0;
      const restaurantContractInvalid = restaurantPublicStatus === '失败需返工（质检未通过）';
      const selectedRunBillingStatus = billingStateLabel(selectedRun?.billing, selectedRun?.status);
      const selectedRunReviewReady = selectedRun?.canReview === true;
      const selectedRunDownloadReady =
        selectedRun?.status === '已完成' &&
        (selectedRun.review?.decision === 'adopt' || selectedRunPublicStatus === '已自动采用（可用于业务）') &&
        selectedRun.billing?.state === 'settled' &&
        selectedRun.contract?.valid === true;
      const scrollToTaskCenter = () => document.getElementById(taskCenterId)?.scrollIntoView({ block: 'start' });
      const scrollToContentReview = async () => {
        const pendingRun = selectedRun && runStatus(selectedRun) === '待人工审阅' ? selectedRun : null;
        if (!pendingRun) {
          scrollToTaskCenter();
          return;
        }
        if (selectedRun?.id !== pendingRun.id) await loadRunDetail(pendingRun.id);
        window.requestAnimationFrame(() => {
          const result = document.getElementById(contentResultId);
          if (result) result.scrollIntoView({ block: 'start' });
          else scrollToTaskCenter();
        });
      };
      return (
        <div className="ewb-section ewb-conversation" aria-label={`与${profile.identity.name}对话`}>
          <div className="ewb-chat-welcome">
            <span className="ewb-chat-avatar" aria-hidden="true">
              {domain === 'restaurant' ? (
                <EmployeeAvatar
                  idx={profile.identity.idx}
                  name={String(profile.identity.person || profile.identity.name || '')}
                  color={identityColor(profile.identity) || 'var(--ui-primary)'}
                  size={36}
                />
              ) : (
                <MessageOutlined />
              )}
            </span>
            <div className="ewb-chat-bubble assistant">
              <strong>你好，我是{profile.identity.person || profile.identity.name}。</strong>
              <p>
                {text(profile.identity.intro) ||
                  text(profile.identity.duty) ||
                  '直接告诉我你想完成什么，我会在后台自动调用岗位技能、工具和可用资料。'}
              </p>
            </div>
          </div>
          <SectionHeading
            title="派活与任务"
            description={
              domain === 'content'
                ? '写清一件要做的事，提交后在同一页看进度；普通内部产出通过门禁后自动采用。'
                : '写清一件要做的事，公开信息由岗位自行联网补齐；提交后在同一页看进度、结果和费用状态。'
            }
            extra={
              <Space size={4} wrap>
                {canManageContentProfile && (
                  <Button size="small" icon={<SettingOutlined />} onClick={() => setContentProfileOpen(true)}>
                    企业品牌与账号人设
                  </Button>
                )}
                <Button
                  type="text"
                  size="small"
                  aria-expanded={dispatchGuideOpen}
                  aria-controls={dispatchGuideId}
                  onClick={() => setDispatchGuideOpen(value => !value)}
                >
                  {dispatchGuideOpen ? '收起岗位说明' : '查看岗位说明'}
                </Button>
              </Space>
            }
          />
          <Steps
            className="ewb-dispatch-path"
            size="small"
            current={dispatchPathStep}
            items={[
              { title: '一句话派活', description: '内部材料可选' },
              {
                title: '看进度',
                description: (
                  <button type="button" className="ewb-step-link" onClick={scrollToTaskCenter}>
                    打开任务列表
                  </button>
                ),
              },
              {
                title: '看结果',
                description:
                  domain === 'content' ? (
                    <button type="button" className="ewb-step-link" onClick={() => void scrollToContentReview()}>
                      {hasPendingReview && profile.permissions.canReviewRuns ? '处理待确认结果' : '查看任务结果'}
                    </button>
                  ) : (
                    <button type="button" className="ewb-step-link" onClick={scrollToTaskCenter}>
                      查看任务结果与费用
                    </button>
                  ),
              },
            ]}
          />
          <div className="ewb-status-help" aria-label="任务状态说明">
            {hasPendingReview ? (
              <div>
                <strong>这是一条旧策略历史记录</strong>
                <span>原状态仅为审计留档，不影响当前普通内部任务自动执行与采用。</span>
                <a href="/tasks">在任务中心查看</a>
              </div>
            ) : domain === 'content' ? (
              <div>
                <strong>普通内部产出自动采用</strong>
                <span>质量、账务和安全门禁通过后直接进入业务可用状态；系统不会自动外发。</span>
              </div>
            ) : null}
            <div>
              <strong>数字员工任务在哪里</strong>
              <span>数字员工和 AI 任务统一进入「任务中心」；「经营执行」只放人工任务与拆解任务。</span>
              <a href="/tasks">打开任务中心</a>
            </div>
          </div>
          <Alert
            type={dispatchAvailable ? 'info' : 'warning'}
            showIcon
            message={dispatchAvailable ? '岗位能力由系统自动锁定执行' : '该员工当前不可执行'}
            description={
              dispatchAvailable
                ? profile.permissions.canViewCapabilities
                  ? '不需要在这里逐项设置；提交后会自动保存执行快照，完整能力可在「能力」页签查看。'
                  : '不需要逐项设置；提交后会自动保存岗位执行快照，便于追溯。'
                : profile.dispatch.boundary || '请联系管理员检查员工权限与工作配置。'
            }
          />
          {dispatchGuideOpen && (
            <section
              id={dispatchGuideId}
              className="ewb-dispatch-guide"
              aria-label={`${profile.identity.name}派活操作指引`}
            >
              <div className="ewb-dispatch-guide-intro">
                <span>这个岗位怎么派活</span>
                <strong>
                  <IdcardOutlined aria-hidden /> {profile.identity.name}
                </strong>
                <p>
                  {text(guidance.intro) ||
                    `${profile.identity.name}会严格按岗位要求处理专项问题；材料不足时会标出缺口，不会猜测成事实。`}
                </p>
                <p>
                  您只需说清要解决的问题。地点、竞品、地图、评价、公开规则和实时信息由系统自行联网；下面的内部材料只是可选补充。
                </p>
              </div>
              <div className="ewb-dispatch-guide-grid">
                <div>
                  <span className="ewb-dispatch-guide-label">可选补充（没有也可开工）</span>
                  {materialChecklist.length ? (
                    <ul>
                      {materialChecklist.map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>没有附件也可直接派活；岗位会自行搜集公开信息并按任务需要调用工具。</p>
                  )}
                </div>
                <div>
                  <span className="ewb-dispatch-guide-label">这个岗位会交付</span>
                  {deliverableChecklist.length ? (
                    <ul>
                      {deliverableChecklist.map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>接口未返回岗位交付清单，请在任务要求中写明期望的结果格式。</p>
                  )}
                </div>
              </div>
              {!!taskExamples.length && (
                <div className="ewb-dispatch-examples">
                  <span className="ewb-dispatch-guide-label">可直接参考的任务</span>
                  <div>
                    {taskExamples.map((example, index) => (
                      <button
                        type="button"
                        key={`${example}-${index}`}
                        disabled={!dispatchAvailable}
                        onClick={() => dispatchForm.setFieldValue('question', example)}
                        aria-label={`使用任务示例：${example}`}
                      >
                        <b>{index + 1}</b>
                        <span>{example}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {text(guidance.evidenceTip) && (
                <p className="ewb-dispatch-evidence-tip">证据要求：{guidance.evidenceTip}</p>
              )}
            </section>
          )}
          {domain === 'content' && (
            <section id={taskCenterId} className="ewb-run-center" aria-label="内容员工任务列表">
              <SectionHeading
                title="任务列表"
                description="派活后在这里看生成、自动采用、策略确认、业务暂不可采用和失败返工状态；真实历史状态会原样保留。"
                extra={
                  <Space size={8}>
                    {Number(profile.runtime.reviewPendingRuns || 0) > 0 && (
                      <Tag color="gold">待人工审阅 {profile.runtime.reviewPendingRuns}</Tag>
                    )}
                    <Button
                      size="small"
                      icon={<ReloadOutlined />}
                      loading={runsLoading}
                      onClick={() => void loadRuns()}
                    >
                      刷新
                    </Button>
                  </Space>
                }
              />
              {runsError && (
                <Alert
                  type="error"
                  showIcon
                  message="任务列表读取失败"
                  description={runsError}
                  action={
                    <Button size="small" onClick={() => void loadRuns()}>
                      重试
                    </Button>
                  }
                />
              )}
              <div className="ewb-run-list" aria-busy={runsLoading}>
                {runs.map(run => (
                  <button
                    type="button"
                    key={run.id}
                    className={selectedRun?.id === run.id ? 'active' : ''}
                    onClick={() => void loadRunDetail(run.id)}
                  >
                    <span className="ewb-chat-user-avatar" aria-hidden="true">
                      <UserOutlined />
                    </span>
                    <span className="ewb-chat-user-message">
                      <span className="ewb-run-list-status">
                        <i className={`status-${run.status}`} />
                        <Tag color={RUN_STATUS_COLOR[runStatus(run)] || 'default'}>{runStatus(run)}</Tag>
                      </span>
                      <strong>{run.title}</strong>
                      <small>
                        {run.type || '岗位交付'} · {runTime(run.createdAt || run.updatedAt)}
                      </small>
                      {run.resultPreview && <p>{localizeOperationalStatus(run.resultPreview)}</p>}
                    </span>
                  </button>
                ))}
                {!runsLoading && !runs.length && !runsError && <HonestEmpty description="这名内容员工还没有派活记录" />}
              </div>
            </section>
          )}
          {domain === 'content' && selectedRun && (
            <section id={contentResultId} className="ewb-run-center" aria-label="当前选中的内容员工任务结果">
              <SectionHeading
                title="岗位交付报告"
                description="点击上方任务后，在这里直接阅读完整报告、查看交付文件与采用记录。"
              />
              <article className="ewb-run-detail">
                <div className="ewb-run-detail-head">
                  <div>
                    <Space size={6} wrap>
                      <Tag color={RUN_STATUS_COLOR[runStatus(selectedRun)] || 'default'}>{runStatus(selectedRun)}</Tag>
                      {selectedRun.type && <Tag>{selectedRun.type}</Tag>}
                    </Space>
                    <h4>{selectedRun.title}</h4>
                    <span>
                      <ClockCircleOutlined /> {runTime(selectedRun.createdAt || selectedRun.updatedAt)} · 运行 #
                      {selectedRun.id}
                    </span>
                  </div>
                  <Space size={6} wrap>
                    {selectedRun.resultMd && (
                      <ArtifactActions
                        title={selectedRun.title || `内容员工运行 #${selectedRun.id}`}
                        content={localizeOperationalStatus(selectedRun.resultMd)}
                        sourceType="content_employee_run"
                        sourceId={selectedRun.id}
                        onGenerated={retrySourceDeliverables}
                      />
                    )}
                    <Button
                      size="small"
                      icon={<ApartmentOutlined />}
                      onClick={() => setBusinessFlow({ sourceType: 'content_run', sourceId: selectedRun.id })}
                    >
                      查看业务流
                    </Button>
                    <Button
                      size="small"
                      icon={<EyeOutlined />}
                      loading={runDetailLoading}
                      onClick={() => void loadRunDetail(selectedRun.id)}
                    >
                      刷新详情
                    </Button>
                  </Space>
                </div>
                {selectedRun.resultMd && (
                  <SourceDeliverables
                    items={currentSourceDeliverables}
                    loading={currentSourceDeliverablesLoading}
                    error={currentSourceDeliverablesError}
                    onRetry={retrySourceDeliverables}
                  />
                )}
                {selectedRunPublicStatus === '生成中' && (
                  <EmployeeExecutionTimeline progress={selectedRun.executionProgress} title="内容员工实时执行过程" />
                )}
                {selectedRunPublicStatus === '失败需处理（执行异常）' && (
                  <Alert
                    type="error"
                    showIcon
                    message="本次执行异常，需要查明原因后再重试"
                    description={
                      selectedRun.error || '服务未返回具体原因，请先检查输入、额度和模型通道，再保留原要求重新派活。'
                    }
                    action={
                      <Button
                        size="small"
                        onClick={() => {
                          dispatchForm.setFieldsValue({
                            question: selectedRun.title || '',
                            requirement: selectedRun.requirement || '',
                          });
                          document.getElementById(dispatchFormId)?.scrollIntoView({
                            block: 'start',
                            behavior: 'smooth',
                          });
                        }}
                      >
                        带回原要求重新派活
                      </Button>
                    }
                  />
                )}
                {selectedRunPublicStatus === '历史失败（后续已修复）' && (
                  <Alert
                    type="info"
                    showIcon
                    message="历史失败（后续已修复）"
                    description={`后续权威运行 #${selectedRun.remediatedByRunId || '-'} 已采纳并关闭这条失败的待处理状态，无需再次重跑。原失败原因：${
                      selectedRun.error || '未记录具体原因'
                    }`}
                  />
                )}
                {selectedRunPublicStatus === '待人工审阅' && (
                  <Alert
                    type="info"
                    showIcon
                    message="待人工审阅：当前产物已经达到可验收条件"
                    description={
                      profile.permissions.canReviewRuns
                        ? selectedRun.nextAction || '请核对内容与证据，并在本页直接采纳或驳回。'
                        : '请等待老板、运营总监、直属经理或管理员处理。'
                    }
                  />
                )}
                {selectedRunPublicStatus === '业务暂不可采用（待账务对账）' && (
                  <Alert
                    type="warning"
                    showIcon
                    message="业务暂不可采用：账务状态尚未确认"
                    description={
                      selectedRun.nextAction || '账务确认前不进入人工审阅，也不能采纳、下载或进入内容生产仓。'
                    }
                  />
                )}
                {selectedRunPublicStatus === '失败需返工（质检未通过）' && (
                  <Alert
                    type="warning"
                    showIcon
                    message="失败需返工：产物未通过岗位质检"
                    description={`${
                      selectedRun.status === '待审阅'
                        ? '该历史记录虽曾进入待审队列，但当前权威校验不通过，不能采纳；请填写明确返工意见后驳回。'
                        : '本次不进入人工审阅；请根据质检错误补充或调整输入后重新派活。'
                    }${selectedRunBillingStatus ? `计费状态：${selectedRunBillingStatus}。` : ''}`}
                    action={
                      <Button
                        size="small"
                        onClick={() => {
                          dispatchForm.setFieldsValue({
                            question: selectedRun.title || '',
                            requirement: selectedRun.requirement || '',
                          });
                          document.getElementById(dispatchFormId)?.scrollIntoView({
                            block: 'start',
                            behavior: 'smooth',
                          });
                        }}
                      >
                        带回原要求重新派活
                      </Button>
                    }
                  />
                )}
                {selectedRun.billing && (
                  <div className={`ewb-billing-result state-${selectedRun.billing.state || 'unknown'}`}>
                    <strong>本次费用</strong>
                    <span>
                      {billingStateLabel(selectedRun.billing, selectedRun.status) || '账务状态未记录'}
                      {selectedRun.billing.note ? `；${localizeOperationalStatus(selectedRun.billing.note)}` : ''}
                    </span>
                    {selectedRun.billing.chargedCredits != null && (
                      <small>实扣 {selectedRun.billing.chargedCredits} 积分</small>
                    )}
                  </div>
                )}
                {profile.permissions.canReviewRuns && !selectedRunReviewReady && selectedRun.reviewBlockedReason && (
                  <Alert
                    type="info"
                    showIcon
                    message="当前没有可执行的审阅动作"
                    description={`${selectedRun.reviewBlockedReason}。下一步：${
                      selectedRun.nextAction || '查看当前状态说明后处理'
                    }`}
                  />
                )}
                {profile.permissions.canReviewRuns && selectedRunReviewReady && (
                  <div className="ewb-run-review-actions">
                    {selectedRun.canAdopt === true && (
                      <Button type="primary" loading={reviewing} onClick={() => confirmAdoptRun(selectedRun)}>
                        {selectedRun.handlerApproval?.candidateSelectionRequired ? '选择并采纳' : '采纳'}
                      </Button>
                    )}
                    {selectedRun.canReject === true && (
                      <Button
                        danger
                        disabled={reviewing}
                        onClick={() => {
                          setRejectOpinion('');
                          setRejectRun(selectedRun);
                        }}
                      >
                        驳回
                      </Button>
                    )}
                  </div>
                )}
                {selectedRun.resultMd && (
                  <ContentEmployeeResult
                    raw={localizeOperationalStatus(selectedRun.resultMd)}
                    title={selectedRun.title || `内容员工运行 #${selectedRun.id}`}
                    runId={selectedRun.id}
                  />
                )}
                {!!selectedRun.contract?.artifacts.length && (
                  <div className="ewb-run-artifacts">
                    <strong>岗位产物</strong>
                    <Space wrap>
                      {selectedRun.contract.artifacts.map((artifact, index) =>
                        selectedRunDownloadReady && artifact.downloadUrl ? (
                          <Button
                            key={`${artifact.filename}-${index}`}
                            icon={<FileTextOutlined />}
                            href={artifact.downloadUrl}
                          >
                            下载 {artifact.filename || 'HTML演绎稿'}
                          </Button>
                        ) : (
                          <Tag key={`${artifact.filename}-${index}`}>
                            {artifact.filename || artifact.kind || `产物 ${index + 1}`}
                          </Tag>
                        ),
                      )}
                    </Space>
                    <p>
                      {selectedRunDownloadReady
                        ? '已采纳岗位产物通过受控附件地址下载；工作台不会执行附件代码或内嵌预览不可信内容。'
                        : '当前仅展示产物元数据；完成真实来源校验、账务结算和人工采纳后才开放下载。'}
                    </p>
                  </div>
                )}
                {selectedRun.review && (
                  <div className="ewb-run-review-record">
                    <strong>
                      {selectedRun.review.decision === 'adopt'
                        ? '已人工采纳（可用于业务）'
                        : '人工审阅未通过（需返工）'}
                    </strong>
                    <span>
                      {selectedRun.review.reviewerName || '审阅人未记录'} · {runTime(selectedRun.review.reviewedAt)}
                    </span>
                    {selectedRun.review.materialId && <span>内容生产仓素材 #{selectedRun.review.materialId}</span>}
                    {selectedRun.review.contentId && <span>可发布内容 #{selectedRun.review.contentId}</span>}
                    {selectedRun.review.opinion && <p>{selectedRun.review.opinion}</p>}
                  </div>
                )}
                {(selectedRun.industry ||
                  selectedRun.feedback ||
                  selectedRun.requirement ||
                  selectedRun.attachments?.length ||
                  selectedRun.billing ||
                  selectedRun.contract?.errors.length) && (
                  <details className="ewb-raw-details">
                    <summary>查看任务输入、计费与契约细节</summary>
                    <div className="ewb-run-supplement">
                      <div className="ewb-run-inputs">
                        {selectedRun.industry && (
                          <div>
                            <span>行业 / 赛道</span>
                            <p>{selectedRun.industry}</p>
                          </div>
                        )}
                        {selectedRun.requirement && (
                          <div>
                            <span>本次材料与约束</span>
                            <p>{selectedRun.requirement}</p>
                          </div>
                        )}
                        {selectedRun.feedback && (
                          <div>
                            <span>上一版意见 / 必须落实</span>
                            <p>{selectedRun.feedback}</p>
                          </div>
                        )}
                        {!!selectedRun.attachments?.length && (
                          <div>
                            <span>统一文件中心附件</span>
                            <Space size={[4, 4]} wrap>
                              {selectedRun.attachments.map((file, index) => (
                                <Tag key={`${file.id || file.name}-${index}`} color={file.readable ? 'blue' : 'orange'}>
                                  {file.name || `附件 ${index + 1}`}
                                </Tag>
                              ))}
                            </Space>
                          </div>
                        )}
                      </div>
                      {selectedRun.billing && (
                        <p className="ewb-run-supplement-note">
                          计费状态：
                          {billingStateLabel(selectedRun.billing, selectedRun.status) || '未记录'}
                          {selectedRun.billing.note ? `；${localizeOperationalStatus(selectedRun.billing.note)}` : ''}
                        </p>
                      )}
                      {!!selectedRun.contract?.errors.length && (
                        <ul className="ewb-contract-errors">
                          {selectedRun.contract.errors.map((error, index) => (
                            <li key={index}>{error}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </details>
                )}
              </article>
            </section>
          )}
          {domain === 'restaurant' && (
            <section id={taskCenterId} className="ewb-run-center" aria-label="餐饮数字员工任务列表">
              <SectionHeading
                title="任务列表"
                description="这里是已保存的派活记录，关闭工作台后仍可回来查看。"
                extra={
                  <Space size={8}>
                    {Number(profile.runtime.reviewPendingRuns || 0) > 0 && (
                      <Tag color="gold">待人工审阅 {profile.runtime.reviewPendingRuns}</Tag>
                    )}
                    <Button
                      size="small"
                      icon={<ReloadOutlined />}
                      loading={restaurantTasksRefreshing}
                      onClick={() => void refreshRestaurantTasks()}
                    >
                      刷新
                    </Button>
                  </Space>
                }
              />
              <div className="ewb-run-list" aria-busy={!!restaurantTaskLoading}>
                {restaurantRecentTasks.map(task => (
                  <button
                    type="button"
                    key={task.id}
                    className={String(restaurantTask?.id) === String(task.id) ? 'active' : ''}
                    disabled={restaurantTaskLoading === String(task.id)}
                    onClick={() => void loadRestaurantTask(task.id, { scrollToResult: true })}
                  >
                    <span className="ewb-chat-user-avatar" aria-hidden="true">
                      <UserOutlined />
                    </span>
                    <span className="ewb-chat-user-message">
                      <span className="ewb-run-list-status">
                        <i className={`status-${text(task.status)}`} />
                        <Tag color={RUN_STATUS_COLOR[restaurantStatus(task)] || 'default'}>
                          {restaurantStatus(task)}
                        </Tag>
                      </span>
                      <strong>{task.title || `任务 #${task.id}`}</strong>
                      <small>
                        {task.type || '岗位交付'} · {runTime(task.createdAt || task.created_at)} · #{task.id}
                      </small>
                      <span className="ewb-run-list-action">
                        <EyeOutlined />{' '}
                        {isTaskRunning(task.status)
                          ? '查看实时进度'
                          : task.failed || text(task.status) === '失败'
                            ? '查看执行记录'
                            : '查看完整结果'}
                      </span>
                    </span>
                  </button>
                ))}
                {!restaurantRecentTasks.length && <HonestEmpty description="这名员工还没有派活记录" />}
              </div>
              {profile.runtime.taskPage?.hasMore && (
                <div className="ewb-run-more">
                  <Button loading={restaurantTasksLoadingMore} onClick={() => void loadMoreRestaurantTasks()}>
                    加载更多（已显示 {restaurantRecentTasks.length} / {profile.runtime.taskPage.total}）
                  </Button>
                </div>
              )}
            </section>
          )}
          {domain === 'restaurant' && restaurantTask && (
            <Alert
              showIcon
              type={
                restaurantTask.failed
                  ? 'error'
                  : restaurantContractInvalid
                    ? 'warning'
                    : isBusinessUsableStatus(restaurantPublicStatus)
                      ? 'success'
                      : 'info'
              }
              message={
                restaurantContractInvalid
                  ? '此结果未通过岗位契约，不能采纳'
                  : `任务 #${restaurantTask.id} · ${restaurantPublicStatus}`
              }
              description={
                <div className="ewb-task-progress">
                  <div className="ewb-task-progress-actions">
                    <Button
                      size="small"
                      icon={<ApartmentOutlined />}
                      onClick={() =>
                        setBusinessFlow({ sourceType: 'restaurant_task', sourceId: Number(restaurantTask.id) })
                      }
                    >
                      查看业务流
                    </Button>
                  </div>
                  {activeRestaurantPollWarning && restaurantPollWarning && (
                    <div className="ewb-task-poll-warning" role="status" aria-live="polite">
                      <ReloadOutlined spin aria-hidden="true" />
                      <span>
                        <strong>{restaurantPollWarning.title}</strong>
                        {restaurantPollWarning.detail}
                      </span>
                    </div>
                  )}
                  <Steps
                    size="small"
                    current={restaurantTask.failed ? 1 : (restaurantTask.stepIndex ?? 1)}
                    status={
                      restaurantTask.failed
                        ? 'error'
                        : isBusinessUsableStatus(restaurantPublicStatus)
                          ? 'finish'
                          : 'process'
                    }
                    items={(
                      restaurantTask.flow || ['已派发', 'AI生成中', '质量与账务门禁', '已自动采用（可用于业务）']
                    ).map((step: string) => ({
                      title:
                        step === '待审阅' || step === '待审核'
                          ? '旧策略/显式策略待处理'
                          : step === '已完成' || step === '已通过'
                            ? '已采用（可用于业务）'
                            : canonicalDisplayStatus(step),
                    }))}
                  />
                  <div className="ewb-task-progress-note">
                    {restaurantContractInvalid ? (
                      <span>本次未形成可验收产物，不会进入业务可用状态；请补充或调整材料后重新派活。</span>
                    ) : restaurantTask.failed ? (
                      `${restaurantTask.failure?.message || '生成失败'}。${restaurantTask.nextAction || '查看失败原因，补充或调整输入后重新派活'}。未形成业务产物；计费结果请以业务流中的积分账务节点为准。`
                    ) : restaurantPublicStatus === '待派活' ? (
                      <>
                        <span>这是旧任务记录，还没有绑定具体数字员工执行档案。</span>
                        <span>请重新选择员工派活，本记录不会继续假显示运行中。</span>
                      </>
                    ) : isTaskRunning(restaurantTask.status) ? (
                      activeRestaurantPollWarning ? (
                        <>
                          <span>当前无法确认最新生成进度，下方仅保留上次服务端已确认的状态。</span>
                          {restaurantTask.generationProgress && (
                            <span>
                              {isWaitingForFirstModelCharacter(restaurantTask.generationProgress)
                                ? '上次确认：模型正在推理，等待首字返回'
                                : `上次收到约 ${restaurantTask.generationProgress.receivedChars.toLocaleString('zh-CN')} 个响应字符（仅表示流式进度，不是质检阈值）`}{' '}
                              · 最近活动 {runTime(restaurantTask.generationProgress.lastActivityAt)}
                            </span>
                          )}
                        </>
                      ) : restaurantTask.generationProgress ? (
                        <>
                          <span>
                            {isWaitingForFirstModelCharacter(restaurantTask.generationProgress)
                              ? '模型正在推理，等待首字返回'
                              : `云端流式生成中 · 已接收约 ${restaurantTask.generationProgress.receivedChars.toLocaleString('zh-CN')} 个响应字符（不是质检阈值）`}{' '}
                            · 当前阶段：
                            {restaurantTask.generationProgress.currentLabel || '正在准备岗位交付'} · 最近活动{' '}
                            {runTime(restaurantTask.generationProgress.lastActivityAt)}
                          </span>
                          <span>
                            第 {restaurantTask.generationProgress.attemptNumber} 次
                            {restaurantTask.generationProgress.phase === 'repair' ? '定向修复' : '生成'}；此处每 5
                            秒自动刷新，也可关闭窗口等待站内通知。
                          </span>
                        </>
                      ) : (
                        <>
                          数字员工正在奋笔疾书
                          <span className="nw-typing">
                            <i />
                            <i />
                            <i />
                          </span>{' '}
                          此处每 5 秒自动刷新；也可关闭窗口，完成后会收到站内通知。
                        </>
                      )
                    ) : restaurantPublicStatus === '业务暂不可采用（待账务对账）' ? (
                      <>
                        <span>当前只完成技术生成，积分账务尚未终结，因此不会形成业务可用结果。</span>
                        <span>{restaurantTask.nextAction || '请等待完成账务对账。'}</span>
                      </>
                    ) : restaurantPublicStatus === '待人工审阅' ? (
                      <>
                        <span>这是旧策略留下的历史状态，仅作审计留档，不影响当前普通内部任务自动执行。</span>
                        <a href="/tasks">在任务中心查看</a>
                      </>
                    ) : (
                      '任务已结束；产出与证据可在「经营洞察 → 员工产出」中随时回看。'
                    )}
                  </div>
                  {isTaskRunning(restaurantTask.status) && (
                    <>
                      <EmployeeExecutionTimeline
                        progress={restaurantTask.generationProgress}
                        title="餐饮数字员工实时执行过程"
                        compact
                      />
                      <EmployeeResearchPlan evidence={restaurantTask.executionSnapshot?.webEvidence} compact />
                    </>
                  )}
                </div>
              }
            />
          )}
          {domain === 'restaurant' &&
            restaurantTask &&
            (!isTaskRunning(restaurantTask.status) || Boolean(restaurantOutputBody)) && (
              <section id={restaurantResultId} className="ewb-run-center" aria-label="当前选中的餐饮员工任务结果">
                <SectionHeading
                  title={restaurantOutputBody ? '岗位交付报告' : '任务结果与失败诊断'}
                  description={
                    restaurantOutputBody
                      ? '点击上方任意任务后，在这里直接查看完整产物，不再需要绕到其他页面。'
                      : '本次没有生成业务产物；原因、账务结果和下一步都在这里。'
                  }
                />
                <article className="ewb-run-detail">
                  <div className="ewb-run-detail-head">
                    <div>
                      <Space size={6} wrap>
                        <Tag color={RUN_STATUS_COLOR[restaurantPublicStatus] || 'default'}>
                          {restaurantPublicStatus}
                        </Tag>
                        {restaurantTask.type && <Tag>{restaurantTask.type}</Tag>}
                      </Space>
                      <h4>{restaurantTask.title || `任务 #${restaurantTask.id}`}</h4>
                      <span>
                        <ClockCircleOutlined /> {runTime(restaurantTask.createdAt || restaurantTask.created_at)} · 任务
                        #{restaurantTask.id}
                      </span>
                    </div>
                    <Space size={6} wrap>
                      {restaurantOutputBody && (
                        <ArtifactActions
                          title={restaurantTask.title || `任务 #${restaurantTask.id}`}
                          content={localizeOperationalStatus(restaurantOutputReport)}
                          sourceType="agent_task"
                          sourceId={Number(restaurantTask.id)}
                          onGenerated={retrySourceDeliverables}
                        />
                      )}
                      <Button
                        size="small"
                        icon={<ApartmentOutlined />}
                        onClick={() =>
                          setBusinessFlow({ sourceType: 'restaurant_task', sourceId: Number(restaurantTask.id) })
                        }
                      >
                        查看业务流
                      </Button>
                      <Button
                        size="small"
                        icon={<ReloadOutlined />}
                        loading={restaurantTaskLoading === String(restaurantTask.id)}
                        onClick={() => void loadRestaurantTask(restaurantTask.id)}
                      >
                        刷新结果
                      </Button>
                    </Space>
                  </div>
                  {restaurantOutputBody ? (
                    <>
                      <div className="ewb-report-view" aria-label="餐饮数字员工岗位报告">
                        <section className="ewb-run-output ewb-report-overview" aria-label="老板速览">
                          <div className="ewb-report-eyebrow">
                            <span>老板速览</span>
                            <small>先看结论、证据、风险与行动</small>
                          </div>
                          <Markdown content={localizeOperationalStatus(restaurantReportView.overviewMarkdown)} />
                        </section>
                        {!restaurantReportView.structured &&
                          restaurantReportView.markdownReport &&
                          restaurantReportView.deliverablesMarkdown && (
                            <details className="ewb-report-details">
                              <summary>
                                <span>
                                  <strong>完整报告</strong>
                                  <small>展开查看全部分析、表格与来源标注</small>
                                </span>
                                <ArrowDownOutlined aria-hidden />
                              </summary>
                              <div className="ewb-report-details-body">
                                <Markdown
                                  content={localizeOperationalStatus(restaurantReportView.deliverablesMarkdown)}
                                />
                              </div>
                            </details>
                          )}
                        {restaurantReportView.structured && restaurantReportView.deliverablesMarkdown && (
                          <details className="ewb-report-details">
                            <summary>
                              <span>
                                <strong>岗位完整成果</strong>
                                <small>{restaurantReportView.deliverableCount} 项岗位专属交付，展开查看全部栏目</small>
                              </span>
                              <ArrowDownOutlined aria-hidden />
                            </summary>
                            <div className="ewb-report-details-body">
                              <Markdown
                                content={localizeOperationalStatus(restaurantReportView.deliverablesMarkdown)}
                              />
                            </div>
                          </details>
                        )}
                        {restaurantReportView.structured && restaurantReportView.inputMethodMarkdown && (
                          <details className="ewb-report-details is-method">
                            <summary>
                              <span>
                                <strong>输入与方法执行记录</strong>
                                <small>逐项看本轮业务结果、缺口与闭环动作</small>
                              </span>
                              <ArrowDownOutlined aria-hidden />
                            </summary>
                            <div className="ewb-report-details-body">
                              <Markdown content={localizeOperationalStatus(restaurantReportView.inputMethodMarkdown)} />
                            </div>
                          </details>
                        )}
                        {restaurantReportView.structured && restaurantReportView.governanceMarkdown && (
                          <details className="ewb-report-details is-governance">
                            <summary>
                              <span>
                                <strong>质量与授权记录</strong>
                                <small>完整检查项和外发、付费边界</small>
                              </span>
                              <ArrowDownOutlined aria-hidden />
                            </summary>
                            <div className="ewb-report-details-body">
                              <Markdown content={localizeOperationalStatus(restaurantReportView.governanceMarkdown)} />
                            </div>
                          </details>
                        )}
                        {restaurantReportView.structured && restaurantReportView.technicalAppendixMarkdown && (
                          <details className="ewb-report-details is-technical">
                            <summary>
                              <span>
                                <strong>技术附录</strong>
                                <small>契约、内部标识与证据回指</small>
                              </span>
                              <ArrowDownOutlined aria-hidden />
                            </summary>
                            <div className="ewb-report-details-body">
                              <Markdown
                                content={localizeOperationalStatus(restaurantReportView.technicalAppendixMarkdown)}
                              />
                            </div>
                          </details>
                        )}
                      </div>
                      <SourceDeliverables
                        items={currentSourceDeliverables}
                        loading={currentSourceDeliverablesLoading}
                        error={currentSourceDeliverablesError}
                        onRetry={retrySourceDeliverables}
                      />
                      <details className="ewb-report-details is-operational">
                        <summary>
                          <span>
                            <strong>运行与交付记录</strong>
                            <small>取证过程、账务状态与改进建议</small>
                          </span>
                          <ArrowDownOutlined aria-hidden />
                        </summary>
                        <div className="ewb-report-details-body ewb-report-operational-body">
                          <EmployeeResearchPlan evidence={restaurantTask.executionSnapshot?.webEvidence} />
                          <Alert
                            type={isBusinessUsableStatus(restaurantPublicStatus) ? 'success' : 'warning'}
                            showIcon
                            message={
                              isBusinessUsableStatus(restaurantPublicStatus)
                                ? '本次结果可作为业务判断材料'
                                : `本次结果状态：${restaurantPublicStatus || restaurantTask.status || '待确认'}`
                            }
                            description={
                              isBusinessUsableStatus(restaurantPublicStatus)
                                ? '涉及地图、竞品、价格或经营数字时，仍以报告列明的证据范围和待核验项为准。'
                                : '未达到业务可用状态的结果不得直接用于外部执行。'
                            }
                          />
                          {restaurantTask.billing && (
                            <div className={`ewb-billing-result state-${restaurantTask.billing.state || 'unknown'}`}>
                              <strong>本次费用</strong>
                              <span>{restaurantTask.billing.label || '账务状态未记录'}</span>
                              {restaurantTask.billing.costYuan != null && (
                                <small>供应商成本 ¥{Number(restaurantTask.billing.costYuan).toFixed(4)}</small>
                              )}
                            </div>
                          )}
                          {!!restaurantTask.executionSnapshot?.outputContract?.warnings?.length && (
                            <Alert
                              type="info"
                              showIcon
                              message="可继续完善的建议（不影响查看本次产物）"
                              description={
                                <ul className="ewb-contract-errors">
                                  {restaurantTask.executionSnapshot.outputContract.warnings
                                    .slice(0, 8)
                                    .map((warning, index) => (
                                      <li key={index}>{warning}</li>
                                    ))}
                                </ul>
                              }
                            />
                          )}
                        </div>
                      </details>
                    </>
                  ) : (
                    <>
                      <Alert
                        type="error"
                        showIcon
                        message="未形成业务产物"
                        description={`${restaurantTask.failure?.message || '执行过程发生异常'}。${restaurantTask.nextAction || '补充或调整要求后重新派活'}。`}
                      />
                      <div className="ewb-no-output">
                        <strong>为什么没有输出</strong>
                        <p>
                          {restaurantTask.failure?.message ||
                            '任务在形成可交付正文前已终止，因此不展示伪造或未通过门禁的结果。'}
                        </p>
                        {restaurantTask.failure?.code && <Tag>错误码：{restaurantTask.failure.code}</Tag>}
                        <Button
                          type="primary"
                          onClick={() => {
                            dispatchForm.setFieldsValue({
                              question: restaurantTask.title || '',
                              requirement: restaurantTask.requirement || '',
                            });
                            document
                              .getElementById(dispatchFormId)
                              ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                          }}
                        >
                          带回原要求重新派活
                        </Button>
                      </div>
                    </>
                  )}
                  {(restaurantTask.requirement || restaurantTask.output_status) && (
                    <details className="ewb-raw-details">
                      <summary>查看任务要求与交付状态</summary>
                      <div className="ewb-run-supplement">
                        {restaurantTask.requirement && (
                          <div className="ewb-run-inputs">
                            <div>
                              <span>原始任务要求</span>
                              <p>{restaurantTask.requirement}</p>
                            </div>
                          </div>
                        )}
                        {restaurantTask.output_status && <Tag>产物状态：{restaurantTask.output_status}</Tag>}
                      </div>
                    </details>
                  )}
                </article>
              </section>
            )}
          <div id={dispatchFormId} className="ewb-chat-composer ewb-dispatch-form-anchor">
            <Form form={dispatchForm} requiredMark={false} onFinish={submitDispatch}>
              <div className="ewb-chat-composer-row">
                <Form.Item
                  name="question"
                  noStyle
                  rules={[
                    { required: true, message: `请写明要交给${profile.identity.name}的具体任务` },
                    { min: 2, message: '问题至少2个字' },
                  ]}
                >
                  <Input.TextArea
                    autoSize={{ minRows: 2, maxRows: 6 }}
                    maxLength={8000}
                    disabled={!dispatchAvailable}
                    placeholder={`发消息给${profile.identity.person || profile.identity.name}，说清想要的结果…`}
                    onPressEnter={event => {
                      if (event.shiftKey || event.nativeEvent.isComposing) return;
                      event.preventDefault();
                      dispatchForm.submit();
                    }}
                  />
                </Form.Item>
                <Tooltip
                  title={
                    dispatchVoice.listening
                      ? '点击停止聆听'
                      : '用说的：点击后直接说任务，识别在本机浏览器完成，不扣积分'
                  }
                >
                  <Button
                    className={dispatchVoice.listening ? 'ewb-chat-voice nw-voice-listening' : 'ewb-chat-voice'}
                    icon={<AudioOutlined />}
                    danger={dispatchVoice.listening}
                    loading={dispatchVoiceRefining}
                    disabled={!dispatchAvailable}
                    aria-pressed={dispatchVoice.listening}
                    aria-label={dispatchVoice.listening ? '停止语音输入' : '语音说任务'}
                    onClick={dispatchVoice.toggleVoice}
                  />
                </Tooltip>
                <Button
                  className="ewb-chat-send"
                  type="primary"
                  htmlType="submit"
                  icon={<SendOutlined />}
                  loading={saving === 'dispatch'}
                  disabled={!dispatchAvailable}
                  aria-label={`发送给${profile.identity.person || profile.identity.name}`}
                >
                  发送
                </Button>
              </div>
              <div className="ewb-chat-composer-tools">
                <span className="ewb-chat-attachment-label">
                  <PaperClipOutlined aria-hidden="true" /> 附件
                </span>
                <UnifiedFilePicker
                  compact
                  files={dispatchFiles}
                  onChange={setDispatchFiles}
                  purpose={`employee-workbench-${domain}`}
                  maxFiles={6}
                  label="选择或上传文件"
                />
                <span className="ewb-chat-shortcut">Enter 发送 · Shift + Enter 换行</span>
              </div>
              <Form.Item name="requirement" hidden>
                <Input />
              </Form.Item>
              <Form.Item name="type" hidden>
                <Input />
              </Form.Item>
              {domain === 'content' && (
                <>
                  <Form.Item name="platforms" hidden>
                    <Input />
                  </Form.Item>
                  <Form.Item name="imageMode" hidden>
                    <Input />
                  </Form.Item>
                  <Form.Item name="imageCount" hidden>
                    <Input />
                  </Form.Item>
                  <Form.Item name="enableDeck" hidden valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </>
              )}
            </Form>
          </div>
          {lastSnapshot && (
            <Alert
              type="success"
              showIcon
              message="任务已建立，执行快照已保存"
              description={
                canViewInternalProfile
                  ? [
                      lastSnapshot.profileVersion && '岗位档案快照已保存',
                      lastSnapshot.promptHash && `提示词 ${String(lastSnapshot.promptHash).slice(0, 12)}…`,
                      profile.permissions.canViewCapabilities &&
                        Number.isFinite(lastSnapshot.capabilityCount) &&
                        `${lastSnapshot.capabilityCount} 项能力`,
                      lastSnapshot.configVersion && '工作配置快照已保存',
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : '可在任务列表查看进度和结果。'
              }
            />
          )}
        </div>
      );
    })();

  const capabilityTab = profile && (
    <div className="ewb-section">
      <SectionHeading title="完整能力" description="岗位必备能力是出厂硬能力，每次开工全部锁定运用，不能关闭或打折。" />
      <Alert
        type="info"
        showIcon
        message={`岗位必备能力 ${profile.capabilities.filter(item => item.required !== false).length} 项，全部锁定启用`}
        description="技能库中的附加技能可以更新，但不会替代、删减或绕过这些岗位必备能力。"
      />
      <LockedCapabilities capabilities={profile.capabilities} />
    </div>
  );

  const skillsTab = profile && (
    <div className="ewb-section">
      <SectionHeading
        title="技能库"
        description={`岗位技能已完成目录与默认注入验证并锁定启用（${verifiedDefaultSkillCount} 项）；本企业自定义技能另行展示。`}
        extra={
          profile.permissions.canEditSkills ? (
            <Space wrap>
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                loading={skillLearningLoading || ['queued', 'running'].includes(skillLearningRun?.status || '')}
                disabled={['queued', 'running'].includes(skillLearningRun?.status || '')}
                onClick={() => void startSkillLearning()}
              >
                全网进修
              </Button>
              <Button icon={<PlusOutlined />} onClick={() => setCustomSkillOpen(true)}>
                添加自定义技能
              </Button>
            </Space>
          ) : undefined
        }
      />
      {profile.skillLibrary.boundary && <Alert type="info" showIcon message={profile.skillLibrary.boundary} />}
      {skillLearningRun && (
        <Alert
          type={
            skillLearningRun.status === 'completed'
              ? 'success'
              : skillLearningRun.status === 'failed' || skillLearningRun.status === 'pending_reconciliation'
                ? 'error'
                : 'info'
          }
          showIcon
          message={`最近进修 #${skillLearningRun.id} · ${
            skillLearningRun.status === 'queued'
              ? '排队中'
              : skillLearningRun.status === 'running'
                ? '正在检索与学习'
                : skillLearningRun.status === 'completed'
                  ? `完成，新增${skillLearningRun.skillsAdded}条技能`
                  : skillLearningRun.status === 'pending_reconciliation'
                    ? '失败，账务待对账'
                    : '失败，预授权已退回'
          }`}
          description={[
            skillLearningRun.progress?.[skillLearningRun.progress.length - 1]?.message,
            skillLearningRun.billing?.webCostUsd != null
              ? `联网调研成本 $${Number(skillLearningRun.billing.webCostUsd).toFixed(4)}`
              : '',
            skillLearningRun.billing?.chargedCredits != null
              ? `最终模型实扣 ${skillLearningRun.billing.chargedCredits} 积分`
              : '',
            skillLearningRun.error?.message,
          ]
            .filter(Boolean)
            .join(' · ')}
        />
      )}
      <div className="ewb-skill-group">
        <h4>岗位技能 · 已验证并默认启用</h4>
        {skills.factory.length ? (
          <div className="ewb-skill-list">
            {skills.factory.map((skill, index) => (
              <SkillCard
                key={skill.id || skill.key || `${skillTitle(skill)}-${index}`}
                skill={skill}
                kind="factory"
                editable={!!profile.permissions.canEditSkills}
                saving={saving === 'skills'}
                onToggle={() => void toggleOptionalSkill(skill)}
              />
            ))}
          </div>
        ) : (
          <HonestEmpty description="接口没有返回出厂岗位 Skill" />
        )}
      </div>
      <div className="ewb-skill-group">
        <h4>全网进修技能 · 有受控来源并自动用于下一次派活</h4>
        {skills.learned.length ? (
          <div className="ewb-skill-list">
            {skills.learned.map((skill, index) => (
              <SkillCard
                key={skill.id || skill.key || `${skillTitle(skill)}-${index}`}
                skill={skill}
                kind="learned"
                editable={!!profile.permissions.canEditSkills}
                saving={saving === 'skills'}
                onToggle={() => void toggleCustomSkill(skill)}
              />
            ))}
          </div>
        ) : (
          <HonestEmpty description="尚未执行全网进修；点击上方按钮后，系统会真实检索并受控核验来源。" />
        )}
      </div>
      <div className="ewb-skill-group">
        <h4>本企业自定义技能</h4>
        {skills.custom.length ? (
          <div className="ewb-skill-list">
            {skills.custom.map((skill, index) => (
              <SkillCard
                key={skill.id || skill.key || `${skillTitle(skill)}-${index}`}
                skill={skill}
                kind="custom"
                editable={!!profile.permissions.canEditSkills}
                saving={saving === 'skills'}
                onToggle={() => void toggleCustomSkill(skill)}
                onDelete={() => deleteCustomSkill(skill)}
              />
            ))}
          </div>
        ) : (
          <HonestEmpty description="尚未配置企业自定义技能" />
        )}
      </div>
    </div>
  );

  const promptTab = profile && (
    <div className="ewb-section">
      <SectionHeading
        title="提示词"
        description="完整展示岗位默认、流水线、单独派活、企业覆盖、生效摘要与审计哈希；不会展示密钥或系统安全规则。"
        extra={
          profile.permissions.canEditPrompt ? (
            <Space>
              <Button onClick={() => setPromptDraft('')} disabled={saving === 'prompt'}>
                恢复默认
              </Button>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={saving === 'prompt'}
                onClick={() => void savePrompt()}
              >
                保存生效
              </Button>
            </Space>
          ) : undefined
        }
      />
      {profile.prompts.finalOutputContract && (
        <Alert
          type="success"
          showIcon
          message="当前岗位最终输出契约 · 最高格式优先级"
          description={
            <div>
              <div>
                格式：{profile.prompts.finalOutputContract.format || 'json_object'}； 主产物：
                {profile.prompts.finalOutputContract.primaryArtifact || 'json'}； 必须字段：
                {profile.prompts.finalOutputContract.outputKeys?.join('、') || '接口未提供'}。
              </div>
              <div style={{ marginTop: 4 }}>
                来源模板中若仍有“只输出 Markdown”等旧通用要求，以当前岗位最终 JSON 契约为准；来源原文仍保留供追溯。
              </div>
            </div>
          }
        />
      )}
      {!profile.permissions.canViewPrompt ? (
        <Alert type="warning" showIcon message="当前账号没有查看岗位提示词的权限" />
      ) : (
        <>
          {profile.prompts.boundary && <Alert type="info" showIcon message={profile.prompts.boundary} />}
          <div className="ewb-prompt-grid">
            <div className="ewb-panel">
              <h4>出厂默认提示词</h4>
              <pre className="ewb-codebox">
                {text(profile.prompts.defaultTemplate) || text(profile.prompts.default) || '接口未提供默认提示词'}
              </pre>
            </div>
            {text(profile.prompts.pipelinePrompt?.template) && (
              <div className="ewb-panel">
                <h4>流水线岗位提示词</h4>
                <pre className="ewb-codebox">{profile.prompts.pipelinePrompt?.template}</pre>
                <div className="ewb-prompt-meta">
                  <span>消息模式：{profile.prompts.pipelinePrompt?.messageMode || '未标注'}</span>
                </div>
              </div>
            )}
            {text(profile.prompts.soloPrompt?.template) && (
              <div className="ewb-panel">
                <h4>单独派活提示词</h4>
                <pre className="ewb-codebox">{profile.prompts.soloPrompt?.template}</pre>
                <div className="ewb-prompt-meta">
                  <span>消息模式：{profile.prompts.soloPrompt?.messageMode || '未标注'}</span>
                </div>
              </div>
            )}
            <div className="ewb-panel">
              <h4>企业覆盖提示词</h4>
              <Input.TextArea
                className="ewb-codebox"
                value={promptDraft}
                rows={12}
                readOnly={!profile.permissions.canEditPrompt}
                onChange={event => setPromptDraft(event.target.value)}
                placeholder={profile.permissions.canEditPrompt ? '留空表示使用出厂默认提示词' : '当前没有企业覆盖'}
              />
            </div>
            <div className="ewb-panel wide">
              <h4>当前生效摘要</h4>
              <p style={{ margin: 0, color: 'var(--ui-text-2)', lineHeight: 1.75 }}>
                {text(profile.prompts.effectiveSummary) ||
                  text(profile.prompts.summary) ||
                  (text(profile.prompts.effectiveTemplate)
                    ? `${text(profile.prompts.effectiveTemplate).slice(0, 500)}${text(profile.prompts.effectiveTemplate).length > 500 ? '…' : ''}`
                    : '接口未提供生效提示词摘要')}
              </p>
              <div className="ewb-prompt-meta" style={{ marginTop: 11 }}>
                {(profile.prompts.effectiveHash || profile.prompts.hash) && (
                  <span>
                    SHA-256：
                    <Typography.Text copyable>{profile.prompts.effectiveHash || profile.prompts.hash}</Typography.Text>
                  </span>
                )}
              </div>
            </div>
            {profile.prompts.systemPrompt?.reason && (
              <Alert
                className="wide"
                type="info"
                showIcon
                message={`系统消息：${profile.prompts.systemPrompt.messageMode || '未配置'}`}
                description={profile.prompts.systemPrompt.reason}
              />
            )}
          </div>
        </>
      )}
    </div>
  );

  const configTab = profile && (
    <div className="ewb-section">
      <SectionHeading
        title="工作配置"
        description="配置只改变执行参数，不会停用岗位必备能力。"
        extra={
          profile.permissions.canEditConfig && configFields.length ? (
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={saving === 'config'}
              onClick={() => void saveConfig()}
            >
              保存配置
            </Button>
          ) : undefined
        }
      />
      <Alert
        type="warning"
        showIcon
        message="质检不是字数或字节门槛，也没有需要手工填写的“合格字数”"
        description="运行中显示的字符数只表示云端流式响应进度。请到「工作方式」查看本岗位质量关卡，到「岗位档案」查看质量标准与输出契约；这里可调整模型、联网、篇幅、容错和费用，但事实、安全与交付完整性检查不会被关闭。"
      />
      {profile.workConfig.boundary && <Alert type="info" showIcon message={profile.workConfig.boundary} />}
      {profile.workConfig.summary && <Alert type="info" showIcon message={profile.workConfig.summary} />}
      {profile.workConfig.factoryDefault !== undefined && (
        <details className="ewb-raw-details" open>
          <summary>出厂锁定配置</summary>
          <pre className="ewb-codebox">{JSON.stringify(profile.workConfig.factoryDefault, null, 2)}</pre>
        </details>
      )}
      {profile.workConfig.safeLegacyConfig !== undefined && (
        <details className="ewb-raw-details">
          <summary>安全迁移配置</summary>
          <pre className="ewb-codebox">{JSON.stringify(profile.workConfig.safeLegacyConfig, null, 2)}</pre>
        </details>
      )}
      {configFields.length ? (
        <div className="ewb-panel">
          <Form form={configForm} layout="vertical" disabled={!profile.permissions.canEditConfig}>
            <div className="ewb-config-grid">
              {configFields.map(field => (
                <Form.Item
                  key={field.key}
                  name={field.key}
                  label={field.label}
                  valuePropName={field.type === 'boolean' ? 'checked' : 'value'}
                  extra={field.description}
                  rules={field.required ? [{ required: true, message: `请填写${field.label}` }] : undefined}
                >
                  <ConfigField field={field} />
                </Form.Item>
              ))}
            </div>
          </Form>
        </div>
      ) : Object.keys(configValues(profile.workConfig)).length ? (
        <Descriptions
          className="ewb-description"
          bordered
          size="small"
          column={{ xs: 1, sm: 2 }}
          items={Object.entries(configValues(profile.workConfig)).map(([key, value]) => ({
            key,
            label: key,
            children: displayValue(value),
          }))}
        />
      ) : (
        <HonestEmpty description="该岗位没有可配置项，页面不会虚构配置开关" />
      )}
      <div className="ewb-prompt-meta">{profile.workConfig.mode && <span>模式：{profile.workConfig.mode}</span>}</div>
    </div>
  );

  const jobTab = profile && (
    <div className="ewb-section">
      <SectionHeading title="岗位档案" description="展示权威岗位身份、职责、适用范围、档案来源和经营边界。" />
      {profileDescriptionItems(profile.jobProfile, profile.identity).length ? (
        <Descriptions
          className="ewb-description"
          bordered
          size="small"
          column={{ xs: 1, sm: 2 }}
          items={profileDescriptionItems(profile.jobProfile, profile.identity).map((item, index) => ({
            key: `${item.label}-${index}`,
            label: item.label,
            children: item.value,
            span: ['岗位职责', '岗位介绍', '适用范围'].includes(item.label) ? 2 : 1,
          }))}
        />
      ) : (
        <HonestEmpty description="接口没有返回岗位档案" />
      )}
      {!!profile.jobProfile.boundaries?.length && (
        <div className="ewb-panel">
          <h4 className="ewb-config-title">岗位边界</h4>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--ui-text-2)', lineHeight: 1.8 }}>
            {profile.jobProfile.boundaries.map((boundary, index) => (
              <li key={index}>{boundary}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );

  const backendTabItems = profile
    ? [
        {
          key: 'overview',
          label: (
            <span>
              <IdcardOutlined /> 总览
            </span>
          ),
          children: (
            <EmployeeVisualOverview
              profile={profile}
              business={identityHint?.business}
              deptColor={identityColor(profile.identity) || 'var(--ui-primary)'}
            />
          ),
        },
        ...(profile.permissions.canViewCapabilities === true
          ? [
              {
                key: 'capabilities',
                label: (
                  <span>
                    <ThunderboltOutlined /> 能力
                  </span>
                ),
                children: capabilityTab,
              },
            ]
          : []),
        ...(profile.permissions.canViewWorkMethod === true
          ? [
              {
                key: 'method',
                label: (
                  <span>
                    <ApartmentOutlined /> 工作方式
                  </span>
                ),
                children: <WorkMethodTab method={profile.workMethod} />,
              },
            ]
          : []),
        ...(profile.permissions.canViewSkills === true
          ? [
              {
                key: 'skills',
                label: (
                  <span>
                    <BookOutlined /> 技能库
                  </span>
                ),
                children: skillsTab,
              },
              // 自动进化：验收反馈 → AI 提炼心得提案 → 人审采纳 → 派活注入
              ...((profile.identity as any).specialistId
                ? [
                    {
                      key: 'evolution',
                      label: (
                        <span>
                          <ExperimentOutlined /> 进化
                        </span>
                      ),
                      children: <EmployeeEvolution specialistId={Number((profile.identity as any).specialistId)} />,
                    },
                  ]
                : []),
            ]
          : []),
        ...(profile.permissions.canViewPrompt === true
          ? [
              {
                key: 'prompts',
                label: (
                  <span>
                    <CodeOutlined /> 提示词
                  </span>
                ),
                children: promptTab,
              },
            ]
          : []),
        ...(profile.permissions.canViewWorkConfig === true
          ? [
              {
                key: 'config',
                label: (
                  <span>
                    <SettingOutlined /> 工作配置
                  </span>
                ),
                children: configTab,
              },
            ]
          : []),
        ...(profile.permissions.canViewRuntimeBindings === true || profile.permissions.canViewJobProfile === true
          ? [
              {
                key: 'runtime-bindings',
                label: (
                  <span>
                    <ApiOutlined /> API 与工具
                  </span>
                ),
                children: <RuntimeBindingsTab bindings={profile.runtimeBindings} />,
              },
            ]
          : []),
        ...(profile.permissions.canViewJobProfile === true
          ? [
              {
                key: 'profile',
                label: (
                  <span>
                    <IdcardOutlined /> 岗位档案
                  </span>
                ),
                children: jobTab,
              },
            ]
          : []),
      ]
    : [];

  const provenance = profile?.provenance;
  const provenanceText = provenance
    ? [
        provenance.authority && `权威来源：${provenance.authority}`,
        (provenance.source || provenance.sourcePath) && `路径：${provenance.source || provenance.sourcePath}`,
        provenance.referenceSha256 && `SHA-256：${provenance.referenceSha256}`,
        provenance.executionMode && `执行模式：${provenance.executionMode}`,
        provenance.updatedAt && `更新：${provenance.updatedAt}`,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <>
      <Drawer
        rootClassName="employee-workbench-drawer-root"
        className="employee-workbench-drawer"
        width="min(1040px, 100vw)"
        open={open}
        onClose={() => {
          setBackendProfileOpen(false);
          onClose();
        }}
        destroyOnClose
        extra={
          canViewInternalProfile ? (
            <Button
              className="ewb-backend-entry"
              size="small"
              icon={<SettingOutlined />}
              onClick={() => setBackendProfileOpen(true)}
            >
              后台档案
            </Button>
          ) : undefined
        }
        styles={{
          header: {
            '--ewb-color': titleIdentity ? identityColor(titleIdentity) || 'var(--ui-primary)' : 'var(--ui-primary)',
          } as CSSProperties,
        }}
        title={
          titleIdentity ? (
            <div
              className="ewb-title"
              style={{ '--ewb-color': identityColor(titleIdentity) || 'var(--ui-primary)' } as CSSProperties}
            >
              <span className="ewb-title-avatar">
                {domain === 'restaurant' && typeof titleIdentity.idx === 'number' ? (
                  <EmployeeAvatar
                    idx={titleIdentity.idx}
                    name={String(titleIdentity.person || titleIdentity.name || '')}
                    color={identityColor(titleIdentity) || '#2c76dc'}
                    size={52}
                  />
                ) : (
                  <IdcardOutlined aria-hidden />
                )}
              </span>
              <div className="ewb-title-copy">
                <div className="ewb-title-name">
                  <strong>
                    {titleIdentity.person ? `${titleIdentity.person} · ${titleIdentity.name}` : titleIdentity.name}
                  </strong>
                  {titleIdentity.extension && <Tag color="blue">扩展</Tag>}
                </div>
                <div className="ewb-title-sub">与数字员工对话 · #{titleIdentity.idx}</div>
              </div>
            </div>
          ) : canViewInternalProfile ? (
            '数字员工完整工作台'
          ) : (
            '数字员工工作台'
          )
        }
      >
        {loading && (
          <div className="ewb-loading">
            <Skeleton active avatar paragraph={{ rows: 12 }} />
          </div>
        )}
        {!loading && loadError && (
          <div className="ewb-error">
            <Alert
              type="error"
              showIcon
              message="员工工作台读取失败"
              description={`${loadError}。页面不会用目录静态值冒充员工数据。`}
              action={
                <Button size="small" onClick={() => void loadProfile()}>
                  重新读取
                </Button>
              }
            />
          </div>
        )}
        {!loading && !loadError && profile && (
          <div
            className="ewb-shell ewb-conversation-shell"
            style={{ '--ewb-color': identityColor(profile.identity) || 'var(--ui-primary)' } as CSSProperties}
          >
            <main className="ewb-content ewb-public-conversation">{dispatchTab}</main>
          </div>
        )}
      </Drawer>
      <Drawer
        rootClassName="employee-workbench-backend-drawer-root"
        className="employee-workbench-backend-drawer"
        width="min(900px, 96vw)"
        open={open && backendProfileOpen}
        onClose={() => setBackendProfileOpen(false)}
        destroyOnClose={false}
        title={
          <div className="ewb-backend-title">
            <SettingOutlined aria-hidden="true" />
            <span>
              <strong>后台档案</strong>
              <small>技能、工具、提示词与执行配置</small>
            </span>
          </div>
        }
        extra={
          canManageContentProfile ? (
            <Button size="small" icon={<SettingOutlined />} onClick={() => setContentProfileOpen(true)}>
              企业品牌与账号人设
            </Button>
          ) : undefined
        }
      >
        {profile && (
          <div
            className="ewb-backend-shell"
            style={{ '--ewb-color': identityColor(profile.identity) || 'var(--ui-primary)' } as CSSProperties}
          >
            <Tabs
              className="ewb-tabs ewb-backend-tabs"
              activeKey={activeTab}
              onChange={setActiveTab}
              items={backendTabItems}
              animated={false}
            />
            {(provenanceText || provenance?.boundary) && (
              <footer className="ewb-provenance">
                <FileTextOutlined /> {[provenanceText, provenance?.boundary].filter(Boolean).join(' · ')}
              </footer>
            )}
          </div>
        )}
      </Drawer>
      <Modal
        open={!!adoptRun}
        title={`选择并采纳：${adoptRun?.title || ''}`}
        okText="确认选择并采纳"
        cancelText="取消"
        confirmLoading={reviewing}
        onCancel={() => {
          if (reviewing) return;
          setAdoptRun(null);
          setAdoptCandidateIndex(null);
        }}
        onOk={async () => {
          if (adoptCandidateIndex === null) {
            message.warning('请先选择一个具体候选结果');
            return;
          }
          if (adoptRun) {
            await reviewRun(adoptRun, 'adopt', '', { candidateIndex: adoptCandidateIndex });
          }
        }}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          message="该岗位采用候选选择审批"
          description="必须由审阅人明确选择一个候选项，系统才会把选择、审阅人和时间写入任务审计记录；系统不会自动对外发布。"
          className="ewb-adoption-alert"
        />
        <Select
          style={{ width: '100%' }}
          placeholder="请选择要采纳的候选项"
          value={adoptCandidateIndex ?? undefined}
          onChange={value => setAdoptCandidateIndex(value)}
          options={(adoptRun?.handlerApproval?.candidates || []).map(candidate => ({
            value: candidate.candidateIndex,
            label: `${candidate.candidateIndex + 1}. ${candidate.label}`,
          }))}
        />
      </Modal>
      <Modal
        open={!!rejectRun}
        title={`驳回产出：${rejectRun?.title || ''}`}
        okText="确认驳回"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        confirmLoading={reviewing}
        onCancel={() => {
          if (reviewing) return;
          setRejectRun(null);
          setRejectOpinion('');
        }}
        onOk={async () => {
          if (!rejectOpinion.trim()) {
            message.warning('驳回必须填写意见');
            return;
          }
          if (rejectRun) await reviewRun(rejectRun, 'reject', rejectOpinion.trim());
        }}
        destroyOnClose
      >
        <Alert
          className="ewb-review-reject-note"
          type="warning"
          showIcon
          message="驳回后本次运行会保留结果、执行快照和审阅意见，便于追溯。"
        />
        <Input.TextArea
          rows={4}
          maxLength={1000}
          showCount
          value={rejectOpinion}
          onChange={event => setRejectOpinion(event.target.value)}
          placeholder="请写明需要修改的问题、证据缺口或不予采纳的原因。"
        />
      </Modal>
      <Modal
        title="添加企业自定义技能"
        open={customSkillOpen}
        onCancel={() => setCustomSkillOpen(false)}
        okText="添加技能"
        cancelText="取消"
        confirmLoading={saving === 'skills'}
        onOk={() => void addCustomSkill()}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="自定义技能是岗位能力的补充，不会替代或关闭出厂必备能力。"
        />
        <Form form={customSkillForm} layout="vertical" requiredMark={false}>
          <Form.Item name="title" label="技能名称" rules={[{ required: true, message: '请填写技能名称' }, { max: 60 }]}>
            <Input placeholder="例：本店晚市菜单复盘法" />
          </Form.Item>
          <Form.Item
            name="detail"
            label="技能说明"
            rules={[{ required: true, message: '请说明技能如何使用' }, { min: 8 }, { max: 500 }]}
          >
            <Input.TextArea rows={4} placeholder="说明适用任务、使用方法、输入要求和验证标准。" />
          </Form.Item>
          <Form.Item name="source" label="来源（建议填写）" rules={[{ max: 200 }]}>
            <Input placeholder="例：本店2026年第二季度复盘SOP" />
          </Form.Item>
        </Form>
      </Modal>
      {canManageContentProfile && (
        <ContentBrandPersonaEditor open={contentProfileOpen} onClose={() => setContentProfileOpen(false)} />
      )}
      <BusinessFlowTrace
        sourceType={businessFlow?.sourceType}
        sourceId={businessFlow?.sourceId}
        open={businessFlow !== null}
        onClose={() => setBusinessFlow(null)}
      />
    </>
  );
}
