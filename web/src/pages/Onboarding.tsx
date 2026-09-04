import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Result, Select, Slider, Spin, Steps, Tag, message } from 'antd';
import { ArrowLeftOutlined, ArrowRightOutlined, CheckCircleOutlined, RocketOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api, bootstrapSession, getUser, notifyCredits, type ApiRequestError } from '../api/client';
import { ErrorState } from '../components/Kit';
import EmployeeAvatar from '../components/EmployeeAvatar';
import { UnifiedFilePicker, type UploadedFileRef } from '../components/UnifiedFilePicker';
import './Onboarding.css';

// 开店向导：老板用 5 个固定问题完成初始配置（题目文案由服务端下发）。
// 与 RoleOnboarding（"教你用系统"）不同，这里是"帮你把企业配起来"：
// 落门店档案 → 写企业基础知识 → 推荐 3 位数字员工并一键派第一单。

type FieldType = 'text' | 'textarea' | 'select' | 'multiselect' | 'number' | 'slider' | 'tags' | 'files';

type FieldDef = {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  itemMax?: number;
};

type StepDef = { key: string; title: string; hint: string; fields: FieldDef[] };

type Answers = Record<string, unknown>;

type OnboardingStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

type OnboardingState = {
  status: OnboardingStatus;
  canEdit: boolean;
  answers: Answers;
  completedAt: string | null;
  completion: { storeId?: number; kbDocId?: number; menuFiles?: UploadedFileRef[] } | null;
  steps: StepDef[];
  progress: { answeredSteps: string[]; nextStep: string | null; total: number };
};

type Recommendation = {
  idx: number;
  person: string;
  name: string;
  duty: string;
  group: string;
  intro: string;
  typicalCredits: number | null;
  roleInTeam: string;
  task: string;
  why: string;
};

type CompleteResult = {
  ok: boolean;
  store: { id: number; name: string; created: boolean };
  kbDoc: { id: number; title: string; category: string; created: boolean };
  vectorization: { accepted: boolean; reason: string; error: string | null };
  recommendation: {
    source: 'ai' | 'catalog_default';
    note: string;
    teamName?: string;
    matchText: string;
    members: Recommendation[];
    billing?: { balance?: number } | null;
  };
  // 菜单文件解析出的菜品草稿（只预览不落库；到数据录入中枢确认后才写入）
  menuDraft?: {
    status: 'ready' | 'failed' | 'empty';
    dishes: number;
    pendingRows?: number;
    batches: unknown[];
    files?: { name?: string; status: string; error?: string }[];
    error?: string;
  } | null;
};

const WRITE_ROLES = ['boss', 'admin'];
const DRAFT_DELAY_MS = 900;

function useNarrowViewport(maxWidth = 640) {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(`(max-width: ${maxWidth}px)`).matches : false,
  );
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [maxWidth]);
  return narrow;
}

function pickStepValues(step: StepDef, answers: Answers): Answers {
  const values: Answers = {};
  for (const field of step.fields) {
    if (field.type === 'files') continue;
    if (answers[field.name] !== undefined) values[field.name] = answers[field.name];
  }
  return values;
}

function vectorizationText(vectorization: CompleteResult['vectorization']) {
  if (vectorization.accepted) return '企业档案已进入知识库，正在后台生成语义索引。';
  switch (vectorization.reason) {
    case 'billing_hold_failed':
      return '企业档案已进入知识库；语义索引因积分不足暂未生成，充值后可在知识库里一键回填。';
    case 'disabled':
      return '企业档案已进入知识库；后台语义索引未开启，管理员开启后可在知识库里回填。';
    default:
      return '企业档案已进入知识库；语义索引暂未生成，可稍后在知识库里回填。';
  }
}

function rulesFor(field: FieldDef) {
  const rules: Record<string, unknown>[] = [];
  if (field.required) rules.push({ required: true, message: '这一项要填一下' });
  if ((field.type === 'text' || field.type === 'textarea') && field.max) {
    rules.push({ max: field.max, message: `最多 ${field.max} 字` });
  }
  if (field.type === 'tags' && field.min) {
    rules.push({
      validator: (_rule: unknown, value: unknown) =>
        Array.isArray(value) && value.length >= (field.min || 1)
          ? Promise.resolve()
          : Promise.reject(new Error(`至少写 ${field.min} 道`)),
    });
  }
  return rules;
}

export default function Onboarding() {
  const navigate = useNavigate();
  const user = getUser();
  const narrow = useNarrowViewport();
  const [state, setState] = useState<OnboardingState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [current, setCurrent] = useState(0);
  const [answers, setAnswers] = useState<Answers>({});
  const [menuFiles, setMenuFiles] = useState<UploadedFileRef[]>([]);
  const [draftState, setDraftState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [completing, setCompleting] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [result, setResult] = useState<CompleteResult | null>(null);
  const [dispatchingIdx, setDispatchingIdx] = useState<number | null>(null);
  const [dispatched, setDispatched] = useState<Record<string, number>>({});
  const [reloadNonce, setReloadNonce] = useState(0);
  const [form] = Form.useForm();
  const draftTimer = useRef<number | null>(null);
  const pendingDraft = useRef<Answers>({});

  const canEdit = Boolean(user && WRITE_ROLES.includes(user.role));
  const steps = state?.steps || [];
  const step = steps[current];
  const isLast = current === steps.length - 1;

  // 首次进入与「重新加载」都走这里：把服务端状态铺到本地，并定位到第一个没答完的问题。
  useEffect(() => {
    let cancelled = false;
    const frame = requestAnimationFrame(async () => {
      setLoadError('');
      try {
        const payload = (await api.get('/onboarding/state', { silent: true })) as OnboardingState;
        if (cancelled) return;
        setState(payload);
        setAnswers(payload.answers || {});
        const savedFiles = payload.completion?.menuFiles;
        const ids = Array.isArray(payload.answers?.menuFileIds) ? (payload.answers.menuFileIds as number[]) : [];
        setMenuFiles(
          ids.map(id => savedFiles?.find(file => file.id === id) || { id, name: `已上传的菜单文件 #${id}` }),
        );
        const nextIndex = payload.steps.findIndex(item => item.key === payload.progress.nextStep);
        setCurrent(payload.status === 'completed' || nextIndex < 0 ? 0 : nextIndex);
      } catch (error: any) {
        if (!cancelled) setLoadError(error?.message || '开店向导加载失败');
      }
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [reloadNonce]);

  useEffect(
    () => () => {
      if (draftTimer.current) window.clearTimeout(draftTimer.current);
    },
    [],
  );

  const saveAnswers = async (partial: Answers, { quiet = true }: { quiet?: boolean } = {}) => {
    if (!canEdit || !Object.keys(partial).length) return true;
    setDraftState('saving');
    try {
      const payload = (await api.put(
        '/onboarding/answers',
        { answers: partial },
        { silent: quiet },
      )) as OnboardingState;
      setAnswers(payload.answers || {});
      setState(previous => (previous ? { ...previous, status: payload.status, progress: payload.progress } : previous));
      setDraftState('saved');
      return true;
    } catch (error: any) {
      setDraftState('failed');
      if (!quiet) message.error(error?.message || '保存失败，请稍后再试');
      return false;
    }
  };

  const scheduleDraft = (changed: Answers) => {
    pendingDraft.current = { ...pendingDraft.current, ...changed };
    if (draftTimer.current) window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => {
      const batch = pendingDraft.current;
      pendingDraft.current = {};
      void saveAnswers(batch);
    }, DRAFT_DELAY_MS);
  };

  const flushDraft = async () => {
    if (draftTimer.current) window.clearTimeout(draftTimer.current);
    draftTimer.current = null;
    const batch = pendingDraft.current;
    pendingDraft.current = {};
    return saveAnswers(batch, { quiet: false });
  };

  const updateMenuFiles = (files: UploadedFileRef[]) => {
    setMenuFiles(files);
    scheduleDraft({ menuFileIds: files.map(file => file.id) });
  };

  const goNext = async () => {
    if (!step) return;
    let values: Answers;
    try {
      values = (await form.validateFields()) as Answers;
    } catch {
      return;
    }
    pendingDraft.current = { ...pendingDraft.current, ...values };
    const ok = await flushDraft();
    if (!ok) return;
    if (!isLast) setCurrent(index => Math.min(index + 1, steps.length - 1));
  };

  const goBack = async () => {
    const values = form.getFieldsValue() as Answers;
    pendingDraft.current = { ...pendingDraft.current, ...values };
    void flushDraft();
    setCurrent(index => Math.max(index - 1, 0));
  };

  const complete = async () => {
    if (!step) return;
    let values: Answers;
    try {
      values = (await form.validateFields()) as Answers;
    } catch {
      return;
    }
    setCompleting(true);
    try {
      if (draftTimer.current) window.clearTimeout(draftTimer.current);
      const merged = { ...pendingDraft.current, ...values, menuFileIds: menuFiles.map(file => file.id) };
      pendingDraft.current = {};
      const payload = (await api.post('/onboarding/complete', { answers: merged })) as CompleteResult;
      const balance = payload.recommendation?.billing?.balance;
      if (typeof balance === 'number') notifyCredits(balance);
      setResult(payload);
      setState(previous => (previous ? { ...previous, status: 'completed' } : previous));
      await bootstrapSession();
      message.success('开店向导完成，门店档案和企业知识已经建好');
    } catch {
      /* 服务端会把没答完的题目名写在错误里，api 已弹出提示 */
    } finally {
      setCompleting(false);
    }
  };

  const skip = async () => {
    setSkipping(true);
    try {
      await api.post('/onboarding/skip', {});
      await bootstrapSession();
      message.info('已跳过，随时可以在「系统管理」里重新进入开店向导');
      navigate('/', { replace: true });
    } catch {
      /* api 已提示 */
    } finally {
      setSkipping(false);
    }
  };

  const dispatch = async (member: Recommendation) => {
    setDispatchingIdx(member.idx);
    try {
      const payload = (await api.post(`/employee-workbench/restaurant/${member.idx}/dispatch`, {
        question: member.task,
        title: member.task.replace(/\s+/g, ' ').slice(0, 40),
      })) as Record<string, unknown>;
      const taskId = Number(payload?.runId ?? payload?.taskId);
      if (!Number.isSafeInteger(taskId) || taskId <= 0) throw new Error('任务已提交但未返回任务编号');
      const billing = payload?.billing as { balance?: number } | undefined;
      if (typeof billing?.balance === 'number') notifyCredits(billing.balance);
      setDispatched(previous => ({ ...previous, [String(member.idx)]: taskId }));
      message.success(`${member.person}已经开工，带你去看进度`);
      navigate(`/employees?employee=${member.idx}&task=${taskId}`);
    } catch (error: any) {
      // 积分不足等服务端拒绝（402/403）api 已弹出原因；这里只补提示本地抛出的异常，并同步余额。
      const apiError = error as ApiRequestError;
      const billing = apiError?.billing as { balance?: number } | undefined;
      if (typeof billing?.balance === 'number') notifyCredits(billing.balance);
      if (error?.message && !apiError?.status && !apiError?.code) message.error(error.message);
    } finally {
      setDispatchingIdx(null);
    }
  };

  const answeredSteps = state?.progress.answeredSteps || [];
  const stepItems = steps.map((item, index) => ({
    title: item.title,
    status:
      index === current
        ? ('process' as const)
        : answeredSteps.includes(item.key)
          ? ('finish' as const)
          : ('wait' as const),
  }));

  const renderControl = (field: FieldDef) => {
    const options = (field.options || []).map(value => ({ value, label: value }));
    switch (field.type) {
      case 'text':
        return <Input maxLength={field.max} placeholder={field.placeholder} allowClear />;
      case 'textarea':
        return <Input.TextArea rows={4} maxLength={field.max} showCount placeholder={field.placeholder} />;
      case 'select':
        return <Select options={options} placeholder="点一下选" />;
      case 'multiselect':
        return <Select mode="multiple" maxCount={field.max} options={options} placeholder="可以多选几个" />;
      case 'number':
        return <InputNumber className="onboarding-number" min={field.min} max={field.max} addonAfter={field.unit} />;
      case 'slider':
        return (
          <Slider
            min={field.min}
            max={field.max}
            step={field.step || 5}
            marks={{ 0: '全是外卖', 50: '一半一半', 100: '全是堂食' }}
            tooltip={{ formatter: value => `堂食 ${value ?? 0}%` }}
          />
        );
      case 'tags':
        return (
          <Select
            mode="tags"
            maxCount={field.max}
            tokenSeparators={[',', '，', '、']}
            placeholder={field.placeholder}
            notFoundContent={null}
          />
        );
      default:
        return null;
    }
  };

  if (!user || !canEdit) {
    return (
      <div className="onboarding-page">
        <Result
          status="info"
          title="开店向导只能由老板或管理员填写"
          subTitle="请让老板登录后完成企业初始配置，你可以先去看经营驾驶舱。"
          extra={
            <Button type="primary" onClick={() => navigate('/')}>
              回到首页
            </Button>
          }
        />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="onboarding-page">
        <ErrorState description={loadError} onRetry={() => setReloadNonce(value => value + 1)} />
      </div>
    );
  }

  if (!state || !step) {
    return (
      <div className="onboarding-page">
        <Spin size="large" />
      </div>
    );
  }

  if (result) {
    const balance = Number(getUser()?.credits ?? 0);
    return (
      <div className="onboarding-page">
        <section className="onboarding-card">
          <Result
            status="success"
            icon={<CheckCircleOutlined />}
            title="企业已经配好，第一单可以开工了"
            subTitle="门店档案和企业基础知识已经建好，下面这几位数字员工会围着你的目标干活。"
          />
          <div className="onboarding-summary">
            <div>
              <strong>门店：</strong>
              {result.store.name}（{result.store.created ? '已新建' : '已更新'}，可在「经营数据」里继续补充）
            </div>
            <div>
              <strong>企业知识：</strong>
              {result.kbDoc.title}（分类「{result.kbDoc.category}」，可在「系统管理 → 知识库」里修改）
            </div>
            <div>{vectorizationText(result.vectorization)}</div>
            {result.menuDraft?.status === 'ready' ? (
              <div>
                <strong>菜单：</strong>
                识别到 {result.menuDraft.dishes} 道菜
                {result.menuDraft.pendingRows ? `（另有 ${result.menuDraft.pendingRows} 行需补全）` : ''}
                ，尚未写入菜品表。
                <Button
                  type="link"
                  size="small"
                  onClick={() =>
                    navigate('/system?tab=data-intake', { state: { importBatches: result.menuDraft?.batches || [] } })
                  }
                >
                  去确认导入
                </Button>
              </div>
            ) : result.menuDraft && result.menuDraft.status !== 'empty' ? (
              <div>
                <strong>菜单：</strong>
                {result.menuDraft.error ||
                  result.menuDraft.files?.find(file => file.error)?.error ||
                  '菜单文件暂未解析出菜品'}
                ，可稍后在「数据录入中枢」重新上传识别。
              </div>
            ) : null}
          </div>

          <div className="onboarding-team-head">
            <h3>为你推荐的 {result.recommendation.members.length} 位数字员工</h3>
            <Tag color={result.recommendation.source === 'ai' ? 'blue' : 'default'}>
              {result.recommendation.source === 'ai' ? 'AI 读花名册挑的' : '按目标推荐'}
            </Tag>
          </div>
          {result.recommendation.note ? <p className="onboarding-team-note">{result.recommendation.note}</p> : null}
          <div className="onboarding-team">
            {result.recommendation.members.map(member => {
              const doneTaskId = dispatched[String(member.idx)];
              const credits = member.typicalCredits;
              const shortOnCredits = typeof credits === 'number' && balance < credits;
              return (
                <article className="onboarding-member" key={member.idx}>
                  <div className="onboarding-member-head">
                    <EmployeeAvatar idx={member.idx} name={member.person} size={48} />
                    <div>
                      <p className="onboarding-member-name">
                        {member.person} · {member.name}
                      </p>
                      <p className="onboarding-member-duty">
                        {member.group}
                        {member.roleInTeam === '队长' ? ' · 牵头' : ''}
                      </p>
                    </div>
                  </div>
                  <p className="onboarding-member-task">{member.task}</p>
                  {member.why ? <p className="onboarding-member-why">{member.why}</p> : null}
                  <div className="onboarding-member-foot">
                    <span className="onboarding-credit-hint">
                      {typeof credits === 'number'
                        ? `一单约 ${credits} 积分 · 余额 ${balance}`
                        : `当前余额 ${balance} 积分`}
                    </span>
                    {doneTaskId ? (
                      <Button
                        size="small"
                        onClick={() => navigate(`/employees?employee=${member.idx}&task=${doneTaskId}`)}
                      >
                        看进度
                      </Button>
                    ) : (
                      <Button
                        type="primary"
                        size="small"
                        icon={<RocketOutlined />}
                        loading={dispatchingIdx === member.idx}
                        disabled={dispatchingIdx !== null && dispatchingIdx !== member.idx}
                        danger={shortOnCredits}
                        title={shortOnCredits ? '积分可能不够，派活时会做预检' : undefined}
                        onClick={() => void dispatch(member)}
                      >
                        让 TA 现在就干
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          <div className="onboarding-done-actions">
            <Button onClick={() => navigate('/')}>先去看驾驶舱</Button>
            <Button onClick={() => navigate('/employees')}>去数字员工大厅自己挑人</Button>
            <Button type="link" onClick={() => setResult(null)}>
              回去改答案
            </Button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="onboarding-page">
      <header className="onboarding-hero">
        <div>
          <p className="onboarding-kicker">开店向导 · 5 个问题</p>
          <h1 className="onboarding-title">花 5 分钟，把你的店告诉数字员工</h1>
          <p className="onboarding-subtitle">
            答完这 5 个问题，系统会自动建好门店档案和企业知识，并推荐 3
            位最该先上场的数字员工。中途退出也没关系，答案会自动保存。
          </p>
        </div>
        {state.status !== 'completed' ? (
          <Button type="text" loading={skipping} onClick={() => void skip()}>
            先跳过，稍后再说
          </Button>
        ) : null}
      </header>

      {state.status === 'completed' ? (
        <Alert
          type="info"
          showIcon
          message="你之前已经完成过开店向导"
          description="可以修改答案后再次点「完成并开始」，门店档案和企业知识会一起更新，不会重复建。"
        />
      ) : null}

      <section className="onboarding-card">
        <Steps
          className="onboarding-steps"
          current={current}
          items={stepItems}
          size="small"
          direction={narrow ? 'vertical' : 'horizontal'}
          responsive={false}
          onChange={index => {
            if (index < current || state.progress.answeredSteps.includes(steps[index]?.key)) {
              const values = form.getFieldsValue() as Answers;
              pendingDraft.current = { ...pendingDraft.current, ...values };
              void flushDraft();
              setCurrent(index);
            }
          }}
        />
        <h2 className="onboarding-step-title">
          {current + 1}/{steps.length} · {step.title}
        </h2>
        <p className="onboarding-step-hint">{step.hint}</p>

        <Form
          key={step.key}
          form={form}
          layout="vertical"
          className="onboarding-form"
          initialValues={pickStepValues(step, answers)}
          onValuesChange={changed => scheduleDraft(changed as Answers)}
          requiredMark={false}
        >
          {step.fields.map(field =>
            field.type === 'files' ? (
              <div className="onboarding-files" key={field.name}>
                <span>{field.label}</span>
                <UnifiedFilePicker
                  files={menuFiles}
                  onChange={updateMenuFiles}
                  purpose="onboarding"
                  maxFiles={field.max || 3}
                  label="上传菜单"
                />
              </div>
            ) : (
              <Form.Item key={field.name} name={field.name} label={field.label} rules={rulesFor(field)}>
                {renderControl(field)}
              </Form.Item>
            ),
          )}
        </Form>

        <div className="onboarding-actions">
          <span className="onboarding-draft-state">
            {draftState === 'saving'
              ? '正在保存…'
              : draftState === 'saved'
                ? '答案已自动保存'
                : draftState === 'failed'
                  ? '自动保存失败，点「下一步」会重试'
                  : '答案会自动保存'}
          </span>
          <div className="onboarding-actions-main">
            <Button icon={<ArrowLeftOutlined />} disabled={current === 0} onClick={() => void goBack()}>
              上一步
            </Button>
            {isLast ? (
              <Button type="primary" icon={<RocketOutlined />} loading={completing} onClick={() => void complete()}>
                完成并开始
              </Button>
            ) : (
              <Button type="primary" onClick={() => void goNext()}>
                下一步 <ArrowRightOutlined />
              </Button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
