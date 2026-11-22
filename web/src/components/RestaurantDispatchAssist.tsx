// 派活输入框下方的“常用问法 + 题型预判”（PRD v2.2 FR-13 / FR-1）。
// - 常用问法：点一下把完整问法填进输入框，{城市}{店名} 等花括号里的词换成自己的即可；
// - 题型预判：老板输入时实时显示“将按【快查】回答，约 1 分钟”，可手动切换，
//   例如把快查“升级为完整报告”。选择随派活请求一起提交（intentType）。
// - 我的版本（FR-7.2）：保存城市/商圈/店名/品类等常用值，常用问法自动填好；
// - 追问（FR-2）：方案/产物/完整报告缺关键参数时最多问 3 个，每个可选、可用默认、可整体跳过。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AutoComplete, Button, Drawer, Input, Select, Space, Switch, Tag, Tooltip, Typography, message } from 'antd';
import { api } from '../api/client';
import './RestaurantDispatchAssist.css';

type TemplateItem = {
  id: string;
  type: string;
  typeLabel: string;
  why: string;
  template: string;
  filled?: string;
  unfilledSlots?: string[];
  exampleFilled?: string;
  youGet?: string;
  demo?: boolean;
  isNewRule?: boolean;
};

type FollowupQuestion = { key: string; label: string; default: string; options: string[] };

type SlotPreferences = {
  values: Record<string, string>;
  outputPrefs?: string[];
  skipFollowups: boolean;
  keys: string[];
};

type IntentPreview = {
  intent: { type: string; label: string; confidence: number; reason: string; out_of_scope?: boolean };
  questions?: FollowupQuestion[];
  hint: string;
  switchable: { type: string; label: string }[];
};

type Props = {
  idx: number;
  question: string;
  intentType: string | null;
  disabled?: boolean;
  compactTemplates?: boolean;
  onPickTemplate: (text: string) => void;
  onIntentTypeChange: (type: string | null) => void;
  followupAnswers?: Record<string, string>;
  onFollowupAnswersChange?: (answers: Record<string, string>) => void;
  canEditPreferences?: boolean;
};

const PREFERENCE_FIELDS: { key: string; placeholder: string }[] = [
  { key: '店名', placeholder: '如：望京旗舰店' },
  { key: '门店名', placeholder: '如：望京店' },
  { key: '城市', placeholder: '如：北京' },
  { key: '商圈', placeholder: '如：望京' },
  { key: '品类', placeholder: '如：中式正餐 / 快餐 / 茶饮 / 火锅' },
  { key: '人均', placeholder: '如 95元' },
  { key: '门店数', placeholder: '如 8家' },
  { key: '招牌菜', placeholder: '如 鲜切牛肉' },
  { key: '外卖平台', placeholder: '如 美团外卖' },
  { key: '竞品', placeholder: '如：周边核心对标品牌' },
  { key: '预算', placeholder: '常用活动预算，如 8000元' },
  { key: '目标', placeholder: '常用目标，如 拉新客' },
];

const TYPE_COLOR: Record<string, string> = {
  lookup: 'blue',
  diagnose: 'orange',
  plan: 'green',
  produce: 'cyan',
  full_report: 'gold',
};

const INTENT_OPTION_SUBTITLES: Record<string, string> = {
  lookup: '约1分钟',
  diagnose: '找核心卡点',
  plan: '含假设重算',
  produce: '直接可复制',
  full_report: '深度取证',
};

function formatIntentOptionLabel(type: string, label: string) {
  const subtitle = INTENT_OPTION_SUBTITLES[type];
  return subtitle ? `${label} · ${subtitle}` : label;
}

export default function RestaurantDispatchAssist({
  idx,
  question,
  intentType,
  disabled,
  compactTemplates = false,
  onPickTemplate,
  onIntentTypeChange,
  followupAnswers = {},
  onFollowupAnswersChange,
  canEditPreferences = false,
}: Props) {
  const [templateResult, setTemplateResult] = useState<{ idx: number; revision: number; items: TemplateItem[] } | null>(
    null,
  );
  const [previewResult, setPreviewResult] = useState<{ key: string; payload: IntentPreview } | null>(null);
  const [previewLoadingKey, setPreviewLoadingKey] = useState<string | null>(null);
  const [templatesOverride, setTemplatesOverride] = useState<{ compact: boolean; expanded: boolean } | null>(null);
  const [prefs, setPrefs] = useState<SlotPreferences | null>(null);
  const [prefDraft, setPrefDraft] = useState<Record<string, string>>({});
  const [prefSkip, setPrefSkip] = useState(false);
  const [prefOpen, setPrefOpen] = useState(false);
  const [prefSaving, setPrefSaving] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const templates = templateResult?.idx === idx && templateResult.revision === refreshKey ? templateResult.items : [];
  const templatesExpanded =
    templatesOverride?.compact === compactTemplates ? templatesOverride.expanded : !compactTemplates;

  useEffect(() => {
    let alive = true;
    api
      .get(`/employee-workbench/restaurant/${idx}/question-templates`, { silent: true })
      .then((payload: any) => {
        if (alive && Array.isArray(payload?.items))
          setTemplateResult({ idx, revision: refreshKey, items: payload.items });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [idx, refreshKey]);

  useEffect(() => {
    let alive = true;
    api
      .get('/employee-workbench/restaurant-preferences/slots', { silent: true })
      .then((payload: any) => {
        if (!alive || !payload) return;
        setPrefs(payload as SlotPreferences);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  const openPreferences = (visible: boolean) => {
    setPrefOpen(visible);
    if (visible) {
      setPrefDraft({ ...(prefs?.values || {}) });
      setPrefSkip(prefs?.skipFollowups === true);
    }
  };

  const savePreferences = useCallback(async () => {
    setPrefSaving(true);
    try {
      const saved = (await api.put('/employee-workbench/restaurant-preferences/slots', {
        values: prefDraft,
        skipFollowups: prefSkip,
      })) as SlotPreferences;
      setPrefs(saved);
      setPrefOpen(false);
      setRefreshKey(key => key + 1);
      message.success('已保存“我的版本”，常用问法会自动填好');
    } catch (error: any) {
      message.error(error?.message || '保存失败');
    } finally {
      setPrefSaving(false);
    }
  }, [prefDraft, prefSkip]);

  const trimmed = (question || '').trim();
  const previewKey = JSON.stringify([idx, trimmed, intentType, refreshKey]);
  const preview = trimmed.length >= 4 && previewResult?.key === previewKey ? previewResult.payload : null;
  const previewLoading = trimmed.length >= 4 && !preview && previewLoadingKey === previewKey;
  const followupDismissed = dismissedKey === previewKey;
  useEffect(() => {
    if (trimmed.length < 4) return;
    let active = true;
    const timer = window.setTimeout(() => {
      if (!active) return;
      setPreviewLoadingKey(previewKey);
      api
        .post(
          `/employee-workbench/restaurant/${idx}/intent-preview`,
          { title: trimmed.slice(0, 100), requirement: trimmed, intentType },
          { silent: true },
        )
        .then((payload: any) => {
          if (active && payload?.intent) setPreviewResult({ key: previewKey, payload });
        })
        .catch(() => {})
        .finally(() => {
          if (active) setPreviewLoadingKey(current => (current === previewKey ? null : current));
        });
    }, 450);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [idx, trimmed, intentType, previewKey]);

  const questions = useMemo(
    () => (followupDismissed ? [] : (preview?.questions || []).slice(0, 3)),
    [preview?.questions, followupDismissed],
  );
  const questionKeys = questions.map(item => item.key).join('|');
  useEffect(() => {
    // 题目变了：丢掉已不再追问的答案，避免把旧答案带进新任务书。
    if (!onFollowupAnswersChange) return;
    const allowed = new Set(questionKeys ? questionKeys.split('|') : []);
    const kept = Object.fromEntries(Object.entries(followupAnswers).filter(([key]) => allowed.has(key)));
    if (Object.keys(kept).length !== Object.keys(followupAnswers).length) onFollowupAnswersChange(kept);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionKeys]);

  const setAnswer = (key: string, value: string) => {
    if (!onFollowupAnswersChange) return;
    const next = { ...followupAnswers };
    if (value) next[key] = value;
    else delete next[key];
    onFollowupAnswersChange(next);
  };

  const options = useMemo(
    () => [
      { value: '', label: '自动判断' },
      ...(
        preview?.switchable || [
          { type: 'lookup', label: '快查' },
          { type: 'diagnose', label: '诊断' },
          { type: 'plan', label: '方案' },
          { type: 'produce', label: '产物' },
          { type: 'full_report', label: '完整报告' },
        ]
      ).map(item => ({ value: item.type, label: formatIntentOptionLabel(item.type, item.label) })),
    ],
    [preview?.switchable],
  );

  const showChips = !compactTemplates || templatesExpanded;

  return (
    <div className="ewb-dispatch-assist">
      {templates.length > 0 && (
        <div className="ewb-dispatch-assist-templates">
          <div className="ewb-dispatch-assist-templates-bar">
            {compactTemplates ? (
              <Button
                size="small"
                type="link"
                className="ewb-templates-toggle"
                aria-expanded={templatesExpanded}
                onClick={() => setTemplatesOverride({ compact: compactTemplates, expanded: !templatesExpanded })}
              >
                {templatesExpanded
                  ? `收起常用问法（${templates.length} 条）`
                  : `常用问法（点击展开 · ${templates.length} 条）`}
              </Button>
            ) : (
              <Typography.Text type="secondary" className="ewb-dispatch-assist-label">
                常用问法（点一下填入，把花括号里的词换成你的）：
              </Typography.Text>
            )}
            <Button size="small" type="link" className="ewb-pref-trigger" onClick={() => openPreferences(true)}>
              我的版本
              {prefs && Object.keys(prefs.values || {}).length ? `（已存 ${Object.keys(prefs.values).length} 项）` : ''}
            </Button>
          </div>
          <Drawer
            open={prefOpen}
            onClose={() => openPreferences(false)}
            placement="right"
            width={400}
            className="ewb-pref-drawer"
            title="我的版本：保存后常用问法自动填好"
            footer={
              canEditPreferences ? (
                <div className="ewb-pref-drawer-footer">
                  <Button onClick={() => openPreferences(false)}>取消</Button>
                  <Button type="primary" loading={prefSaving} onClick={savePreferences}>
                    保存我的版本
                  </Button>
                </div>
              ) : (
                <Typography.Text type="secondary">仅老板或管理员可修改</Typography.Text>
              )
            }
          >
            <div className="ewb-pref-editor">
              <Typography.Text type="secondary" className="ewb-pref-intro">
                保存常用门店信息后，所有数字员工的「常用问法」会自动填入你的信息，省去重复打字。
              </Typography.Text>
              {PREFERENCE_FIELDS.map(field => (
                <div key={field.key} className="ewb-pref-row">
                  <span className="ewb-pref-key">{field.key}</span>
                  <Input
                    aria-label={field.key}
                    maxLength={40}
                    value={prefDraft[field.key] || ''}
                    placeholder={field.placeholder}
                    disabled={!canEditPreferences}
                    onChange={event => setPrefDraft(draft => ({ ...draft, [field.key]: event.target.value }))}
                  />
                </div>
              ))}
              {(prefs?.outputPrefs || []).length > 0 && (
                <div className="ewb-pref-output">
                  <span className="ewb-pref-key">固定要求</span>
                  <div>
                    {(prefs?.outputPrefs || []).map(item => (
                      <Tag
                        key={item}
                        closable={canEditPreferences}
                        onClose={async event => {
                          event.preventDefault();
                          try {
                            const saved = (await api.put('/employee-workbench/restaurant-preferences/slots', {
                              outputPrefs: (prefs?.outputPrefs || []).filter(pref => pref !== item),
                            })) as SlotPreferences;
                            setPrefs(saved);
                          } catch (error: any) {
                            message.error(error?.message || '删除失败');
                          }
                        }}
                      >
                        {item}
                      </Tag>
                    ))}
                  </div>
                </div>
              )}
              <div className="ewb-pref-row ewb-pref-switch-row">
                <span className="ewb-pref-key">不再追问</span>
                <Switch checked={prefSkip} disabled={!canEditPreferences} onChange={setPrefSkip} />
                <Typography.Text type="secondary" className="ewb-pref-switch-hint">
                  开启后派活时跳过补充提问，直接按默认执行
                </Typography.Text>
              </div>
            </div>
          </Drawer>
          {showChips && (
            <Space size={[6, 6]} wrap>
              {templates.map(item => (
                <Tooltip
                  key={item.id}
                  title={
                    <div>
                      <div>为什么问：{item.why}</div>
                      {item.youGet ? <div>你会拿到：{item.youGet}</div> : null}
                      {item.exampleFilled ? <div>示例：{item.exampleFilled}</div> : null}
                      {item.unfilledSlots?.length ? <div>还需填：{item.unfilledSlots.join('、')}</div> : null}
                    </div>
                  }
                >
                  <Tag
                    color={TYPE_COLOR[item.type] || 'default'}
                    className={`ewb-dispatch-assist-chip${disabled ? ' is-disabled' : ''}`}
                    onClick={() => {
                      if (!disabled) onPickTemplate(item.filled || item.template);
                    }}
                  >
                    {item.isNewRule ? '【新规】' : ''}
                    {item.typeLabel}·{item.why.length > 16 ? `${item.why.slice(0, 16)}…` : item.why}
                  </Tag>
                </Tooltip>
              ))}
            </Space>
          )}
        </div>
      )}
      <div className="ewb-dispatch-assist-intent">
        {preview ? (
          <Typography.Text type="secondary">
            {intentType ? `将按【${preview.intent.label}】回答（已手动选择）` : preview.hint}
            {preview.intent.out_of_scope ? '；这个问题不完全在本岗位主业内，可考虑换更对口的员工' : ''}
          </Typography.Text>
        ) : previewLoading ? (
          <Typography.Text type="secondary" className="ewb-dispatch-assist-loading">
            正在判断最合适的回答方式…
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">
            员工会先判断你问的是快查、诊断、方案、产物还是完整报告，再决定怎么答
          </Typography.Text>
        )}
        <Select
          size="small"
          value={intentType || ''}
          options={options}
          disabled={disabled}
          className="ewb-dispatch-assist-select"
          popupMatchSelectWidth={false}
          aria-label="回答方式"
          onChange={value => onIntentTypeChange(value ? String(value) : null)}
        />
      </div>
      {onFollowupAnswersChange && questions.length > 0 && (
        <div className="ewb-followups">
          <Typography.Text type="secondary" className="ewb-followups-title">
            补充几句会更准（不填就按默认，也可以直接跳过）：
          </Typography.Text>
          {questions.map(question => {
            const value = followupAnswers[question.key] || '';
            const usingDefault = value === '__default__';
            return (
              <div key={question.key} className="ewb-followup-row">
                <span className="ewb-followup-label">{question.label}</span>
                <AutoComplete
                  size="small"
                  className="ewb-followup-input"
                  value={usingDefault ? '' : value}
                  options={question.options.map(option => ({ value: option }))}
                  placeholder={`默认：${question.default}`}
                  disabled={disabled}
                  onChange={text => setAnswer(question.key, String(text || '').slice(0, 60))}
                />
                <Tag
                  color={usingDefault ? 'blue' : 'default'}
                  className={`ewb-followup-default-tag${disabled ? ' is-disabled' : ''}`}
                  onClick={() => {
                    if (!disabled) setAnswer(question.key, usingDefault ? '' : '__default__');
                  }}
                >
                  {usingDefault ? '已用默认' : '用默认'}
                </Tag>
              </div>
            );
          })}
          <Space size={6}>
            <Button
              size="small"
              disabled={disabled}
              onClick={() =>
                onFollowupAnswersChange({
                  ...Object.fromEntries(questions.map(question => [question.key, '__default__'])),
                  ...Object.fromEntries(
                    Object.entries(followupAnswers).filter(([, answer]) => answer && answer !== '__default__'),
                  ),
                })
              }
            >
              其余都用默认
            </Button>
            <Button
              size="small"
              type="text"
              disabled={disabled}
              onClick={() => {
                onFollowupAnswersChange({});
                setDismissedKey(previewKey);
              }}
            >
              跳过追问
            </Button>
          </Space>
        </div>
      )}
    </div>
  );
}
