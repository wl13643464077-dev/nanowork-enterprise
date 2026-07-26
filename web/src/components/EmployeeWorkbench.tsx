import {
  Alert, Button, Descriptions, Drawer, Empty, Form, Input, InputNumber, message, Modal,
  Select, Skeleton, Space, Steps, Switch, Tabs, Tag, Typography,
} from 'antd';
import {
  ApartmentOutlined, BookOutlined, CloseCircleOutlined, CodeOutlined,
  ClockCircleOutlined, EyeOutlined, FileTextOutlined, IdcardOutlined, LockOutlined, PictureOutlined,
  PlusOutlined, ReloadOutlined, RocketOutlined, SaveOutlined, SettingOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../api/client';
import type {
  EmployeeCapability, EmployeeDispatch, EmployeeJobProfile, EmployeeRuntime,
  EmployeeRunListResponse, EmployeeWorkbenchRun,
  EmployeeSkill, EmployeeSkillLibrary, EmployeeWorkbenchDomain, EmployeeWorkbenchIdentityHint,
  EmployeeWorkbenchProfile, EmployeeWorkConfig, EmployeeWorkMethod, WorkConfigField,
} from '../api/employeeWorkbenchTypes';
import { Markdown } from './Markdown';
import { UnifiedFilePicker, type UploadedFileRef } from './UnifiedFilePicker';
import './EmployeeWorkbench.css';

type Props = {
  open: boolean;
  domain: EmployeeWorkbenchDomain;
  idx: number | null;
  identityHint?: EmployeeWorkbenchIdentityHint | null;
  onClose: () => void;
};

type MutationName = 'prompt' | 'config' | 'skills';

const EMPTY_PROFILE_PARTS = {
  capabilities: [],
  workMethod: {},
  skillLibrary: {},
  prompts: {},
  workConfig: {},
  jobProfile: {},
  runtime: {},
  dispatch: {},
  permissions: {},
  provenance: {},
};

function normalizeProfile(data: unknown): EmployeeWorkbenchProfile {
  const wrapped = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const raw = wrapped.profile && typeof wrapped.profile === 'object'
    ? wrapped.profile as Record<string, unknown>
    : wrapped;
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
    runtime: objectOrEmpty(raw.runtime),
    dispatch: objectOrEmpty(raw.dispatch),
    permissions: objectOrEmpty(raw.permissions),
    provenance: objectOrEmpty(raw.provenance),
  } as EmployeeWorkbenchProfile;
}

function objectOrEmpty<T extends object>(value: unknown): T {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as T : {} as T;
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

const RUN_STATUS_COLOR: Record<string, string> = {
  生成中: 'processing',
  待审阅: 'gold',
  '待审阅·格式待修复': 'orange',
  已完成: 'green',
  已采纳: 'green',
  已驳回: 'red',
  失败: 'red',
};

function runStatus(run: EmployeeWorkbenchRun) {
  return text(run.displayStatus) || (run.status === '已完成' ? '已采纳' : run.status);
}

function runTime(value?: string | null) {
  return text(value).replace('T', ' ').slice(0, 16) || '时间未记录';
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.map(item => typeof item === 'object' ? JSON.stringify(item) : String(item)).join('、') || '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
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
  const factory = uniqueSkills([
    ...(library.factory || []), ...(library.builtIn || []), ...(library.factorySkills || []),
    ...(library.required || []),
    ...(library.optional || []).filter(skill => skill.origin !== 'legacy_learned' && skill.verificationStatus !== 'legacy_unverified'),
    ...flat.filter(skill => skill.kind === 'factory'),
  ]);
  const historical = uniqueSkills([
    ...(library.historical || []), ...(library.pending || []), ...(library.pendingVerification || []),
    ...(library.historicalSkills || []),
    ...(library.optional || []).filter(skill => skill.origin === 'legacy_learned' || skill.verificationStatus === 'legacy_unverified'),
    ...(library.learned || []).filter(skill => skill.origin === 'legacy_learned' || skill.verificationStatus === 'legacy_unverified'),
    ...flat.filter(skill => ['historical', 'pending'].includes(skill.kind || '')),
  ]);
  const custom = uniqueSkills([
    ...(library.custom || []), ...(library.customSkills || []),
    ...(library.learned || []).filter(skill => skill.origin !== 'legacy_learned' && skill.verificationStatus !== 'legacy_unverified'),
    ...flat.filter(skill => skill.kind === 'custom'),
  ]);
  return { factory, historical, custom };
}

function runtimeItems(runtime: EmployeeRuntime, domain: EmployeeWorkbenchDomain) {
  const items: Array<{ label: string; value: ReactNode }> = [];
  if (Number.isFinite(runtime.runs)) items.push({ label: '出勤', value: `${runtime.runs} 次` });
  if (Number.isFinite(runtime.completedRuns)) items.push({
    label: domain === 'content' ? '已采纳' : '已完成',
    value: `${runtime.completedRuns} 单`,
  });
  if (Number.isFinite(runtime.reviewPendingRuns)) items.push({ label: '待审阅', value: `${runtime.reviewPendingRuns} 单` });
  if (Number.isFinite(runtime.runningTasks)) items.push({ label: '执行中', value: `${runtime.runningTasks} 单` });
  if (Number.isFinite(runtime.outputs)) items.push({ label: '内容产出', value: `${runtime.outputs} 条` });
  if (Number.isFinite(runtime.tasks)) items.push({ label: '任务', value: `${runtime.tasks} 单` });
  if (Number.isFinite(runtime.mediaJobs)) items.push({ label: '媒体任务', value: `${runtime.mediaJobs} 个` });
  if (Number.isFinite(runtime.avgDurationSeconds)) items.push({ label: '平均用时', value: `${runtime.avgDurationSeconds}s` });
  if (Number.isFinite(runtime.cost)) items.push({ label: '历史成本', value: `¥${Number(runtime.cost).toFixed(2)}` });
  const last = text(runtime.lastRunAt) || text(runtime.lastCreatedAt);
  const lastTaskTime = text(runtime.lastTask?.created_at);
  if (last || lastTaskTime) items.push({ label: '最近运行', value: (last || lastTaskTime).replace('T', ' ').slice(0, 16) });
  return items.slice(0, 4);
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
      <div><h3>{title}</h3><p>{description}</p></div>
      {extra}
    </div>
  );
}

function HonestEmpty({ description }: { description: string }) {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={description} />;
}

function LockedCapabilities({ capabilities }: { capabilities: EmployeeCapability[] }) {
  const visible = capabilities.filter(capability => text(capability.name));
  if (!visible.length) return <HonestEmpty description="接口没有返回这名员工的能力清单" />;
  return (
    <div className="ewb-capabilities">
      {visible.map((capability, index) => {
        const required = capability.required !== false;
        return (
          <article className="ewb-capability" aria-label={`${capability.name}，${required ? '岗位必备能力' : '附加能力'}`}
            key={capability.id || capability.key || `${capability.name}-${index}`}>
            <span className="ewb-capability-icon">{capability.emoji || <ThunderboltOutlined />}</span>
            <div className="ewb-card-copy">
              <strong>{capability.name}</strong>
              <p>{text(capability.description) || text(capability.desc) || '接口未提供能力说明'}</p>
              <div className="ewb-card-meta">
                <Tag color={required ? 'blue' : 'default'} icon={required ? <LockOutlined /> : undefined}>
                  {required ? '岗位必备 · 不可关闭' : '附加能力'}
                </Tag>
                {capability.source && <Tag>{capability.source}</Tag>}
              </div>
            </div>
            <Switch className="ewb-locked-switch" size="small" checked={required || capability.enabled !== false}
              disabled aria-label={`${capability.name}已锁定启用`} />
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
      <SectionHeading title="工作方式" description="从必要输入到逐步执行、交付和放行，完整展示本岗位如何完成工作。" />
      {!hasFlow ? <HonestEmpty description="接口没有返回这名员工的工作方式" /> : (
        <div className="ewb-flow" aria-label="员工工作流程">
          <div className="ewb-flow-node">
            <h4>📥 必要输入</h4>
            {inputs.length ? <ul>{inputs.map((item, index) => <li key={index}>{item}</li>)}</ul>
              : <HonestEmpty description="未配置必要输入" />}
          </div>
          <div className="ewb-flow-arrow" aria-hidden>→</div>
          <div className="ewb-flow-node primary">
            <h4>🧰 完整工作流</h4>
            {steps.length ? <ol>{steps.map((item, index) => <li key={index}>{item}</li>)}</ol>
              : <HonestEmpty description="未配置工作步骤" />}
          </div>
          <div className="ewb-flow-arrow" aria-hidden>→</div>
          <div className="ewb-flow-node">
            <h4>📤 最终交付</h4>
            {deliverables.length ? <ul>{deliverables.map((item, index) => <li key={index}>{item}</li>)}</ul>
              : <HonestEmpty description="未配置交付物" />}
          </div>
        </div>
      )}
      {(method.approval || method.qualityGate || method.qualityGates?.length || method.handoff) && (
        <div className="ewb-method-meta">
          {method.approval && <div><span>放行方式</span><strong>{method.approval}</strong></div>}
          {(method.qualityGate || method.qualityGates?.length) && <div><span>质量关卡</span><strong>{method.qualityGate || method.qualityGates?.join('；')}</strong></div>}
          {method.handoff && <div><span>交棒方式</span><strong>{method.handoff}</strong></div>}
        </div>
      )}
      {!!method.safetyBoundaries?.length && (
        <Alert type="warning" showIcon message="岗位安全边界"
          description={method.safetyBoundaries.join('；')} />
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

function SkillCard({ skill, kind, editable, saving, onToggle, onDelete }: {
  skill: EmployeeSkill;
  kind: 'factory' | 'historical' | 'custom';
  editable: boolean;
  saving: boolean;
  onToggle?: () => void;
  onDelete?: () => void;
}) {
  const enabled = skill.enabled !== false;
  return (
    <article className="ewb-skill-card">
      <span className="ewb-capability-icon">
        {kind === 'factory' ? <LockOutlined /> : kind === 'historical' ? <BookOutlined /> : <ThunderboltOutlined />}
      </span>
      <div className="ewb-card-copy">
        <strong>{skillTitle(skill)}</strong>
        <p>{skillDescription(skill) || '接口未提供技能说明'}</p>
        <div className="ewb-card-meta">
          <Tag color={kind === 'factory' ? 'blue' : kind === 'historical' ? 'orange' : 'purple'}>
            {kind === 'factory' ? '出厂岗位 Skill' : kind === 'historical' ? '历史技能 · 待核验' : '企业自定义技能'}
          </Tag>
          {skill.source && <Tag>{skill.source}</Tag>}
          {kind === 'historical' && (
            <Tag icon={<CloseCircleOutlined />}>
              {skill.defaultInjected === false ? '未启用' : '默认启用 · 使用前核验'}
            </Tag>
          )}
        </div>
      </div>
      <div className="ewb-skill-actions">
        {kind === 'factory' && skill.required !== false
          ? <Switch size="small" checked disabled aria-label={`${skillTitle(skill)}出厂锁定启用`} />
          : kind === 'factory' && <Switch size="small" checked={enabled} disabled={!editable || saving} onChange={onToggle}
            aria-label={`${enabled ? '停用' : '启用'}${skillTitle(skill)}`} />}
        {kind === 'custom' && (
          <>
            <Switch size="small" checked={enabled} disabled={!editable || saving} onChange={onToggle}
              aria-label={`${enabled ? '停用' : '启用'}${skillTitle(skill)}`} />
            {editable && <Button size="small" danger type="text" disabled={saving} onClick={onDelete}
              aria-label={`删除${skillTitle(skill)}`}>删除</Button>}
          </>
        )}
      </div>
    </article>
  );
}

function ConfigField({ field }: { field: WorkConfigField }) {
  const options = (field.options || []).map(option => typeof option === 'string'
    ? { label: option, value: option }
    : option);
  if (field.type === 'boolean') return <Switch />;
  if (field.type === 'number') return <InputNumber style={{ width: '100%' }} />;
  if (field.type === 'select') return <Select options={options} />;
  if (field.type === 'multiselect') return <Select mode="multiple" options={options} />;
  if (field.type === 'textarea') return <Input.TextArea rows={4} />;
  return <Input />;
}

function profileDescriptionItems(profile: EmployeeJobProfile, identity: EmployeeWorkbenchProfile['identity']) {
  const explicit = Array.isArray(profile.fields)
    ? profile.fields.filter(item => (
      text(item?.label)
      && text(item?.value)
      && !/(?:版本|修订)/u.test(text(item.label))
    ))
    : [];
  const generated = [
    { label: '岗位职责', value: profile.duty || profile.responsibilities?.join('；') || identity.duty },
    { label: '岗位介绍', value: profile.intro || profile.useCases?.join('；') || identity.intro || identity.description },
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
    { label: '必要输入', value: profile.requiredInputs?.join('；') },
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
  return (dispatch.types || dispatch.taskTypes || []).map(option => typeof option === 'string'
    ? { label: option, value: option }
    : option).filter(option => text(option?.label) && text(option?.value));
}

const KNOWN_CONFIG_FIELDS: WorkConfigField[] = [
  { key: 'textModel', label: '文本模型', description: '留空表示跟随企业全局模型。' },
  { key: 'visionModel', label: '视觉模型', description: '留空表示跟随企业全局模型。' },
  { key: 'webMode', label: '联网方式', type: 'select', options: [
    { label: '岗位要求联网', value: 'required' }, { label: '按需联网', value: 'allowed' }, { label: '关闭联网', value: 'off' },
  ] },
  { key: 'knowledgeScopes', label: '知识范围', type: 'multiselect', options: ['餐饮产业知识库', '员工产出'] },
  { key: 'outputLength', label: '交付篇幅', type: 'select', options: [
    { label: '标准', value: 'standard' }, { label: '完整', value: 'full' },
  ] },
  { key: 'timeoutSeconds', label: '执行超时（秒）', type: 'number' },
  { key: 'approvalMode', label: '审批方式', type: 'select', options: [
    { label: '老板审核', value: 'owner_review' }, { label: '管理者审核', value: 'manager_review' }, { label: '自动形成草稿', value: 'auto_draft' },
  ] },
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

export default function EmployeeWorkbench(props: Props) {
  const instanceKey = props.open && props.idx !== null ? `${props.domain}-${props.idx}` : 'closed';
  return <EmployeeWorkbenchInstance key={instanceKey} {...props} />;
}

function EmployeeWorkbenchInstance({ open, domain, idx, identityHint, onClose }: Props) {
  const [profile, setProfile] = useState<EmployeeWorkbenchProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [activeTab, setActiveTab] = useState('dispatch');
  const [saving, setSaving] = useState<MutationName | 'dispatch' | ''>('');
  const [promptDraft, setPromptDraft] = useState('');
  const [customSkillOpen, setCustomSkillOpen] = useState(false);
  const [lastSnapshot, setLastSnapshot] = useState<Record<string, unknown> | null>(null);
  // 餐饮域派活后的任务进度（content 域走 runs 列表，restaurant 域走 /marshals/tasks/:id/status）
  const [restaurantTask, setRestaurantTask] = useState<any>(null);
  const [dispatchImage, setDispatchImage] = useState<{ name: string; dataUrl: string } | null>(null);
  const [dispatchFiles, setDispatchFiles] = useState<UploadedFileRef[]>([]);
  const [runs, setRuns] = useState<EmployeeWorkbenchRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState('');
  const [selectedRun, setSelectedRun] = useState<EmployeeWorkbenchRun | null>(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [rejectRun, setRejectRun] = useState<EmployeeWorkbenchRun | null>(null);
  const [rejectOpinion, setRejectOpinion] = useState('');
  const requestSerial = useRef(0);
  const runRequestSerial = useRef(0);
  const dispatchImageInputRef = useRef<HTMLInputElement>(null);
  const [dispatchForm] = Form.useForm();
  const [configForm] = Form.useForm();
  const [customSkillForm] = Form.useForm();

  const applyProfile = useCallback((normalized: EmployeeWorkbenchProfile) => {
    const prompts = normalized.prompts || {};
    setPromptDraft(text(prompts.overrideTemplate) || text(prompts.override));
    configForm.setFieldsValue(configValues(normalized.workConfig || {}));
    const types = dispatchTypes(normalized.dispatch);
    dispatchForm.setFieldsValue({
      title: '',
      requirement: '',
      industry: '',
      feedback: '',
      dueAt: undefined,
      type: normalized.dispatch.defaultType || normalized.dispatch.defaultTaskType || types[0]?.value,
    });
    setProfile(normalized);
  }, [configForm, dispatchForm]);

  const loadRuns = useCallback(async () => {
    if (!open || domain !== 'content' || idx === null) return;
    const serial = ++runRequestSerial.current;
    setRunsLoading(true);
    setRunsError('');
    try {
      const data = await api.get(`/employee-workbench/content/${idx}/runs?limit=8`) as EmployeeRunListResponse;
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

  const loadRunDetail = useCallback(async (id: number, { quiet = false } = {}) => {
    if (!open || domain !== 'content' || idx === null) return null;
    if (!quiet) setRunDetailLoading(true);
    try {
      const data = await api.get(`/employee-workbench/content/${idx}/runs/${id}`) as { run?: EmployeeWorkbenchRun };
      const run = data?.run || null;
      if (run) {
        setSelectedRun(current => quiet && current && current.id !== run.id ? current : run);
        setRuns(current => current.map(item => item.id === run.id ? { ...item, ...run } : item));
      }
      return run;
    } catch {
      return null;
    } finally {
      if (!quiet) setRunDetailLoading(false);
    }
  }, [domain, idx, open]);

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
      setLoadError(error?.message || '员工完整工作台读取失败');
    } finally {
      if (serial === requestSerial.current) setLoading(false);
    }
  }, [applyProfile, domain, idx, open]);

  const refreshProfileQuietly = useCallback(async () => {
    if (!open || idx === null) return;
    try {
      const data = await api.get(`/employee-workbench/${domain}/${idx}`);
      applyProfile(normalizeProfile(data));
    } catch {
      // 结果已经持久化；运行统计刷新失败时保留现有档案，避免遮住结果。
    }
  }, [applyProfile, domain, idx, open]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || !open) return;
      void loadProfile();
      if (domain === 'content') void loadRuns();
    });
    return () => {
      cancelled = true;
      requestSerial.current += 1;
      runRequestSerial.current += 1;
    };
  }, [domain, loadProfile, loadRuns, open]);

  useEffect(() => {
    if (!open || domain !== 'content' || idx === null || activeRunId === null) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const data = await api.get(`/employee-workbench/content/${idx}/runs/${activeRunId}`) as { run?: EmployeeWorkbenchRun };
        const run = data?.run;
        if (cancelled || !run) return;
        setRuns(current => {
          const exists = current.some(item => item.id === run.id);
          return exists
            ? current.map(item => item.id === run.id ? { ...item, ...run } : item)
            : [run, ...current].slice(0, 8);
        });
        setSelectedRun(current => !current || current.id === run.id ? run : current);
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
      const wrapped = data && typeof data === 'object' ? data as Record<string, unknown> : {};
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
  const runtime = profile?.runtime || {};
  const liveRuntimeItems = runtimeItems(runtime, domain);
  const skills = useMemo(() => splitSkills(profile?.skillLibrary || {}), [profile?.skillLibrary]);
  const configFields = profile ? effectiveConfigFields(profile.workConfig) : [];
  const capabilityCount = profile?.dispatch.lockedCapabilityCount
    ?? profile?.capabilities.filter(capability => capability.required !== false).length
    ?? 0;

  const savePrompt = () => mutate('prompt', { overrideTemplate: promptDraft }, promptDraft.trim() ? '员工提示词覆盖已保存' : '已恢复默认提示词');
  const saveConfig = async () => {
    const values = await configForm.validateFields();
    await mutate('config', { values }, '工作配置已保存，下次执行生效');
  };
  const toggleCustomSkill = (skill: EmployeeSkill) => mutate('skills', {
    skills: [{ id: skill.id, key: skill.key, title: skillTitle(skill), enabled: skill.enabled === false }],
  }, `技能已${skill.enabled === false ? '启用' : '停用'}`);
  const toggleOptionalSkill = (skill: EmployeeSkill) => mutate('skills', {
    skills: [{ id: skill.id, key: skill.key, title: skillTitle(skill), enabled: skill.enabled === false }],
  }, `技能已${skill.enabled === false ? '启用' : '停用'}`);
  const deleteCustomSkill = (skill: EmployeeSkill) => {
    const customSkills = skills.custom.filter(item => item !== skill).map(item => ({
      title: skillTitle(item), detail: skillDescription(item), source: item.source || '', enabled: item.enabled !== false,
    }));
    void mutate('skills', { customSkills }, '自定义技能已删除');
  };
  const addCustomSkill = async () => {
    const values = await customSkillForm.validateFields();
    const customSkills = [...skills.custom.map(item => ({
      title: skillTitle(item), detail: skillDescription(item), source: item.source || '', enabled: item.enabled !== false,
    })), { ...values, enabled: true }];
    const saved = await mutate('skills', { customSkills }, '自定义技能已加入');
    if (saved) {
      setCustomSkillOpen(false);
      customSkillForm.resetFields();
    }
  };

  // 餐饮任务进度轮询：仅在「生成中」阶段轮询，带可见性门控；到达待审阅/完成/失败即停止
  useEffect(() => {
    if (!open || domain !== 'restaurant') return;
    const taskId = restaurantTask?.id;
    if (!taskId || restaurantTask?.status !== '生成中') return;
    const pull = () => api.get(`/marshals/tasks/${taskId}/status`)
      .then((t: any) => setRestaurantTask((cur: any) => (cur && cur.id === taskId ? { ...cur, ...t } : cur)))
      .catch(() => {});
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') pull(); }, 5000);
    return () => window.clearInterval(timer);
  }, [open, domain, restaurantTask?.id, restaurantTask?.status]);

  const submitDispatch = async () => {
    if (idx === null || !profile) return;
    const values = await dispatchForm.validateFields();
    setSaving('dispatch');
    try {
      const result = await api.post(`/employee-workbench/${domain}/${idx}/dispatch`, {
        ...values,
        ...(dispatchImage ? { image: dispatchImage.dataUrl, imageName: dispatchImage.name } : {}),
        ...(dispatchFiles.length ? { fileIds: dispatchFiles.map(file => file.id) } : {}),
      });
      const payload = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      const snapshot = payload.snapshot && typeof payload.snapshot === 'object'
        ? payload.snapshot as Record<string, unknown>
        : null;
      const billing = payload.billing && typeof payload.billing === 'object'
        ? payload.billing as EmployeeWorkbenchRun['billing']
        : null;
      setLastSnapshot(snapshot);
      const createdRunId = Number(payload.runId ?? payload.taskId);
      if (domain === 'restaurant' && Number.isSafeInteger(createdRunId) && createdRunId > 0) {
        setRestaurantTask({ id: createdRunId, status: String(payload.status || '生成中'), stepIndex: 1 });
      }
      if (domain === 'content' && Number.isSafeInteger(createdRunId) && createdRunId > 0) {
        setActiveRunId(createdRunId);
        setSelectedRun({
          id: createdRunId,
          runId: createdRunId,
          employeeIdx: idx,
          employeeName: profile.identity.name,
          title: String(values.title || ''),
          type: String(values.type || ''),
          requirement: String(values.requirement || ''),
          industry: String(values.industry || ''),
          feedback: String(values.feedback || ''),
          status: '生成中',
          displayStatus: '生成中',
          billing,
          canReview: false,
          terminal: false,
        });
      }
      message.success(text(payload.msg) || text(payload.message) || '任务已派发，完整能力快照已锁定');
      dispatchForm.setFieldsValue({
        title: '',
        requirement: '',
        industry: '',
        feedback: '',
        dueAt: undefined,
      });
      setDispatchImage(null);
      setDispatchFiles([]);
      if (dispatchImageInputRef.current) dispatchImageInputRef.current.value = '';
    } catch {
      // api 客户端已经显示了服务端错误；保留表单，方便修正后重试。
    } finally {
      setSaving('');
    }
  };

  const reviewRun = async (run: EmployeeWorkbenchRun, decision: 'adopt' | 'reject', opinion = '') => {
    if (domain !== 'content' || idx === null) return;
    setReviewing(true);
    try {
      const data = await api.post(`/employee-workbench/content/${idx}/runs/${run.id}/review`, {
        decision,
        opinion,
      }) as { run?: EmployeeWorkbenchRun; alreadyReviewed?: boolean };
      if (data.run) setSelectedRun(data.run);
      message.success(data.alreadyReviewed
        ? `该产出已经${decision === 'adopt' ? '采纳' : '驳回'}`
        : decision === 'adopt'
          ? idx === 8 ? '分发官产出已采纳，并形成可继续发布登记的内容' : '产出已采纳并完成审阅'
          : '产出已驳回');
      setRejectRun(null);
      setRejectOpinion('');
      await Promise.all([loadRuns(), refreshProfileQuietly()]);
      if (data.run) setSelectedRun(data.run);
    } finally {
      setReviewing(false);
    }
  };

  const confirmAdoptRun = (run: EmployeeWorkbenchRun) => {
    Modal.confirm({
      title: `确认采纳「${run.title}」？`,
      content: idx === 8
        ? '采纳即完成人工审核，并形成一条“可使用”内容，可在内容列表继续做发布登记；系统不会自动对外发布。'
        : '采纳后本次内容员工运行将计入已完成并沉淀为素材；对外发布及不可逆动作仍需按岗位边界另行授权。',
      okText: '确认采纳',
      cancelText: '取消',
      onOk: () => reviewRun(run, 'adopt'),
    });
  };

  const loadDispatchImage = (file?: File) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      message.error('仅支持 PNG、JPEG 或 WebP 图片');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      message.error('图片不能超过 8MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      setDispatchImage({ name: file.name.slice(0, 160), dataUrl: reader.result });
    };
    reader.onerror = () => message.error('图片读取失败，请重新选择');
    reader.readAsDataURL(file);
  };

  const dispatchAvailable = !!profile?.permissions.canDispatch
    && profile.dispatch.available !== false && profile.dispatch.enabled !== false;

  const dispatchTab = profile && (() => {
    const guidance = profile.dispatch.guidance || {};
    const materialChecklist = stringList(guidance.materialChecklist)
      || stringList(profile.workMethod.inputs || profile.workMethod.requiredInputs);
    const deliverableChecklist = stringList(guidance.deliverableChecklist)
      || stringList(profile.workMethod.deliverables);
    const taskExamples = stringList(guidance.taskExamples);
    const titleLabel = text(guidance.titleLabel) || `请${profile.identity.name}解决哪一个具体问题？`;
    const titlePlaceholder = text(guidance.titlePlaceholder)
      || `例如：请${profile.identity.name}按岗位职责完成一项具体交付`;
    const requirementLabel = text(guidance.requirementLabel) || `请提供${profile.identity.name}开工所需的真实材料`;
    const requirementPlaceholder = text(guidance.requirementPlaceholder)
      || `请逐项提供必要输入；缺失项明确写“暂无”，并说明时间范围、限制条件和交付用途。`;
    return (
      <div className="ewb-section">
        <SectionHeading title="单独派活" description="先按这个岗位的操作指引给齐材料；开工后会锁定全部必备能力、提示词和工作配置。" />
        <Alert type={dispatchAvailable ? 'info' : 'warning'} showIcon
          message={dispatchAvailable ? `本次锁定 ${capabilityCount} 项岗位必备能力，不可关闭` : '该员工当前不可执行'}
          description={profile.dispatch.snapshotNotice || profile.dispatch.boundary || '任务记录会保存能力、提示词与配置快照，便于追溯。'} />
        <div className="ewb-dispatch-capabilities" aria-label="本次锁定能力">
          {profile.capabilities.filter(capability => capability.required !== false).map((capability, index) => (
            <Tag icon={<LockOutlined />} color="blue" key={capability.id || capability.key || `${capability.name}-${index}`}>{capability.name}</Tag>
          ))}
        </div>
        <section className="ewb-dispatch-guide" aria-label={`${profile.identity.name}派活操作指引`}>
          <div className="ewb-dispatch-guide-intro">
            <span>这个岗位怎么派活</span>
            <strong>{profile.identity.emoji || '🧭'} {profile.identity.name}</strong>
            <p>{text(guidance.intro) || `${profile.identity.name}会严格按岗位档案处理专项问题；材料不足时会标出缺口，不会猜测成事实。`}</p>
          </div>
          <div className="ewb-dispatch-guide-grid">
            <div>
              <span className="ewb-dispatch-guide-label">开工前请准备</span>
              {materialChecklist.length
                ? <ul>{materialChecklist.map((item, index) => <li key={index}>{item}</li>)}</ul>
                : <p>接口未返回岗位必要输入，请先查看“工作方式”。</p>}
            </div>
            <div>
              <span className="ewb-dispatch-guide-label">这个岗位会交付</span>
              {deliverableChecklist.length
                ? <ul>{deliverableChecklist.map((item, index) => <li key={index}>{item}</li>)}</ul>
                : <p>接口未返回岗位交付清单，请先查看“工作方式”。</p>}
            </div>
          </div>
          {!!taskExamples.length && (
            <div className="ewb-dispatch-examples">
              <span className="ewb-dispatch-guide-label">可直接参考的任务</span>
              <div>
                {taskExamples.map((example, index) => (
                  <button type="button" key={`${example}-${index}`}
                    disabled={!dispatchAvailable}
                    onClick={() => dispatchForm.setFieldValue('title', example)}
                    aria-label={`使用任务示例：${example}`}>
                    <b>{index + 1}</b><span>{example}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {text(guidance.evidenceTip) && (
            <p className="ewb-dispatch-evidence-tip">证据要求：{guidance.evidenceTip}</p>
          )}
        </section>
        <div className="ewb-panel">
          <Form form={dispatchForm} layout="vertical" requiredMark={false} onFinish={submitDispatch}>
            <Form.Item name="title" label={titleLabel}
              rules={[{ required: true, message: `请写明要交给${profile.identity.name}的具体问题` }, { min: 4, message: '任务目标至少4个字' }]}>
              <Input maxLength={100} showCount disabled={!dispatchAvailable} placeholder={titlePlaceholder} />
            </Form.Item>
            {!!dispatchTypes(profile.dispatch).length && (
              <Form.Item name="type" label="希望的交付形式" rules={[{ required: true, message: '请选择交付形式' }]}>
                <Select options={dispatchTypes(profile.dispatch)} disabled={!dispatchAvailable} />
              </Form.Item>
            )}
            {domain === 'content' && (
              <div className="ewb-content-native-fields">
                <Form.Item name="industry" label="行业 / 赛道（可选）"
                  extra="会进入内容岗位原生提示词的行业参数；不知道可留空，不会自动猜测。"
                  rules={[{ max: 200, message: '行业/赛道不能超过200字' }]}>
                  <Input maxLength={200} showCount disabled={!dispatchAvailable}
                    placeholder="例：餐饮连锁、企业团餐、本地生活服务" />
                </Form.Item>
                <Form.Item name="feedback" label="上一版意见 / 必须落实（可选）"
                  extra="用于返工、续写或修订迭代，会作为本次岗位原生反馈参数完整传入。"
                  rules={[{ max: 4000, message: '上一版意见不能超过4000字' }]}>
                  <Input.TextArea rows={4} maxLength={4000} showCount disabled={!dispatchAvailable}
                    placeholder="例：上一版开头太泛；本次必须保留已确认价格，不要新增未经核验的数据。" />
                </Form.Item>
              </div>
            )}
            <Form.Item name="requirement" label={requirementLabel}
              rules={[{ required: true, message: `请补充${profile.identity.name}需要的真实材料` }, { min: 12, message: '请至少写12个字，避免员工只能猜测' }]}>
              <Input.TextArea rows={7} maxLength={8000} showCount disabled={!dispatchAvailable}
                placeholder={requirementPlaceholder} />
            </Form.Item>
            <Form.Item label={text(guidance.imageLabel) || `${profile.identity.name}相关图片证据（可选）`}
              extra={text(guidance.imageHelp) || '如图片有助于岗位判断，可附一张PNG、JPEG或WebP；图片只随本次模型调用使用，任务快照仅保存文件名、大小与哈希。'}>
              <div className="ewb-image-input">
                <label>
                  <PictureOutlined />
                  <span>{dispatchImage ? '更换图片' : '选择 PNG / JPEG / WebP'}</span>
                  <input ref={dispatchImageInputRef} type="file" accept="image/png,image/jpeg,image/webp"
                    disabled={!dispatchAvailable}
                    onChange={event => loadDispatchImage(event.target.files?.[0])} />
                </label>
                {dispatchImage && (
                  <Space size={6} wrap>
                    <Tag color="blue">{dispatchImage.name}</Tag>
                    <Button size="small" danger type="text" onClick={() => {
                      setDispatchImage(null);
                      if (dispatchImageInputRef.current) dispatchImageInputRef.current.value = '';
                    }}>移除</Button>
                  </Space>
                )}
              </div>
            </Form.Item>
            <Form.Item label="统一文件中心附件（可选）"
              extra="最多6份PDF、Word、Excel、CSV、JSON、文本或图片；可与上方单张视觉证据并存。可读正文只进入本次模型上下文，任务快照仅保存文件引用。">
              <UnifiedFilePicker
                compact
                files={dispatchFiles}
                onChange={setDispatchFiles}
                purpose={`employee-workbench-${domain}`}
                maxFiles={6}
                label="选择或上传附件"
              />
            </Form.Item>
            <Form.Item name="dueAt" label="截止时间（可选）"><Input type="datetime-local" disabled={!dispatchAvailable} /></Form.Item>
            <Button type="primary" htmlType="submit" icon={<RocketOutlined />} size="large" block
              loading={saving === 'dispatch'} disabled={!dispatchAvailable}>确认派活并锁定能力快照</Button>
          </Form>
        </div>
        {lastSnapshot && (
          <Alert type="success" showIcon message="任务已建立，执行快照已保存"
            description={[
              lastSnapshot.profileVersion && '岗位档案快照已保存',
              lastSnapshot.promptHash && `提示词 ${String(lastSnapshot.promptHash).slice(0, 12)}…`,
              Number.isFinite(lastSnapshot.capabilityCount) && `${lastSnapshot.capabilityCount} 项能力`,
              lastSnapshot.configVersion && '工作配置快照已保存',
            ].filter(Boolean).join(' · ')} />
        )}
        {domain === 'restaurant' && restaurantTask && (
          <Alert showIcon type={restaurantTask.failed ? 'error' : restaurantTask.status === '已完成' ? 'success' : 'info'}
            message={`本次派活进度 · 任务 #${restaurantTask.id} · ${restaurantTask.status || '生成中'}`}
            description={<div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
              <Steps size="small" current={restaurantTask.failed ? 1 : (restaurantTask.stepIndex ?? 1)}
                status={restaurantTask.failed ? 'error' : restaurantTask.status === '已完成' ? 'finish' : 'process'}
                items={(restaurantTask.flow || ['已派发', 'AI生成中', '待审阅', '已完成']).map((step: string) => ({ title: step }))} />
              <span style={{ fontSize: 'var(--font-1)', color: 'var(--ui-muted)' }}>
                {restaurantTask.failed
                  ? '生成失败，预扣积分已全额退回；可调整输入后重新派活。'
                  : restaurantTask.status === '生成中'
                    ? <>数字员工正在奋笔疾书<span className="nw-typing"><i /><i /><i /></span> 此处每 5 秒自动刷新；也可关闭窗口，完成后会收到站内通知。</>

                    : restaurantTask.status === '待审阅'
                      ? '产出已生成，等待人工审阅；全文可在「经营洞察 → 员工产出」中查看与穿透。'
                      : '任务已结束；产出与证据可在「经营洞察 → 员工产出」中随时回看。'}
              </span>
            </div>} />
        )}
        {domain === 'content' && (
          <section className="ewb-run-center" aria-label="内容员工近期任务与结果">
            <SectionHeading title="近期任务与结果" description="派活后可在这里持续查看生成状态、完整结果、失败说明和人工审阅记录。"
              extra={<Button size="small" icon={<ReloadOutlined />} loading={runsLoading}
                onClick={() => void loadRuns()}>刷新</Button>} />
            {runsError && <Alert type="error" showIcon message="近期任务读取失败" description={runsError}
              action={<Button size="small" onClick={() => void loadRuns()}>重试</Button>} />}
            {selectedRun && (
              <article className="ewb-run-detail">
                <div className="ewb-run-detail-head">
                  <div>
                    <Space size={6} wrap>
                      <Tag color={RUN_STATUS_COLOR[runStatus(selectedRun)] || 'default'}>{runStatus(selectedRun)}</Tag>
                      {selectedRun.type && <Tag>{selectedRun.type}</Tag>}
                      {selectedRun.aiMode && <Tag>{selectedRun.aiMode}{selectedRun.model ? ` · ${selectedRun.model}` : ''}</Tag>}
                    </Space>
                    <h4>{selectedRun.title}</h4>
                    <span><ClockCircleOutlined /> {runTime(selectedRun.createdAt || selectedRun.updatedAt)} · 运行 #{selectedRun.id}</span>
                  </div>
                  <Button size="small" icon={<EyeOutlined />} loading={runDetailLoading}
                    onClick={() => void loadRunDetail(selectedRun.id)}>重新读取详情</Button>
                </div>
                {(selectedRun.industry || selectedRun.feedback || selectedRun.requirement
                  || selectedRun.attachments?.length) && (
                  <div className="ewb-run-inputs">
                    {selectedRun.industry && <div><span>行业 / 赛道</span><p>{selectedRun.industry}</p></div>}
                    {selectedRun.requirement && <div><span>本次材料与约束</span><p>{selectedRun.requirement}</p></div>}
                    {selectedRun.feedback && <div><span>上一版意见 / 必须落实</span><p>{selectedRun.feedback}</p></div>}
                    {!!selectedRun.attachments?.length && (
                      <div>
                        <span>统一文件中心附件</span>
                        <Space size={[4, 4]} wrap>
                          {selectedRun.attachments.map((file, index) => (
                            <Tag key={`${file.id || file.name}-${index}`}
                              color={file.readable ? 'blue' : 'orange'}>
                              {file.name || `附件 ${index + 1}`}
                            </Tag>
                          ))}
                        </Space>
                      </div>
                    )}
                  </div>
                )}
                {selectedRun.status === '生成中' && (
                  <Alert type="info" showIcon message="数字员工正在生成"
                    description="页面会自动刷新；你也可以关闭工作台，稍后从近期任务重新打开。" />
                )}
                {selectedRun.status === '失败' && (
                  <Alert type="error" showIcon message="本次生成失败"
                    description={selectedRun.error || '服务未返回具体失败原因，请保留任务要求后重新派活。'} />
                )}
                {selectedRun.billing && (
                  <Alert
                    type={selectedRun.billing.state === 'pending_reconciliation' ? 'warning' : 'info'}
                    showIcon
                    message={selectedRun.billing.state === 'held'
                      ? `已预授权 ${selectedRun.billing.estimatedCredits || 0} 积分`
                      : selectedRun.billing.state === 'released'
                      ? '生成失败，预授权已退回'
                      : selectedRun.billing.state === 'pending_reconciliation'
                      ? '生成已完成，计费结算待人工对账'
                      : `已按真实用量结算 ${selectedRun.billing.chargedCredits ?? 0} 积分`}
                    description={selectedRun.billing.note || '计费仅对应本次生成；未执行对外发布。'}
                  />
                )}
                {selectedRun.contract?.valid === true && (
                  <Alert type="success" showIcon message="岗位原生输出契约校验通过"
                    description={`已覆盖岗位必需字段；${selectedRun.contract.artifacts.length
                      ? `形成 ${selectedRun.contract.artifacts.length} 个可追溯产物。`
                      : '当前岗位没有独立下载产物。'}`} />
                )}
                {selectedRun.contract?.valid === false && (
                  <Alert type="warning" showIcon message="待审阅 · 输出格式需要修复，当前不能采纳"
                    description={
                      <>
                        <div>请驳回并填写返工意见；修复岗位原生结构契约后，才能采纳。</div>
                        <ul className="ewb-contract-errors">
                          {(selectedRun.contract.errors.length
                            ? selectedRun.contract.errors
                            : ['输出未通过岗位原生结构契约，当前只展示原始降级底稿。'])
                            .map((error, index) => <li key={index}>{error}</li>)}
                        </ul>
                      </>
                    } />
                )}
                {selectedRun.resultMd && (
                  <div className="ewb-run-output">
                    <div className="ewb-run-output-title">运行产出</div>
                    <Markdown content={selectedRun.resultMd} />
                  </div>
                )}
                {!!selectedRun.contract?.artifacts.length && (
                  <div className="ewb-run-artifacts">
                    <strong>岗位产物</strong>
                    <Space wrap>
                      {selectedRun.contract.artifacts.map((artifact, index) => (
                        artifact.downloadUrl ? (
                          <Button key={`${artifact.filename}-${index}`} icon={<FileTextOutlined />}
                            href={artifact.downloadUrl}>
                            下载 {artifact.filename || 'HTML演绎稿'}
                          </Button>
                        ) : (
                          <Tag key={`${artifact.filename}-${index}`}>
                            {artifact.filename || artifact.kind || `产物 ${index + 1}`}
                          </Tag>
                        )
                      ))}
                    </Space>
                    <p>HTML只作为附件下载，工作台不会执行或内嵌预览其中代码。</p>
                  </div>
                )}
                {selectedRun.review && (
                  <div className="ewb-run-review-record">
                    <strong>{selectedRun.review.decision === 'adopt' ? '已采纳' : '已驳回'}</strong>
                    <span>{selectedRun.review.reviewerName || '审阅人未记录'} · {runTime(selectedRun.review.reviewedAt)}</span>
                    {selectedRun.review.materialId && <span>内容生产仓素材 #{selectedRun.review.materialId}</span>}
                    {selectedRun.review.contentId && (
                      <span>已形成可发布内容 #{selectedRun.review.contentId}，可在内容列表继续登记；系统未自动发布</span>
                    )}
                    {selectedRun.review.opinion && <p>{selectedRun.review.opinion}</p>}
                  </div>
                )}
                {profile.permissions.canReviewRuns && selectedRun.status === '待审阅' && (
                  <div className="ewb-run-review-actions">
                    <Button type="primary" loading={reviewing}
                      disabled={selectedRun.contract?.valid !== true}
                      title={selectedRun.contract?.valid === true ? undefined : '输出格式契约通过后才能采纳'}
                      onClick={() => confirmAdoptRun(selectedRun)}>
                      {selectedRun.contract?.valid === true ? '采纳' : '格式修复后可采纳'}
                    </Button>
                    <Button danger disabled={reviewing} onClick={() => {
                      setRejectOpinion('');
                      setRejectRun(selectedRun);
                    }}>驳回</Button>
                  </div>
                )}
                {!profile.permissions.canReviewRuns && selectedRun.status === '待审阅' && (
                  <Alert type="warning" showIcon message="等待老板或管理员审阅"
                    description="当前账号可以回看完整结果，但不能自行采纳或驳回。" />
                )}
              </article>
            )}
            <div className="ewb-run-list" aria-busy={runsLoading}>
              {runs.map(run => (
                <button type="button" key={run.id} className={selectedRun?.id === run.id ? 'active' : ''}
                  onClick={() => void loadRunDetail(run.id)}>
                  <span className="ewb-run-list-status">
                    <i className={`status-${run.status}`} />
                    <Tag color={RUN_STATUS_COLOR[runStatus(run)] || 'default'}>{runStatus(run)}</Tag>
                  </span>
                  <strong>{run.title}</strong>
                  <small>{run.type || '岗位交付'} · {runTime(run.createdAt || run.updatedAt)}</small>
                  {run.resultPreview && <p>{run.resultPreview}</p>}
                </button>
              ))}
              {!runsLoading && !runs.length && !runsError && (
                <HonestEmpty description="这名内容员工还没有派活记录" />
              )}
            </div>
          </section>
        )}
      </div>
    );
  })();

  const capabilityTab = profile && (
    <div className="ewb-section">
      <SectionHeading title="完整能力" description="岗位必备能力是出厂硬能力，每次开工全部锁定运用，不能关闭或打折。" />
      <Alert type="info" showIcon message={`岗位必备能力 ${profile.capabilities.filter(item => item.required !== false).length} 项，全部锁定启用`}
        description="技能库中的附加技能可以更新，但不会替代、删减或绕过这些岗位必备能力。" />
      <LockedCapabilities capabilities={profile.capabilities} />
    </div>
  );

  const skillsTab = profile && (
    <div className="ewb-section">
      <SectionHeading title="技能库" description="严格区分出厂岗位 Skill、历史待核验技能和本企业自定义技能。"
        extra={profile.permissions.canEditSkills
          ? <Button icon={<PlusOutlined />} onClick={() => setCustomSkillOpen(true)}>添加自定义技能</Button>
          : undefined} />
      {profile.skillLibrary.boundary && <Alert type="info" showIcon message={profile.skillLibrary.boundary} />}
      <div className="ewb-skill-group">
        <h4>出厂岗位 Skill · 锁定</h4>
        {skills.factory.length ? <div className="ewb-skill-list">{skills.factory.map((skill, index) => (
          <SkillCard key={skill.id || skill.key || `${skillTitle(skill)}-${index}`} skill={skill} kind="factory"
            editable={!!profile.permissions.canEditSkills} saving={saving === 'skills'}
            onToggle={() => void toggleOptionalSkill(skill)} />
        ))}</div> : <HonestEmpty description="接口没有返回出厂岗位 Skill" />}
      </div>
      <div className="ewb-skill-group">
        <h4>历史技能 · 待核验</h4>
        {skills.historical.length ? <div className="ewb-skill-list">{skills.historical.map((skill, index) => (
          <SkillCard key={skill.id || skill.key || `${skillTitle(skill)}-${index}`} skill={skill} kind="historical"
            editable={false} saving={saving === 'skills'} />
        ))}</div> : <HonestEmpty description="没有待核验的历史技能" />}
      </div>
      <div className="ewb-skill-group">
        <h4>本企业自定义技能</h4>
        {skills.custom.length ? <div className="ewb-skill-list">{skills.custom.map((skill, index) => (
          <SkillCard key={skill.id || skill.key || `${skillTitle(skill)}-${index}`} skill={skill} kind="custom"
            editable={!!profile.permissions.canEditSkills} saving={saving === 'skills'}
            onToggle={() => void toggleCustomSkill(skill)} onDelete={() => deleteCustomSkill(skill)} />
        ))}</div> : <HonestEmpty description="尚未配置企业自定义技能" />}
      </div>
    </div>
  );

  const promptTab = profile && (
    <div className="ewb-section">
      <SectionHeading title="提示词" description="完整展示岗位默认、流水线、单独派活、企业覆盖、生效摘要与审计哈希；不会展示密钥或系统安全规则。"
        extra={profile.permissions.canEditPrompt
          ? <Space><Button onClick={() => setPromptDraft('')} disabled={saving === 'prompt'}>恢复默认</Button>
            <Button type="primary" icon={<SaveOutlined />} loading={saving === 'prompt'} onClick={() => void savePrompt()}>保存生效</Button></Space>
          : undefined} />
      {profile.prompts.finalOutputContract && (
        <Alert type="success" showIcon message="当前岗位最终输出契约 · 最高格式优先级"
          description={
            <div>
              <div>格式：{profile.prompts.finalOutputContract.format || 'json_object'}；
                主产物：{profile.prompts.finalOutputContract.primaryArtifact || 'json'}；
                必须字段：{profile.prompts.finalOutputContract.outputKeys?.join('、') || '接口未提供'}。</div>
              <div style={{ marginTop: 4 }}>来源模板中若仍有“只输出 Markdown”等旧通用要求，以当前岗位最终 JSON 契约为准；来源原文仍保留供追溯。</div>
            </div>
          } />
      )}
      {!profile.permissions.canViewPrompt ? (
        <Alert type="warning" showIcon message="当前账号没有查看岗位提示词的权限" />
      ) : (
        <>
          {profile.prompts.boundary && <Alert type="info" showIcon message={profile.prompts.boundary} />}
          <div className="ewb-prompt-grid">
            <div className="ewb-panel">
              <h4>出厂默认提示词</h4>
              <pre className="ewb-codebox">{text(profile.prompts.defaultTemplate) || text(profile.prompts.default) || '接口未提供默认提示词'}</pre>
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
              <Input.TextArea className="ewb-codebox" value={promptDraft} rows={12}
                readOnly={!profile.permissions.canEditPrompt} onChange={event => setPromptDraft(event.target.value)}
                placeholder={profile.permissions.canEditPrompt ? '留空表示使用出厂默认提示词' : '当前没有企业覆盖'} />
            </div>
            <div className="ewb-panel wide">
              <h4>当前生效摘要</h4>
              <p style={{ margin: 0, color: 'var(--ui-text-2)', lineHeight: 1.75 }}>
                {text(profile.prompts.effectiveSummary) || text(profile.prompts.summary)
                  || (text(profile.prompts.effectiveTemplate)
                    ? `${text(profile.prompts.effectiveTemplate).slice(0, 500)}${text(profile.prompts.effectiveTemplate).length > 500 ? '…' : ''}`
                    : '接口未提供生效提示词摘要')}
              </p>
              <div className="ewb-prompt-meta" style={{ marginTop: 11 }}>
                {(profile.prompts.effectiveHash || profile.prompts.hash) && (
                  <span>SHA-256：<Typography.Text copyable>{profile.prompts.effectiveHash || profile.prompts.hash}</Typography.Text></span>
                )}
              </div>
            </div>
            {profile.prompts.systemPrompt?.reason && (
              <Alert className="wide" type="info" showIcon
                message={`系统消息：${profile.prompts.systemPrompt.messageMode || '未配置'}`}
                description={profile.prompts.systemPrompt.reason} />
            )}
          </div>
        </>
      )}
    </div>
  );

  const configTab = profile && (
    <div className="ewb-section">
      <SectionHeading title="工作配置" description="配置只改变执行参数，不会停用岗位必备能力。"
        extra={profile.permissions.canEditConfig && configFields.length
          ? <Button type="primary" icon={<SaveOutlined />} loading={saving === 'config'} onClick={() => void saveConfig()}>保存配置</Button>
          : undefined} />
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
                <Form.Item key={field.key} name={field.key} label={field.label}
                  valuePropName={field.type === 'boolean' ? 'checked' : 'value'}
                  extra={field.description}
                  rules={field.required ? [{ required: true, message: `请填写${field.label}` }] : undefined}>
                  <ConfigField field={field} />
                </Form.Item>
              ))}
            </div>
          </Form>
        </div>
      ) : Object.keys(configValues(profile.workConfig)).length ? (
        <Descriptions className="ewb-description" bordered size="small" column={{ xs: 1, sm: 2 }}
          items={Object.entries(configValues(profile.workConfig)).map(([key, value]) => ({ key, label: key, children: displayValue(value) }))} />
      ) : <HonestEmpty description="该岗位没有可配置项，页面不会虚构配置开关" />}
      <div className="ewb-prompt-meta">
        {profile.workConfig.mode && <span>模式：{profile.workConfig.mode}</span>}
      </div>
    </div>
  );

  const jobTab = profile && (
    <div className="ewb-section">
      <SectionHeading title="岗位档案" description="展示权威岗位身份、职责、适用范围、档案来源和经营边界。" />
      {profileDescriptionItems(profile.jobProfile, profile.identity).length ? (
        <Descriptions className="ewb-description" bordered size="small" column={{ xs: 1, sm: 2 }}
          items={profileDescriptionItems(profile.jobProfile, profile.identity).map((item, index) => ({
            key: `${item.label}-${index}`, label: item.label, children: item.value,
            span: ['岗位职责', '岗位介绍', '适用范围'].includes(item.label) ? 2 : 1,
          }))} />
      ) : <HonestEmpty description="接口没有返回岗位档案" />}
      {!!profile.jobProfile.boundaries?.length && (
        <div className="ewb-panel">
          <h4 className="ewb-config-title">岗位边界</h4>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--ui-text-2)', lineHeight: 1.8 }}>
            {profile.jobProfile.boundaries.map((boundary, index) => <li key={index}>{boundary}</li>)}
          </ul>
        </div>
      )}
    </div>
  );

  const tabItems = profile ? [
    { key: 'dispatch', label: <span><RocketOutlined /> 单独派活</span>, children: dispatchTab },
    { key: 'capabilities', label: <span><ThunderboltOutlined /> 能力</span>, children: capabilityTab },
    { key: 'method', label: <span><ApartmentOutlined /> 工作方式</span>, children: <WorkMethodTab method={profile.workMethod} /> },
    { key: 'skills', label: <span><BookOutlined /> 技能库</span>, children: skillsTab },
    { key: 'prompts', label: <span><CodeOutlined /> 提示词</span>, children: promptTab },
    { key: 'config', label: <span><SettingOutlined /> 工作配置</span>, children: configTab },
    { key: 'profile', label: <span><IdcardOutlined /> 岗位档案</span>, children: jobTab },
  ] : [];

  const provenance = profile?.provenance;
  const provenanceText = provenance ? [
    provenance.authority && `权威来源：${provenance.authority}`,
    (provenance.source || provenance.sourcePath) && `路径：${provenance.source || provenance.sourcePath}`,
    provenance.referenceSha256 && `SHA-256：${provenance.referenceSha256}`,
    provenance.executionMode && `执行模式：${provenance.executionMode}`,
    provenance.updatedAt && `更新：${provenance.updatedAt}`,
  ].filter(Boolean).join(' · ') : '';

  return (
    <>
      <Drawer rootClassName="employee-workbench-drawer-root" className="employee-workbench-drawer"
        width="min(1040px, 100vw)" open={open} onClose={onClose}
        destroyOnClose title={titleIdentity ? (
          <div className="ewb-title" style={{ '--ewb-color': identityColor(titleIdentity) || 'var(--ui-primary)' } as CSSProperties}>
            <span className="ewb-title-avatar">{titleIdentity.emoji || '🧑‍💼'}</span>
            <div className="ewb-title-copy">
              <div className="ewb-title-name">
                <strong>{titleIdentity.person ? `${titleIdentity.person} · ${titleIdentity.name}` : titleIdentity.name}</strong>
                {titleIdentity.extension && <Tag color="blue">扩展</Tag>}
            </div>
            <div className="ewb-title-sub">{titleIdentity.group
              || ('department' in titleIdentity && typeof titleIdentity.department === 'object'
                ? text((titleIdentity.department as { name?: string })?.name) : '')
              || '完整数字员工工作台'} · #{titleIdentity.idx}</div>
            </div>
          </div>
        ) : '数字员工完整工作台'}>
        {loading && <div className="ewb-loading"><Skeleton active avatar paragraph={{ rows: 12 }} /></div>}
        {!loading && loadError && (
          <div className="ewb-error">
            <Alert type="error" showIcon message="员工完整工作台读取失败"
              description={`${loadError}。页面不会用目录静态值冒充完整档案。`}
              action={<Button size="small" onClick={() => void loadProfile()}>重新读取</Button>} />
          </div>
        )}
        {!loading && !loadError && profile && (
          <div className="ewb-shell" style={{ '--ewb-color': identityColor(profile.identity) || 'var(--ui-primary)' } as CSSProperties}>
            <section className="ewb-overview">
              <div className="ewb-overview-copy">
                <p>{profile.identity.intro || profile.identity.duty || '接口未提供岗位介绍'}</p>
                <div className="ewb-overview-tags">
                  {(profile.identity.group || departmentName(profile.identity)) && <Tag>{profile.identity.group || departmentName(profile.identity)}</Tag>}
                  <Tag color={runtime.status === '执行中' || profile.identity.status === '执行中' ? 'orange' : 'green'}>
                    {runtime.status || profile.identity.status || '状态未采集'}
                  </Tag>
                  <Tag color="blue" icon={<LockOutlined />}>{capabilityCount} 项必备能力锁定</Tag>
                </div>
              </div>
              {!!liveRuntimeItems.length && (
                <div className="ewb-runtime" aria-label="员工真实运行统计">
                  {liveRuntimeItems.map(item => <div className="ewb-runtime-item" key={item.label}><strong>{item.value}</strong><span>{item.label}</span></div>)}
                </div>
              )}
            </section>
            <main className="ewb-content">
              <Tabs className="ewb-tabs" activeKey={activeTab} onChange={setActiveTab} items={tabItems} animated={false} />
              {(provenanceText || provenance?.boundary) && (
                <footer className="ewb-provenance">
                  <FileTextOutlined /> {[provenanceText, provenance?.boundary].filter(Boolean).join(' · ')}
                </footer>
              )}
            </main>
          </div>
        )}
      </Drawer>
      <Modal open={!!rejectRun} title={`驳回产出：${rejectRun?.title || ''}`}
        okText="确认驳回" cancelText="取消" okButtonProps={{ danger: true }}
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
        }}>
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message="驳回后本次运行会保留结果、执行快照和审阅意见，便于追溯。" />
        <Input.TextArea rows={4} maxLength={1000} showCount value={rejectOpinion}
          onChange={event => setRejectOpinion(event.target.value)}
          placeholder="请写明需要修改的问题、证据缺口或不予采纳的原因。" />
      </Modal>
      <Modal title="添加企业自定义技能" open={customSkillOpen} onCancel={() => setCustomSkillOpen(false)}
        okText="添加技能" cancelText="取消" confirmLoading={saving === 'skills'} onOk={() => void addCustomSkill()} destroyOnClose>
        <Alert type="info" showIcon style={{ marginBottom: 16 }}
          message="自定义技能是岗位能力的补充，不会替代或关闭出厂必备能力。" />
        <Form form={customSkillForm} layout="vertical" requiredMark={false}>
          <Form.Item name="title" label="技能名称" rules={[{ required: true, message: '请填写技能名称' }, { max: 60 }]}>
            <Input placeholder="例：本店晚市菜单复盘法" />
          </Form.Item>
          <Form.Item name="detail" label="技能说明" rules={[{ required: true, message: '请说明技能如何使用' }, { min: 8 }, { max: 500 }]}>
            <Input.TextArea rows={4} placeholder="说明适用任务、使用方法、输入要求和验证标准。" />
          </Form.Item>
          <Form.Item name="source" label="来源（建议填写）" rules={[{ max: 200 }]}>
            <Input placeholder="例：本店2026年第二季度复盘SOP" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
