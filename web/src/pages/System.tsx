import React, { useEffect, useState } from 'react';
import {
  Row, Col, Table, Tag, Progress, Tabs, Button, Modal, Input, InputNumber, Select,
  Switch, Alert, message, Popconfirm, Badge, Empty, Tooltip, Space, Drawer,
} from 'antd';
import {
  TeamOutlined, AuditOutlined, BookOutlined, FileTextOutlined, SafetyCertificateOutlined,
  HistoryOutlined, LoginOutlined, CloudServerOutlined, SettingOutlined, RobotOutlined,
  CheckCircleFilled, UserOutlined, DatabaseOutlined, HddOutlined, FieldTimeOutlined,
  PlusOutlined, EditOutlined, CloudUploadOutlined, SaveOutlined, AlertOutlined, UploadOutlined,
  ThunderboltOutlined, DesktopOutlined, CheckOutlined, CloseOutlined,
  LinkOutlined, CopyOutlined, DeleteOutlined, UndoOutlined, EyeOutlined,
  InboxOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { notifyCredits, api, getUser } from '../api/client';
import { Panel } from '../components/Kit';
import DataIntake from './DataIntake';

// ===== 枚举与映射 =====
const ROLE_MAP: Record<string, { label: string; color: string }> = {
  boss: { label: '老板', color: 'gold' },
  ops_director: { label: '运营总监', color: 'blue' },
  sales: { label: '销售', color: 'green' },
  admin: { label: '管理员', color: 'purple' },
  partner: { label: '合伙人', color: 'cyan' },
};
const RISK_TAG: Record<string, { color: string; label: string }> = {
  high: { color: 'red', label: '高风险' },
  medium: { color: 'orange', label: '中风险' },
  low: { color: 'default', label: '低风险' },
};
const RULE_NAMES: Record<string, string> = {
  PRICE_PROMISE: '价格/返利承诺', INVEST_RETURN: '招商收益描述', ABS_WORD: '广告法绝对化用语',
  HEALTH_CLAIM: '医疗保健功效暗示', CONTRACT: '合同/政策口径',
};
const KB_CATS = ['品牌资料', '招商政策', '产品资料', '话术案例', '客户画像', '数据规范', '员工产出'];
const MT_LABELS: Record<string, string> = {
  leads: '新增线索(人)', conversionRate: '成交转化率(%)', repurchaseRate: '复购率(%)',
  partnerActive: '合伙人活跃(%)', contentPerDay: '日均内容(条)',
};
const AB_LABELS: Record<string, string> = {
  inviteSign: '邀约→报名(%)', signArrive: '报名→到场(%)', arriveDeal: '到场→成交(%)',
  referral: '转介绍率(%)', roi: 'ROI基准(倍)',
};
const HW_LABELS: Record<string, string> = {
  leads: '线索增长', conversion: '转化效率', repurchase: '复购健康', partner: '合伙人活跃', content: '内容生产',
};

const fmtUptime = (min: number) => {
  const m = Math.max(0, Math.round(min || 0));
  if (m >= 1440) return `${Math.floor(m / 1440)}天${Math.floor((m % 1440) / 60)}小时`;
  if (m >= 60) return `${Math.floor(m / 60)}小时${m % 60}分`;
  return `${m}分钟`;
};
const fmtKBSize = (kb: number) => (kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb || 0)} KB`);
const parseRules = (s: string): string[] => {
  try {
    const arr = JSON.parse(s || '[]');
    return (Array.isArray(arr) ? arr : []).map((x: any) => (typeof x === 'string' ? (RULE_NAMES[x] || x) : (x?.name || x?.code || '')));
  } catch { return s ? [s] : []; }
};
const parseJson = (s: any, fallback: any = {}) => {
  if (!s) return fallback;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return fallback; }
};
const parseJsonArray = (value: any): any[] => {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
};
const displayValue = (value: any): string => {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join('、');
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => `${key}：${displayValue(item)}`)
      .filter(item => !item.endsWith('：'))
      .join('；');
  }
  return String(value);
};
const displayList = (value: any): any[] => Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value];
const barColor = (p: number) => (p >= 80 ? '#f25b6b' : p >= 60 ? '#f6a02d' : 'var(--ui-accent)');

// 核心数据全挂时的错误态（不展示猜测数据，只给明确错误 + 重试）
function ErrorState({ error, retrying, onRetry }: { error: string; retrying?: boolean; onRetry: () => void }) {
  return (
    <Panel>
      <div style={{ textAlign: 'center', padding: '36px 0' }}>
        <AlertOutlined style={{ fontSize: 34, color: '#f25b6b' }} />
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ui-text)', marginTop: 10 }}>系统数据加载失败</div>
        <div style={{ fontSize: 12.5, color: 'var(--ui-muted)', margin: '6px 0 16px' }}>{error || '网络异常或服务暂不可用'}，已停止展示过期内容，请重试。</div>
        <Button type="primary" icon={<ReloadOutlined />} loading={retrying} onClick={onRetry}>重新加载</Button>
      </div>
    </Panel>
  );
}

// 卡片内小指标块
function MiniStat({ icon, color, label, value, span }: { icon: React.ReactNode; color: string; label: string; value: React.ReactNode; span?: boolean }) {
  return (
    <div style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10, gridColumn: span ? '1 / -1' : undefined }}>
      <div style={{ width: 34, height: 34, borderRadius: 8, background: `color-mix(in srgb, ${color} 10%, transparent)`, color, fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{icon}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--ui-text)', whiteSpace: 'nowrap' }}>{value}</div>
        <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', whiteSpace: 'nowrap' }}>{label}</div>
      </div>
    </div>
  );
}

export default function System() {
  const user = getUser() || {};
  const isAdminish = ['boss', 'ops_director', 'admin'].includes(user.role);   // 查看用户/日志/配置
  const canDecide = ['boss', 'ops_director', 'admin'].includes(user.role);    // 审批权限；具体节点仍按行校验
  const canManageUsers = ['boss', 'admin'].includes(user.role);               // 增改用户
  const canSaveConfig = ['boss', 'admin'].includes(user.role);                // 保存配置
  const canBackup = ['boss', 'admin'].includes(user.role);                    // 数据备份
  const canEditKb = isAdminish;                                               // 知识库维护
  const canEditPrompt = ['boss', 'admin', 'platform_super'].includes(user.role); // 提示词维护
  const canRestoreDeleted = ['boss', 'admin'].includes(user.role);             // 删除留痕/恢复

  const [tab, setTab] = useState(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    return requested && ['overview', 'data-intake', 'approvals', 'kb', 'prompts', 'users', 'trash', 'config'].includes(requested)
      ? requested
      : 'overview';
  });
  const changeTab = (next: string) => {
    setTab(next);
    window.history.replaceState(null, '', `/system?tab=${encodeURIComponent(next)}`);
  };
  const [status, setStatus] = useState<any>({});
  // 审批中心
  const [approvalStatus, setApprovalStatus] = useState('待审核');
  const [approvals, setApprovals] = useState<any[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [rejectRow, setRejectRow] = useState<any>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [approvalView, setApprovalView] = useState<any>(null);
  const [deciding, setDeciding] = useState(false);
  // 知识库
  const [kbCats, setKbCats] = useState<string[]>(KB_CATS);
  const [kbCat, setKbCat] = useState(KB_CATS[0]);
  const loadKbCats = () => api.get('/sys/kb/categories').then((cs: string[]) => { if (Array.isArray(cs) && cs.length) setKbCats(cs); }).catch(() => {});
  const addKbCat = () => {
    let name = '';
    Modal.confirm({
      title: '新增知识库分类',
      okText: '添加分类',
      cancelText: '取消',
      content: <Input placeholder="如：竞品情报 / 培训课件" maxLength={24} onChange={e => { name = e.target.value; }} />,
      onOk: () => {
        const finalName = name.trim();
        if (!finalName) {
          message.warning('请填写分类名称');
          return Promise.reject(new Error('category name required'));
        }
        return api.post('/sys/kb/categories', { name: finalName }).then((cs: string[]) => { setKbCats(cs); setKbCat(finalName); message.success('分类已添加'); });
      },
    });
  };
  // 行级权限设置（谁可查看 / 谁的AI可调用）
  const [kbPerm, setKbPerm] = useState<any>(null);
  const [kbPermSaving, setKbPermSaving] = useState(false);
  const ROLE_OPTS = [
    { value: 'boss', label: '老板' }, { value: 'ops_director', label: '管理层' },
    { value: 'sales', label: '员工' }, { value: 'partner', label: '合伙人' }, { value: 'admin', label: '管理员' },
  ];
  const openKbPerm = (r: any) => setKbPerm({
    id: r.id, title: r.title,
    visible: parseJsonArray(r.visible_roles),
    callable: parseJsonArray(r.callable_roles),
  });
  const saveKbPerm = () => {
    setKbPermSaving(true);
    api.put(`/sys/kb/${kbPerm.id}`, { visible_roles: kbPerm.visible, callable_roles: kbPerm.callable })
      .then(() => { message.success('权限已更新'); setKbPerm(null); loadKb(); })
      .finally(() => setKbPermSaving(false));
  };
  const [kbDocs, setKbDocs] = useState<any[]>([]);
  const [gaps, setGaps] = useState<any[]>([]);
  const [kbReadiness, setKbReadiness] = useState<any>({ categories: [], percent: 0 });
  const [kbInitializing, setKbInitializing] = useState(false);
  const [kbForm, setKbForm] = useState<any>(null);
  const [kbSaving, setKbSaving] = useState(false);
  // 文件上传（文档/图片，自动提取内容；图片走AI识图）
  const [kbUploading, setKbUploading] = useState(false);
  const [kbView, setKbView] = useState<any>(null); // 文档详情抽屉
  const KB_ACCEPT = '.docx,.doc,.xlsx,.xls,.pdf,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp';
  const uploadKbFile = (file: File) => {
    if (file.size > 15 * 1024 * 1024) { message.error('文件超过15MB上限'); return; }
    setKbUploading(true);
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = String(reader.result).split(',')[1];
      const isImg = /image\//.test(file.type);
      message.loading({ content: isImg ? 'AI识图提取要点中（约5-15秒）…' : '上传并提取正文中…', key: 'kbup', duration: 0 });
      api.post('/sys/kb/upload', { name: file.name, b64, category: kbCat === '员工产出' ? '品牌资料' : kbCat })
        .then((res: any) => {
          if (res.billing) notifyCredits(res.billing.balance);
          message.success({ content: res.enabled === 0
            ? `「${res.title}」已提交（${res.extractMode}），待管理员启用后生效，已通知管理层`
            : `「${res.title}」已入库（${res.extractMode}）`, key: 'kbup', duration: 3 });
          loadKb(); loadGaps(); loadKbReadiness();
          setKbView(null);
          api.get(`/sys/kb?category=${encodeURIComponent(kbCat === '员工产出' ? '品牌资料' : kbCat)}`).then((docs: any[]) => {
            const hit = (docs || []).find((d: any) => d.id === res.id);
            if (hit) setKbView(hit);
          });
        })
        .catch(() => message.destroy('kbup'))
        .finally(() => setKbUploading(false));
    };
    reader.readAsDataURL(file);
  };
  // 提示词
  const [prompts, setPrompts] = useState<any[]>([]);
  const [promptForm, setPromptForm] = useState<any>(null);
  const [promptSaving, setPromptSaving] = useState(false);
  const [marshalNaming, setMarshalNaming] = useState<any[]>([]);
  const [marshalPromptStatus, setMarshalPromptStatus] = useState<any[]>([]);
  const [namingApplying, setNamingApplying] = useState(false);
  // 用户与日志
  const [users, setUsers] = useState<any[]>([]);
  const [seat, setSeat] = useState<{ limit: number; used: number }>({ limit: 0, used: 0 });
  const [userForm, setUserForm] = useState<any>(null);
  const [userSaving, setUserSaving] = useState(false);
  const [logs, setLogs] = useState<any[]>([]);
  const [loginLogs, setLoginLogs] = useState<any[]>([]);
  const [deletions, setDeletions] = useState<any[]>([]);
  const [deletionStatus, setDeletionStatus] = useState('active');
  const [deletionLoading, setDeletionLoading] = useState(false);
  const [deletionView, setDeletionView] = useState<any>(null);
  // 配置与备份
  const [cfg, setCfg] = useState<any>({});
  const [cfgSaving, setCfgSaving] = useState(false);
  const [backups, setBackups] = useState<any[]>([]);
  const [feishuCfg, setFeishuCfg] = useState<any>(null);
  const [feishuQr, setFeishuQr] = useState(false);
  const [feishuBind, setFeishuBind] = useState<any>(null);
  const [feishuBindStatus, setFeishuBindStatus] = useState('idle');
  const [feishuSaving, setFeishuSaving] = useState(false);
  const [feishuAppForm, setFeishuAppForm] = useState({ appId: '', appSecret: '' });
  const [feishuAppSaving, setFeishuAppSaving] = useState(false);
  const loadFeishu = () => api.get('/sys/feishu').then((d: any) => {
    setFeishuCfg(d);
  }).catch(() => {});
  const startFeishuScan = () => {
    setFeishuBind(null);
    setFeishuBindStatus('pending');
    setFeishuSaving(true);
    api.post('/sys/feishu/oauth/start', { baseUrl: window.location.origin })
      .then((d: any) => {
        setFeishuBind(d);
        setFeishuBindStatus('pending');
      })
      .catch(() => setFeishuBindStatus('error'))
      .finally(() => setFeishuSaving(false));
  };
  const openFeishuBind = () => {
    setFeishuQr(true);
    if (feishuCfg?.appReady !== false) startFeishuScan();
  };
  const saveFeishuAppAndScan = () => {
    const appId = feishuAppForm.appId.trim();
    const appSecret = feishuAppForm.appSecret.trim();
    if (!appId || !appSecret) { message.warning('请填写飞书 App ID 和 App Secret'); return; }
    setFeishuAppSaving(true);
    api.put('/sys/feishu', { appId, appSecret, enabled: false })
      .then(() => {
        message.success('飞书应用凭据已保存');
        setFeishuAppForm({ appId: '', appSecret: '' });
        return loadFeishu();
      })
      .then(() => startFeishuScan())
      .finally(() => setFeishuAppSaving(false));
  };
  // 手动绑定应用机器人接收人（扫码走不通时的兜底：直接填 receive_id）
  const [feishuManual, setFeishuManual] = useState<any>(null);
  const [feishuManualSaving, setFeishuManualSaving] = useState(false);
  const FEISHU_ID_TYPES = [
    { value: 'open_id', label: 'open_id（推荐）' },
    { value: 'user_id', label: 'user_id' },
    { value: 'union_id', label: 'union_id' },
    { value: 'email', label: '邮箱' },
  ];
  const submitFeishuManual = () => {
    if (!feishuManual?.receiveId?.trim()) { message.warning('请填写飞书接收人 ID'); return; }
    setFeishuManualSaving(true);
    api.post('/sys/feishu/app-bot/bind', {
      receiveId: feishuManual.receiveId.trim(),
      receiveIdType: feishuManual.receiveIdType || 'open_id',
      receiverName: String(feishuManual.receiverName || '').trim(),
    }).then((r: any) => {
      message.success(`已绑定飞书接收人${r.receiverName ? `：${r.receiverName}` : ''}，并发送了确认卡片`);
      setFeishuManual(null);
      setFeishuQr(false);
      loadFeishu();
    }).catch(() => {}).finally(() => setFeishuManualSaving(false));
  };
  // 打开与应用机器人的飞书会话（后端 /sys/feishu/qr 返回 applink）
  const openFeishuBot = () => {
    api.get('/sys/feishu/qr').then((d: any) => {
      if (d?.applink) window.open(d.applink, '_blank');
      else message.warning('请先配置飞书 App ID / App Secret 后再打开机器人会话');
    }).catch(() => {});
  };
  const [backingUp, setBackingUp] = useState(false);

  const loadStatus = () => api.get('/sys/status').then(setStatus).catch(() => {});
  const loadUsers = () => api.get('/sys/users').then((d: any) => { setUsers(Array.isArray(d) ? d : (d.users || [])); if (d && !Array.isArray(d)) setSeat({ limit: d.seatLimit, used: d.seatUsed }); }).catch(() => {});
  const loadGaps = () => api.get('/sys/kb/gaps').then(setGaps).catch(() => {});
  const loadKbReadiness = () => api.get('/sys/kb/readiness').then(setKbReadiness).catch(() => {});
  const loadKb = (cat = kbCat) => api.get(`/sys/kb?category=${encodeURIComponent(cat)}`).then(setKbDocs).catch(() => {});
  const loadBackups = () => api.get('/sys/backups').then(setBackups).catch(() => {});
  const loadDeletions = (st = deletionStatus) => {
    if (!canRestoreDeleted) return;
    setDeletionLoading(true);
    api.get(`/sys/deletions?status=${encodeURIComponent(st)}`)
      .then((d: any[]) => setDeletions(d || []))
      .catch(() => {})
      .finally(() => setDeletionLoading(false));
  };
  useEffect(() => { loadFeishu(); }, []);
  useEffect(() => {
    if (!feishuQr || !feishuBind?.state || feishuBindStatus !== 'pending') return;
    const timer = window.setInterval(() => {
      api.get(`/sys/feishu/oauth/status?state=${encodeURIComponent(feishuBind.state)}`)
        .then((d: any) => {
          if (d.status === 'bound') {
            message.success(`飞书已绑定${d.receiverName ? `：${d.receiverName}` : ''}`);
            setFeishuQr(false);
            setFeishuBind(null);
            setFeishuBindStatus('idle');
            loadFeishu();
          } else if (d.status === 'expired' || d.status === 'error' || d.status === 'missing') {
            setFeishuBindStatus(d.status);
          }
        })
        .catch(() => {});
    }, 1800);
    return () => window.clearInterval(timer);
  }, [feishuQr, feishuBind?.state, feishuBindStatus]);
  const loadApprovals = (st = approvalStatus) =>
    api.get(`/sys/approvals?status=${encodeURIComponent(st)}`).then((l) => {
      setApprovals(l);
      if (st === '待审核') setPendingCount(l.length);
    }).catch(() => {});

  // 初始核心数据统一走 allSettled：任一成功则按可用数据渲染；全部失败给明确错误态 + 重试，不再静默吞错
  const [coreError, setCoreError] = useState('');
  const [coreLoading, setCoreLoading] = useState(false);
  const loadCore = () => {
    setCoreLoading(true);
    const calls: Promise<any>[] = [
      api.get('/sys/status').then(setStatus),
      api.get('/sys/kb/gaps').then(setGaps),
      api.get('/sys/kb/readiness').then(setKbReadiness),
      api.get('/sys/prompts').then(setPrompts),
      api.get('/sys/marshal-naming').then(setMarshalNaming),
      api.get('/sys/marshal-prompts/status').then(setMarshalPromptStatus),
      api.get('/sys/approvals?status=待审核').then((l: any[]) => setPendingCount(l.length)),
      ...(isAdminish ? [
        api.get('/sys/users').then((d: any) => { setUsers(Array.isArray(d) ? d : (d.users || [])); if (d && !Array.isArray(d)) setSeat({ limit: d.seatLimit, used: d.seatUsed }); }),
        api.get('/sys/logs').then(setLogs),
        api.get('/sys/login-logs').then(setLoginLogs),
        api.get('/sys/config').then(setCfg),
      ] : []),
      ...(canBackup ? [api.get('/sys/backups').then(setBackups)] : []),
    ];
    return Promise.allSettled(calls).then((results) => {
      const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      if (results.length && failed.length === results.length) {
        setCoreError(failed[0]?.reason?.message || '网络异常或服务暂不可用');
      } else {
        setCoreError('');
      }
    }).finally(() => setCoreLoading(false));
  };
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) loadCore(); });
    const timer = setInterval(loadStatus, 30000);   // 容错性轮询：单次失败静默，等下一轮
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [canBackup, isAdminish]);
  useEffect(() => {
    api.get(`/sys/approvals?status=${encodeURIComponent(approvalStatus)}`).then((l) => {
      setApprovals(l);
      if (approvalStatus === '待审核') setPendingCount(l.length);
    }).catch(() => {});
  }, [approvalStatus]);
  useEffect(() => {
    api.get(`/sys/kb?category=${encodeURIComponent(kbCat)}`).then(setKbDocs).catch(() => {});
  }, [kbCat]);
  useEffect(() => { loadKbCats(); }, []);
  useEffect(() => {
    if (!canRestoreDeleted) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setDeletionLoading(true);
      api.get(`/sys/deletions?status=${encodeURIComponent(deletionStatus)}`)
        .then((d: any[]) => setDeletions(d || []))
        .catch(() => {})
        .finally(() => setDeletionLoading(false));
    });
    return () => { cancelled = true; };
  }, [canRestoreDeleted, deletionStatus]);

  // ===== 审批操作 =====
  const decide = (row: any, pass: boolean, reason?: string) => {
    setDeciding(true);
    api.post(`/sys/approvals/${row.id}/decide`, { pass, reason })
      .then((r: any) => {
        message.success(r?.message || (pass ? '已通过审批' : '已驳回'));
        setRejectRow(null); setRejectReason('');
        loadApprovals();
      })
      .catch(() => {})   // 403（高风险需老板终审）等错误 client 已自动 message 提示
      .finally(() => setDeciding(false));
  };

  // ===== 知识库操作 =====
  const submitKb = () => {
    if (!kbForm?.title?.trim() || !kbForm?.body?.trim()) { message.warning('标题与内容必填'); return; }
    setKbSaving(true);
    const isEdit = !!kbForm.id;
    const targetCat = kbForm.category;
    const req = isEdit
      ? api.put(`/sys/kb/${kbForm.id}`, { title: kbForm.title.trim(), body: kbForm.body })
      : api.post('/sys/kb', { category: targetCat, title: kbForm.title.trim(), body: kbForm.body });
    req.then(() => {
      message.success(isEdit ? '文档已更新' : '文档已新增');
      setKbForm(null);
      if (!isEdit && targetCat !== kbCat) setKbCat(targetCat); else loadKb();
      loadGaps(); loadKbReadiness();
    }).catch(() => {}).finally(() => setKbSaving(false));
  };
  const toggleKb = (row: any, checked: boolean) => {
    api.put(`/sys/kb/${row.id}`, { enabled: checked }).then(() => {
      message.success(checked ? '已启用' : '已停用');
      loadKb(); loadGaps(); loadKbReadiness();
    }).catch(() => {});
  };
  const initializeKb = () => {
    setKbInitializing(true);
    api.post('/sys/kb/initialize', {}).then((r: any) => {
      message.success(r.message || '知识库初始化完成');
      loadKb(); loadGaps(); loadKbReadiness();
    }).finally(() => setKbInitializing(false));
  };

  const applyMarshalNaming = () => {
    setNamingApplying(true);
    api.post('/sys/marshal-naming/apply', {}).then((r: any) => {
      message.success(`已确认 ${r.applied?.length || 0} 个餐饮分部的新命名，仅本企业生效`);
      api.get('/sys/marshal-naming').then(setMarshalNaming);
    }).finally(() => setNamingApplying(false));
  };

  // ===== 提示词操作 =====
  const submitPrompt = () => {
    setPromptSaving(true);
    api.put(`/sys/prompts/${promptForm.id}`, {
      role_card: promptForm.role_card, output_rule: promptForm.output_rule, style: promptForm.style,
    }).then((r) => {
      message.success('提示词已更新');
      setPrompts((ps) => ps.map((p) => (p.id === r.id ? r : p)));
      setPromptForm(null);
    }).catch(() => {}).finally(() => setPromptSaving(false));
  };

  // ===== 用户操作 =====
  const submitUser = () => {
    if (userForm.id) {
      setUserSaving(true);
      api.put(`/sys/users/${userForm.id}`, {
        name: userForm.name, role: userForm.role, dept: userForm.dept,
        ...(userForm.password ? { password: userForm.password } : {}),
      }).then(() => { message.success('用户已更新'); setUserForm(null); loadUsers(); })
        .catch(() => {}).finally(() => setUserSaving(false));
    } else {
      if (!userForm?.username?.trim() || !userForm?.password || !userForm?.name?.trim()) {
        message.warning('用户名/密码/姓名必填'); return;
      }
      setUserSaving(true);
      api.post('/sys/users', {
        username: userForm.username.trim(), password: userForm.password, name: userForm.name.trim(),
        role: userForm.role, dept: userForm.dept, phone: userForm.phone,
      }).then(() => { message.success('用户已创建'); setUserForm(null); loadUsers(); })
        .catch(() => {}).finally(() => setUserSaving(false));
    }
  };
  const enableUser = (row: any) => {
    api.put(`/sys/users/${row.id}`, { status: '启用' })
      .then(() => { message.success(`已重新启用「${row.name}」`); loadUsers(); }).catch(() => {});
  };
  const disableUser = (row: any) => {
    api.del(`/sys/users/${row.id}`).then((result: any) => {
      const automationNote = result?.disabledAutomationRules
        ? `；同时停用 ${result.disabledAutomationRules} 条内容自动任务`
        : '';
      message.success(`已停用「${row.name}」，历史数据与归属均保留${automationNote}`);
      loadUsers();
    }).catch(() => {});
  };

  // ===== 配置与备份操作 =====
  const saveCfg = () => {
    setCfgSaving(true);
    const { risk_rules: _riskRules, ...payload } = cfg;   // 风控规则只读展示，不随保存提交
    api.put('/sys/config', payload)
      .then(() => message.success('配置已保存'))
      .catch(() => {}).finally(() => setCfgSaving(false));
  };
  const doBackup = () => {
    setBackingUp(true);
    api.post('/sys/backup')
      .then((r) => { message.success(`备份成功：${r.file}`); loadBackups(); })
      .catch(() => {}).finally(() => setBackingUp(false));
  };
  const openDeletion = (row: any) => {
    api.get(`/sys/deletions/${row.id}`).then(setDeletionView).catch(() => {});
  };
  const restoreDeletion = (row: any) => {
    api.post(`/sys/deletions/${row.id}/restore`).then((r: any) => {
      message.success(r?.message || '已恢复到原业务表');
      setDeletionView(null);
      loadDeletions();
      loadStatus();
      loadKb();
      loadGaps();
    }).catch(() => {});
  };

  // ===== 快捷入口（对照UI稿：图标按钮格） =====
  const QUICK: { label: string; icon: React.ReactNode; color: string; tab: string; badge?: number }[] = [
    { label: '数据录入中枢', icon: <InboxOutlined />, color: '#715b7b', tab: 'data-intake' },
    { label: '用户管理', icon: <TeamOutlined />, color: 'var(--ui-accent)', tab: 'users' },
    { label: '审批中心', icon: <AuditOutlined />, color: '#f25b6b', tab: 'approvals', badge: pendingCount },
    { label: '知识库', icon: <BookOutlined />, color: '#22c4a8', tab: 'kb' },
    { label: '提示词模板', icon: <FileTextOutlined />, color: '#8a7450', tab: 'prompts' },
    { label: '风控规则', icon: <SafetyCertificateOutlined />, color: '#f6a02d', tab: 'config' },
    { label: '操作日志', icon: <HistoryOutlined />, color: '#70757a', tab: 'users' },
    { label: '登录日志', icon: <LoginOutlined />, color: 'var(--ui-accent)', tab: 'users' },
    { label: '删除留痕', icon: <DeleteOutlined />, color: '#f25b6b', tab: 'trash' },
    { label: '数据备份', icon: <CloudServerOutlined />, color: '#22c4a8', tab: 'config' },
    { label: '系统配置', icon: <SettingOutlined />, color: '#8a7450', tab: 'config' },
  ];

  const ai = status.ai || {};
  const usage = ai.usage || {};
  const healthTagColor = status.healthStatus === 'danger' ? 'red' : status.healthStatus === 'warning' ? 'orange' : 'green';
  const noPermTip = <Panel><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前角色无权查看该模块（需老板/运营总监/管理员）" /></Panel>;

  // ===== ① 系统概览 Tab =====
  const overviewTab = (
    <Row gutter={[12, 12]}>
      <Col xs={24} lg={7}>
        <Panel title={<><DatabaseOutlined style={{ color: 'var(--ui-accent)' }} /> 系统概览</>} extra={<span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>30秒自动刷新</span>}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <MiniStat icon={<TeamOutlined />} color="var(--ui-accent)" label="用户数" value={(status.users ?? 0).toLocaleString()} />
            <MiniStat icon={<DesktopOutlined />} color="#22c4a8" label="在线用户" value={(status.online ?? 0).toLocaleString()} />
            <MiniStat icon={<UserOutlined />} color="#8a7450" label="客户数据量" value={(status.leads ?? 0).toLocaleString()} />
            <MiniStat icon={<FileTextOutlined />} color="#f6a02d" label="内容数据量" value={(status.contents ?? 0).toLocaleString()} />
            <MiniStat icon={<HddOutlined />} color="#70757a" label="数据库大小" value={`${(status.dbSizeKB ?? 0).toLocaleString()} KB`} span />
          </div>
        </Panel>
      </Col>
      <Col xs={24} lg={6}>
        <Panel title={<><ThunderboltOutlined style={{ color: '#f6a02d' }} /> 系统状态</>}
          extra={<Tooltip title={status.healthReason || '核心资源处于安全区间'}><Tag color={healthTagColor} style={{ marginRight: 0 }}>{status.healthLabel || '运行正常'}</Tag></Tooltip>}>
          {[['CPU使用率', status.cpu ?? 0], ['内存使用率', status.memory ?? 0]].map(([label, p]: any) => (
            <div key={label} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>
                <span>{label}</span><span style={{ fontWeight: 600, color: 'var(--ui-text)' }}>{p}%</span>
              </div>
              <Progress percent={p} showInfo={false} size="small" strokeColor={barColor(p)} />
            </div>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14 }}>
            <div style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 11.5, color: 'var(--ui-muted)' }}><HddOutlined /> 堆内存</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ui-text)' }}>{status.heapMB ?? 0} <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--ui-muted)' }}>MB</span></div>
            </div>
            <div style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 11.5, color: 'var(--ui-muted)' }}><FieldTimeOutlined /> 运行时长</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ui-text)' }}>{fmtUptime(status.uptimeMin)}</div>
            </div>
          </div>
        </Panel>
      </Col>
      <Col xs={24} lg={6}>
        <Panel title={<><RobotOutlined style={{ color: 'var(--ui-accent)' }} /> AI服务状态</>}
          extra={<Badge status={ai.available ? 'success' : 'warning'} text={<span style={{ fontSize: 12, color: ai.available ? '#16a34a' : '#e0a253' }}>{ai.available ? '已连接' : '降级模式'}</span>} />}>
          <div style={{ background: ai.available ? '#112018' : 'var(--ui-warning-surface)', borderRadius: 8, padding: '10px 12px', fontSize: 12.5, fontWeight: 600, color: ai.available ? '#16a34a' : '#e0a253', marginBottom: 10 }}>
            {ai.available ? 'AI服务已连接' : '模板模式（未配置AI密钥）'}
          </div>
          {ai.canViewDetail ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 10 }}>
                <span>当前模型</span><Tag color="blue" style={{ marginRight: 0 }}>{ai.model || '-'}</Tag>
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ui-text)', marginBottom: 6 }}>今日Token用量</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
                {[['输入', usage.input], ['输出', usage.output], ['调用次数', usage.calls]].map(([label, v]: any) => (
                  <div key={label} style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ui-accent)' }}>{(v ?? 0).toLocaleString()}</div>
                    <div style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{label}</div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <Alert type="info" showIcon message="当前角色仅显示AI服务连接状态；模型与Token明细仅老板/管理员可见。" />
          )}
        </Panel>
      </Col>
      <Col xs={24} lg={5}>
        <Panel title={<><SafetyCertificateOutlined style={{ color: '#22c4a8' }} /> 安全概览</>}>
          <div style={{ textAlign: 'center', marginBottom: 12 }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--ui-surface-2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <SafetyCertificateOutlined style={{ fontSize: 28, color: 'var(--ui-accent)' }} />
            </div>
            <div style={{ fontSize: 12, color: '#16a34a', fontWeight: 600, marginTop: 6 }}>安全策略全部生效</div>
          </div>
          {[['密码加密存储', '已加密'], ['操作全审计', '已开启'], ['手机号脱敏', '已启用'], ['外发人工确认', '已启用']].map(([label, tag]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--ui-surface-2)' }}>
              <span style={{ fontSize: 12.5, color: 'var(--ui-text-2)' }}><CheckCircleFilled style={{ color: '#22c4a8', marginRight: 6 }} />{label}</span>
              <Tag color="green" style={{ marginRight: 0, fontSize: 11 }}>{tag}</Tag>
            </div>
          ))}
        </Panel>
      </Col>
    </Row>
  );

  // ===== ② 审批中心 Tab =====
  const approvalCols: any[] = [
    {
      title: '标题', dataIndex: 'title',
      render: (v: string, r: any) => (
        <Tooltip title={r.summary}>
          <span style={{ fontWeight: 600, color: 'var(--ui-text)' }}>{v}</span>
          {r.target_type === 'activity_plan' && <Tag color="blue" style={{ marginLeft: 8 }}>活动策划</Tag>}
          {r.target_type === 'activity_checklist' && <Tag color="purple" style={{ marginLeft: 8 }}>待确认事项</Tag>}
          {['activity_plan', 'activity_checklist'].includes(r.target_type) && <a style={{ marginLeft: 8, fontSize: 12 }} onClick={() => setApprovalView(r)}>查看详情</a>}
        </Tooltip>
      ),
    },
    {
      title: '流程节点', dataIndex: 'approval_level', width: 104,
      render: (v: string) => <Tag color={v === 'boss' ? 'gold' : 'blue'}>{v === 'boss' ? '老板终审' : v === 'ops_director' ? '总监初审' : '-'}</Tag>,
    },
    {
      title: '风险等级', dataIndex: 'risk_level', width: 90,
      render: (v: string) => <Tag color={RISK_TAG[v]?.color || 'default'}>{RISK_TAG[v]?.label || v || '-'}</Tag>,
    },
    {
      title: '命中规则', dataIndex: 'rules_hit',
      render: (v: string) => {
        const rules = parseRules(v);
        return rules.length ? rules.map((r) => <Tag key={r} color="volcano" style={{ fontSize: 11 }}>{r}</Tag>) : <span style={{ color: 'var(--ui-muted)' }}>-</span>;
      },
    },
    { title: '提交人', dataIndex: 'submitter', width: 80, render: (v: string) => v || '-' },
    { title: '提交时间', dataIndex: 'created_at', width: 150, render: (v: string) => <span style={{ color: 'var(--ui-muted)', fontSize: 12 }}>{v}</span> },
    ...(approvalStatus === '待审核' ? [{
      title: '操作', key: 'op', width: 156,
      render: (_: any, r: any) => {
        const bossOnly = r.risk_level === 'high' || r.approval_level === 'boss';
        const rowCanDecide = canDecide && (!bossOnly || user.role === 'boss');
        const blockedReason = !canDecide
          ? '需老板、运营总监或企业管理员审批'
          : bossOnly && user.role !== 'boss'
            ? '该事项需老板终审'
            : '';
        return (
          <Space size={6}>
            <Popconfirm title="确认通过该内容？" onConfirm={() => decide(r, true)} okText="通过" cancelText="取消" disabled={!rowCanDecide}>
              <Tooltip title={blockedReason}>
                <Button type="primary" size="small" icon={<CheckOutlined />} disabled={!rowCanDecide} loading={deciding}>通过</Button>
              </Tooltip>
            </Popconfirm>
            <Tooltip title={blockedReason}>
              <Button danger size="small" icon={<CloseOutlined />} disabled={!rowCanDecide}
                onClick={() => { setRejectRow(r); setRejectReason(''); }}>驳回</Button>
            </Tooltip>
          </Space>
        );
      },
    }] : [
      { title: '审核人', dataIndex: 'reviewer', width: 80, render: (v: string) => v || '-' },
      { title: '处理时间', dataIndex: 'decided_at', width: 150, render: (v: string) => <span style={{ color: 'var(--ui-muted)', fontSize: 12 }}>{v || '-'}</span> },
      ...(approvalStatus === '已驳回' ? [{ title: '驳回理由', dataIndex: 'reason', ellipsis: true, render: (v: string) => <Tooltip title={v}><span style={{ color: '#f25b6b', fontSize: 12 }}>{v || '-'}</span></Tooltip> }] : []),
    ]),
  ];
  const approvalsTab = (
    <Panel title={<><AuditOutlined style={{ color: '#f25b6b' }} /> 审批中心</>}
      extra={<span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>高风险事项需老板终审 · 驳回必须填写理由</span>}>
      <Tabs size="small" activeKey={approvalStatus} onChange={setApprovalStatus}
        items={['待审核', '已通过', '已驳回'].map((s) => ({
          key: s,
          label: s === '待审核' && pendingCount > 0 ? <Badge size="small" count={pendingCount} offset={[8, -2]}>待审核</Badge> : s,
        }))} />
      <Table size="small" rowKey="id" dataSource={approvals} columns={approvalCols}
        pagination={{ pageSize: 10, hideOnSinglePage: true, size: 'small' }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`暂无${approvalStatus}事项`} /> }} />
      <Drawer title={approvalView?.title || '活动策划方案'} width={620} open={!!approvalView} onClose={() => setApprovalView(null)}>
        {(() => {
          const payload = parseJson(approvalView?.payload, {});
          if (approvalView?.target_type === 'activity_checklist') {
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <Alert type="info" showIcon message={`${approvalView?.approval_level === 'boss' ? '老板终审' : '运营总监初审'}：通过后按流程流转，老板终审通过才会自动标记完成并同步管理层。`} />
                <div style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: 12 }}>
                  <div style={{ fontWeight: 700, color: 'var(--ui-text)' }}>{payload.item || approvalView?.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--ui-muted)', marginTop: 4 }}>{approvalView?.summary}</div>
                </div>
                <Table size="small" pagination={false} dataSource={[
                  { k: '活动ID', v: payload.activityId || approvalView?.target_id || '-' },
                  { k: '事项序号', v: Number.isInteger(payload.checklistIndex) ? payload.checklistIndex + 1 : '-' },
                  { k: '提交人', v: payload.submittedBy?.name || approvalView?.submitter || '-' },
                  { k: '流程节点', v: approvalView?.approval_level === 'boss' ? '老板终审' : '运营总监初审' },
                ]} columns={[
                  { title: '字段', dataIndex: 'k', width: 120 },
                  { title: '内容', dataIndex: 'v' },
                ]} rowKey="k" />
              </div>
            );
          }
          const plan = payload.plan || {};
          const flowRows = displayList(plan.flow).map((row: any) => {
            if (row && typeof row === 'object' && !Array.isArray(row)) {
              return { time: displayValue(row.time), item: displayValue(row.item ?? row.content ?? row) };
            }
            return { time: '', item: displayValue(row) };
          });
          const kpiEntries = plan.kpi && typeof plan.kpi === 'object' && !Array.isArray(plan.kpi)
            ? Object.entries(plan.kpi)
            : plan.kpi ? [['指标', plan.kpi]] : [];
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Alert type="info" showIcon message={`${approvalView?.approval_level === 'boss' ? '老板终审' : '运营总监初审'}：通过后按流程流转，老板终审通过才会同步飞书日历。`} />
              <div style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: 12 }}>
                <div style={{ fontWeight: 700, color: 'var(--ui-text)' }}>{displayValue(plan.theme) || approvalView?.title}</div>
                <div style={{ fontSize: 12, color: 'var(--ui-muted)', marginTop: 4 }}>{approvalView?.summary}</div>
              </div>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>活动流程</div>
                <Table size="small" rowKey={(_, i) => String(i)} pagination={false} dataSource={flowRows}
                  columns={[{ title: '时间', dataIndex: 'time', width: 120 }, { title: '环节', dataIndex: 'item' }]} />
              </div>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>物料清单</div>
                {displayList(plan.materials).length ? displayList(plan.materials).map((m: any, i: number) => <Tag key={i} color="geekblue">{displayValue(m)}</Tag>) : <span style={{ color: 'var(--ui-muted)' }}>暂无</span>}
              </div>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>邀约SOP</div>
                {displayList(plan.sop).length ? displayList(plan.sop).map((s: any, i: number) => <div key={i} style={{ fontSize: 12.5, lineHeight: 1.8 }}>{i + 1}. {displayValue(s)}</div>) : <span style={{ color: 'var(--ui-muted)' }}>暂无</span>}
              </div>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>KPI / 预算</div>
                <Space wrap>
                  {kpiEntries.map(([k, v]: any) => <Tag key={k} color="blue">{k}: {displayValue(v)}</Tag>)}
                  {plan.budgetNote && <Tag color="orange">{displayValue(plan.budgetNote)}</Tag>}
                </Space>
              </div>
            </div>
          );
        })()}
      </Drawer>
    </Panel>
  );

  // ===== ③ 知识库 Tab =====
  const kbTab = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Panel title={<><DatabaseOutlined style={{ color: 'var(--ui-accent)' }} /> 知识库启用向导</>}
        extra={canEditKb && <Button type="primary" size="small" icon={<ThunderboltOutlined />} loading={kbInitializing} onClick={initializeKb}>
          {kbReadiness.initialized ? '补齐初始化资料' : '一键初始化知识库'}
        </Button>}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px,260px) 1fr', gap: 18, alignItems: 'center' }}>
          <div>
            <Progress type="dashboard" percent={kbReadiness.percent || 0} size={112} strokeColor="#22c4a8" />
            <div style={{ fontSize: 12, color: 'var(--ui-muted)', marginTop: 4 }}>已就绪 {kbReadiness.ready || 0}/{kbReadiness.total || 7} 个知识域</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 8 }}>
            {(kbReadiness.categories || []).map((item: any) => (
              <div key={item.category} onClick={() => setKbCat(item.category)} style={{ cursor: 'pointer', border: '1px solid var(--ui-border)', borderRadius: 8, padding: '8px 10px', background: 'var(--ui-surface-2)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}><b style={{ fontSize: 12.5 }}>{item.category}</b>{item.ready ? <CheckCircleFilled style={{ color: '#22c4a8' }} /> : <AlertOutlined style={{ color: '#f6a02d' }} />}</div>
                <div style={{ fontSize: 11, color: 'var(--ui-muted)', marginTop: 3 }}>{item.enabled || 0} 条可调用 · {item.hint}</div>
              </div>
            ))}
          </div>
        </div>
        <Alert type="info" showIcon style={{ marginTop: 12 }}
          message="初始化只补齐基础口径，不会覆盖企业已经上传的资料"
          description="初始化后继续录入品牌故事、产品政策、客户画像和真实案例；资料越完整，战略中枢与餐饮数字员工的回答越贴合企业。" />
      </Panel>
      {gaps.length > 0 && (
        <Alert type="warning" showIcon message="知识库资料缺口提示"
          description={gaps.map((g: any) => <div key={g.category} style={{ fontSize: 12.5 }}>· {g.hint}</div>)} />
      )}
      <Panel title={<><BookOutlined style={{ color: '#22c4a8' }} /> 知识库</>}
        extra={canEditKb && <Space size={8}>
          <Button type="primary" size="small" icon={<UploadOutlined />} loading={kbUploading}
            onClick={() => document.getElementById('kb-file-input')?.click()}>上传文件（文档/图片）</Button>
          <Button size="small" icon={<PlusOutlined />}
            onClick={() => setKbForm({ category: kbCat, title: '', body: '' })}>手动录入</Button>
          <input id="kb-file-input" type="file" accept={KB_ACCEPT} style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadKbFile(f); (e.target as HTMLInputElement).value = ''; }} />
        </Space>}>
        <Tabs size="small" activeKey={kbCat} onChange={setKbCat}
          tabBarExtraContent={canEditKb && <a style={{ fontSize: 12 }} onClick={addKbCat}>＋ 分类</a>}
          items={kbCats.map((c) => ({ key: c, label: c === '员工产出' ? '员工产出（自动沉淀）' : c }))} />
        {kbCat === '员工产出' && <Alert type="info" showIcon style={{ marginBottom: 10 }}
          message="知识资产闭环：员工产出被「采纳」后自动沉淀到本库，AI 后续回答可随时抽取调度；同时已登记为知识资产。" />}
        {canEditKb && <Alert type="success" showIcon style={{ marginBottom: 10 }}
          message={<span>支持上传 <b>Word/Excel/PDF/TXT/MD/CSV</b>（自动提取正文入库）与 <b>图片</b>（AI识图自动转写为知识要点，按角色模型计费）；附件可随时预览下载，提取内容可再编辑。<br/><b style={{ color: '#16a34a' }}>🔍 已启用 AI 向量语义检索（RAG）</b>：上传/录入的文档自动向量化，8个餐饮分部与老板参谋按「语义相关性」精准召回最相关内容，而非简单关键词匹配——知识库越大越准。</span>} />}
        <Table size="small" rowKey="id" dataSource={kbDocs}
          pagination={{ pageSize: 10, hideOnSinglePage: true, size: 'small' }}
          columns={[
            {
              title: '标题', dataIndex: 'title',
              render: (v: string, r: any) => <a onClick={() => setKbView(r)} style={{ fontWeight: 600, color: r.enabled ? 'var(--ui-text)' : 'var(--ui-muted)' }}>{v}</a>,
            },
            {
              title: '附件', dataIndex: 'file_type', width: 84,
              render: (t: string, r: any) => !r.file_path ? <span style={{ color: 'var(--ui-muted)' }}>—</span> : (
                <a href={r.file_path} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                  {['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(t) ? '🖼️' : t === 'pdf' ? '📕' : ['xlsx', 'xls', 'csv'].includes(t) ? '📊' : '📄'} {t}
                </a>
              ),
            },
            { title: '引用次数', dataIndex: 'ref_count', align: 'right', width: 90, render: (v: number) => <span style={{ color: 'var(--ui-accent)', fontWeight: 600 }}>{v ?? 0}</span> },
            { title: '更新时间', dataIndex: 'updated_at', width: 150, render: (v: string) => <span style={{ color: 'var(--ui-muted)', fontSize: 12 }}>{v}</span> },
            {
              title: '启用', dataIndex: 'enabled', width: 70,
              render: (v: number, r: any) => <Switch size="small" checked={!!v} disabled={!canEditKb} onChange={(c) => toggleKb(r, c)} />,
            },
            {
              title: '权限', key: 'perm', width: 88,
              render: (_: any, r: any) => {
                const v = parseJsonArray(r.visible_roles).length;
                const c = parseJsonArray(r.callable_roles).length;
                return <a onClick={() => canEditKb && openKbPerm(r)} style={{ fontSize: 12 }}>
                  {(!v && !c) ? <Tag style={{ margin: 0, fontSize: 10.5 }}>全员</Tag> : <Tag color="orange" style={{ margin: 0, fontSize: 10.5 }}>🔒 受限</Tag>}
                </a>;
              },
            },
            {
              title: '操作', key: 'op', width: 142,
              render: (_: any, r: any) => (
                <Space size={4}>
                  <Button size="small" type="link" icon={<EditOutlined />} disabled={!canEditKb}
                    onClick={() => setKbForm({ id: r.id, category: r.category, title: r.title, body: r.body })}>编辑</Button>
                  <Popconfirm title={`删除「${r.title}」？`} description="删除后进入回收站，老板/管理员可恢复。" okText="删除" cancelText="取消"
                    okButtonProps={{ danger: true }} disabled={!canEditKb}
                    onConfirm={() => api.del(`/sys/kb/${r.id}`).then(() => { message.success('已删除并进入回收站'); loadKb(); loadGaps(); })}>
                    <Button size="small" type="link" danger icon={<DeleteOutlined />} disabled={!canEditKb}>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`「${kbCat}」暂无文档，上传资料可解锁AI精准模式`} /> }} />
      </Panel>
    </div>
  );

  // ===== ④ 提示词模板 Tab =====
  const marshalPromptReadyCount = marshalPromptStatus.filter(x => x.ready).length;
  const marshalPromptTotalCount = marshalPromptStatus.length;
  const marshalPromptsReady = marshalPromptTotalCount > 0 && marshalPromptReadyCount === marshalPromptTotalCount;
  const promptsTab = (
    <Row gutter={[12, 12]}>
      <Col span={24}>
        <Panel title={<><RobotOutlined style={{ color: 'var(--ui-primary)' }} /> 餐饮数字员工提示词与命名确认</>}
          extra={canEditPrompt && <Button size="small" type="primary" loading={namingApplying} onClick={applyMarshalNaming}>确认采用建议命名</Button>}>
          <Alert type={marshalPromptsReady ? 'success' : 'warning'} showIcon style={{ marginBottom: 10 }}
            message={marshalPromptTotalCount
              ? `商业版餐饮分部提示词：${marshalPromptReadyCount}/${marshalPromptTotalCount}${marshalPromptsReady ? ' 已完整载入' : ' 已载入'}`
              : '商业版餐饮分部提示词：等待接口状态'}
            description="提示词基线来自餐饮数字员工商业提示词库，每个餐饮分部均包含角色、方法论、五段式输出、红线和自检；企业自定义覆盖不会被初始化覆盖。" />
          <Table size="small" rowKey="code" pagination={false} dataSource={marshalNaming}
            columns={[
              { title: '编号', dataIndex: 'code', width: 70, render: (v: string) => <Tag>{v}</Tag> },
              { title: '当前名称', dataIndex: 'current', width: 150 },
              { title: '建议名称', dataIndex: 'recommended', width: 150, render: (v: string, r: any) => <b style={{ color: r.changed ? '#22c4a8' : 'var(--ui-text)' }}>{v}</b> },
              { title: '调整依据', dataIndex: 'reason' },
              { title: '状态', dataIndex: 'changed', width: 80, render: (v: boolean) => <Tag color={v ? 'green' : 'orange'}>{v ? '已采用' : '待确认'}</Tag> },
            ]} />
        </Panel>
      </Col>
      <Col span={24}>
        <Alert type="success" showIcon
          message="提示词中枢：此处升级 = 全员即时生效"
          description={<span style={{ fontSize: 12.5 }}>
            AI文案、AI图片（GEN-IMG）、AI视频（GEN-VIDEO）、AIPPT（GEN-PPT）、老板参谋风格（ADVISOR-STYLE）等全局提示词已统一收口到本页——老板/管理员编辑保存后，所有人的下一次生成立即使用最新内容，并保留内部审计记录。
            餐饮数字员工的专属提示词在 <a onClick={() => window.open('/admin', '_blank')}>管理后台 → 员工管理</a> 编辑并点「同步」生效。<b style={{ color: '#16a34a' }}>所有修改仅对本企业生效</b>，每家企业可定制自己的餐饮分部话术与 AI 风格（千客千面）。
          </span>} />
      </Col>
      {prompts.length === 0 && <Col span={24}><Panel><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无提示词模板" /></Panel></Col>}
      {prompts.map((p) => (
        <Col xs={24} lg={12} key={p.id}>
          <Panel
            title={<><Tag color="blue" style={{ fontFamily: 'Consolas,Menlo,monospace', fontSize: 11 }}>{p.code}</Tag>{p.name}</>}
            extra={<Space size={8}>
              {canEditPrompt && <Button size="small" icon={<EditOutlined />} onClick={() => setPromptForm({ ...p })}>编辑</Button>}
            </Space>}>
            {[['角色卡', p.role_card], ['输出规则', p.output_rule], ['风格要求', p.style]].map(([label, text]) => (
              <div key={label as string} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ui-text-2)', marginBottom: 4 }}>{label}</div>
                <div style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '8px 10px', fontSize: 12, color: 'var(--ui-text-2)', lineHeight: 1.7, whiteSpace: 'pre-wrap', maxHeight: 88, overflow: 'auto' }}>
                  {text || <span style={{ color: 'var(--ui-muted)' }}>（未设置）</span>}
                </div>
              </div>
            ))}
          </Panel>
        </Col>
      ))}
    </Row>
  );

  // ===== ⑤ 用户与日志 Tab =====
  const usersTab = !isAdminish ? noPermTip : (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Panel title={<><TeamOutlined style={{ color: 'var(--ui-accent)' }} /> 企业账号管理 <span style={{ fontSize: 12, fontWeight: 400, color: seat.used >= seat.limit ? '#f25b6b' : 'var(--ui-muted)' }}>（席位 {seat.used}/{seat.limit}）</span></>}
        extra={canManageUsers && <Button type="primary" size="small" icon={<PlusOutlined />} disabled={seat.limit > 0 && seat.used >= seat.limit}
          onClick={() => setUserForm({ username: '', password: '', name: '', role: 'sales', dept: '', phone: '' })}>{seat.limit > 0 && seat.used >= seat.limit ? '席位已满' : '新增账号'}</Button>}>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 10 }}
          message="停用账号只关闭登录和其仍启用的内容自动任务；用户ID、历史内容、任务、审批与运行记录不会删除。停用后可在本页重新启用。"
        />
        <Table size="small" rowKey="id" dataSource={users}
          pagination={{ pageSize: 10, hideOnSinglePage: true, size: 'small' }}
          columns={[
            { title: '用户名', dataIndex: 'username', render: (v: string) => <span style={{ fontFamily: 'Consolas,Menlo,monospace', fontSize: 12 }}>{v}</span> },
            { title: '姓名', dataIndex: 'name', render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span> },
            { title: '角色', dataIndex: 'role', width: 100, render: (v: string) => <Tag color={ROLE_MAP[v]?.color || 'default'}>{ROLE_MAP[v]?.label || v}</Tag> },
            { title: '部门', dataIndex: 'dept', render: (v: string) => v || '-' },
            { title: '状态', dataIndex: 'status', width: 72, render: (v: string) => <Tag color={v === '启用' ? 'green' : 'red'}>{v}</Tag> },
            { title: '最后登录', dataIndex: 'last_login_at', width: 150, render: (v: string) => <span style={{ color: 'var(--ui-muted)', fontSize: 12 }}>{v || '从未登录'}</span> },
            {
              title: '操作', key: 'op', width: 190,
              render: (_: any, r: any) => (
                <Space size={4}>
                  <Button size="small" type="link" icon={<EditOutlined />} disabled={!canManageUsers}
                    onClick={() => setUserForm({ id: r.id, username: r.username, name: r.name, role: r.role, dept: r.dept || '', password: '' })}>编辑</Button>
                  {r.status === '启用' ? (
                    <Popconfirm
                      title={`停用「${r.name}」账号？`}
                      description="该账号将不能登录；历史数据与归属不会删除，其仍启用的内容自动任务将同步停用。"
                      onConfirm={() => disableUser(r)}
                      okText="停用账号"
                      cancelText="取消"
                      disabled={!canManageUsers}
                    >
                      <Button size="small" type="link" danger disabled={!canManageUsers}>停用账号</Button>
                    </Popconfirm>
                  ) : (
                    <Popconfirm
                      title={`重新启用「${r.name}」？`}
                      description="恢复后该账号可重新登录；此前停用的自动任务不会自动恢复。"
                      onConfirm={() => enableUser(r)}
                      okText="重新启用"
                      cancelText="取消"
                      disabled={!canManageUsers}
                    >
                      <Button size="small" type="link" disabled={!canManageUsers}>重新启用</Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]} />
      </Panel>
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={14}>
          <Panel title={<><HistoryOutlined style={{ color: '#70757a' }} /> 操作日志</>} extra={<span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>最近50条</span>}>
            <Table size="small" rowKey="id" dataSource={logs}
              pagination={{ pageSize: 10, hideOnSinglePage: true, size: 'small' }}
              columns={[
                { title: '时间', dataIndex: 'created_at', width: 150, render: (v: string) => <span style={{ color: 'var(--ui-muted)', fontSize: 12 }}>{v}</span> },
                { title: '用户', dataIndex: 'username', width: 80 },
                { title: '模块', dataIndex: 'module', width: 96, render: (v: string) => <Tag style={{ fontSize: 11 }}>{v}</Tag> },
                { title: '动作', dataIndex: 'action', width: 100 },
                { title: '对象', dataIndex: 'target', ellipsis: true, render: (v: string) => <Tooltip title={v}>{v || '-'}</Tooltip> },
                { title: 'IP', dataIndex: 'ip', width: 112, render: (v: string) => <span style={{ fontFamily: 'Consolas,Menlo,monospace', fontSize: 11.5, color: 'var(--ui-muted)' }}>{v || '-'}</span> },
              ]} />
          </Panel>
        </Col>
        <Col xs={24} lg={10}>
          <Panel title={<><LoginOutlined style={{ color: 'var(--ui-accent)' }} /> 登录日志</>} extra={<span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>最近50条</span>}>
            <Table size="small" rowKey="id" dataSource={loginLogs}
              pagination={{ pageSize: 10, hideOnSinglePage: true, size: 'small' }}
              columns={[
                { title: '时间', dataIndex: 'created_at', width: 150, render: (v: string) => <span style={{ color: 'var(--ui-muted)', fontSize: 12 }}>{v}</span> },
                { title: '用户名', dataIndex: 'username' },
                { title: '结果', dataIndex: 'success', width: 70, render: (v: number) => <Tag color={v ? 'green' : 'red'}>{v ? '成功' : '失败'}</Tag> },
                { title: 'IP', dataIndex: 'ip', width: 112, render: (v: string) => <span style={{ fontFamily: 'Consolas,Menlo,monospace', fontSize: 11.5, color: 'var(--ui-muted)' }}>{v || '-'}</span> },
              ]} />
          </Panel>
        </Col>
      </Row>
    </div>
  );

  // ===== ⑥ 删除留痕 / 回收站 Tab =====
  const trashTab = !canRestoreDeleted ? noPermTip : (
    <Panel title={<><DeleteOutlined style={{ color: '#f25b6b' }} /> 删除留痕</>}
      extra={<Space size={8}>
        <Select size="small" value={deletionStatus} style={{ width: 110 }}
          options={[{ value: 'active', label: '未恢复' }, { value: 'restored', label: '已恢复' }, { value: '', label: '全部' }]}
          onChange={setDeletionStatus} />
        <Button size="small" onClick={() => loadDeletions()} loading={deletionLoading}>刷新</Button>
      </Space>}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="所有业务删除都会进入这里：保留删除人、角色、原因、原始数据快照和关联数据快照；仅老板/管理员可查看与恢复。" />
      <Table size="small" rowKey="id" loading={deletionLoading} dataSource={deletions}
        pagination={{ pageSize: 10, size: 'small', hideOnSinglePage: true }}
        columns={[
          {
            title: '删除对象', dataIndex: 'title',
            render: (v: string, r: any) => (
              <div>
                <a onClick={() => openDeletion(r)} style={{ fontWeight: 600 }}>{v || `${r.entity_type}#${r.entity_id}`}</a>
                <div style={{ fontSize: 11, color: 'var(--ui-muted)', marginTop: 2 }}>{r.summary || '-'}</div>
              </div>
            ),
          },
          { title: '模块', dataIndex: 'module', width: 100, render: (v: string) => <Tag style={{ fontSize: 11 }}>{v || '-'}</Tag> },
          {
            title: '删除人', width: 122,
            render: (_: any, r: any) => <span>{r.deleted_by_name || '-'} <Tag color={ROLE_MAP[r.deleted_by_role]?.color || 'default'} style={{ marginLeft: 4, fontSize: 10 }}>{ROLE_MAP[r.deleted_by_role]?.label || r.deleted_by_role || '-'}</Tag></span>,
          },
          { title: '删除原因', dataIndex: 'reason', ellipsis: true, render: (v: string) => <Tooltip title={v}><span style={{ color: 'var(--ui-text-2)' }}>{v || '-'}</span></Tooltip> },
          { title: '删除时间', dataIndex: 'created_at', width: 150, render: (v: string) => <span style={{ color: 'var(--ui-muted)', fontSize: 12 }}>{v}</span> },
          {
            title: '状态', width: 112,
            render: (_: any, r: any) => r.restored_at
              ? <Tag color="green">已恢复</Tag>
              : <Tag color="volcano">回收站</Tag>,
          },
          {
            title: '操作', width: 160,
            render: (_: any, r: any) => (
              <Space size={4}>
                <Button size="small" icon={<EyeOutlined />} onClick={() => openDeletion(r)}>详情</Button>
                <Popconfirm title="确认恢复这条数据？" description="会按原始快照恢复主数据和关联数据。" okText="恢复" cancelText="取消"
                  disabled={!!r.restored_at}
                  onConfirm={() => restoreDeletion(r)}>
                  <Button size="small" type="primary" ghost icon={<UndoOutlined />} disabled={!!r.restored_at}>恢复</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={deletionStatus === 'active' ? '暂无未恢复删除记录' : '暂无删除记录'} /> }} />
    </Panel>
  );

  // ===== ⑥ 配置与备份 Tab =====
  const numField = (label: string, value: any, onChange: (v: any) => void, opts: any = {}) => (
    <div key={label}>
      <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>{label}</div>
      <InputNumber size="small" style={{ width: '100%' }} value={value} disabled={!canSaveConfig}
        min={0} onChange={(v) => onChange(v ?? 0)} {...opts} />
    </div>
  );
  const cfgGroup = (title: string, body: React.ReactNode) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ui-text)', marginBottom: 8, paddingLeft: 8, borderLeft: '3px solid var(--ui-accent)' }}>{title}</div>
      {body}
    </div>
  );
  const grid = (children: React.ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 10 }}>{children}</div>
  );
  const setCfgSub = (key: string, sub: string, v: any) => setCfg((c: any) => ({ ...c, [key]: { ...(c[key] || {}), [sub]: v } }));
  const weightSum = Object.values(cfg.health_weights || {}).reduce((s: number, v: any) => s + Number(v || 0), 0);

  const configTab = !isAdminish ? noPermTip : (
    <Row gutter={[12, 12]}>
      <Col xs={24} lg={14}>
        <Panel title={<><SettingOutlined style={{ color: '#8a7450' }} /> 业务系数配置</>}
          extra={<Tooltip title={!canSaveConfig ? '仅老板/管理员可保存配置' : ''}>
            <Button type="primary" size="small" icon={<SaveOutlined />} loading={cfgSaving} disabled={!canSaveConfig} onClick={saveCfg}>保存配置</Button>
          </Tooltip>}>
          <Alert type="success" showIcon style={{ marginBottom: 12 }} message="这些经营系数（目标/权重/基准）仅对【本企业】生效，每家企业可按自己的盘子单独设定，互不影响；未设置则沿用平台推荐默认值。" />
          {!canSaveConfig && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="当前角色为只读模式，仅老板/管理员可修改并保存配置" />}
          {cfgGroup('经营目标', grid(<>
            {numField('年度营收目标(元)', cfg.year_revenue_target, (v) => setCfg((c: any) => ({ ...c, year_revenue_target: v })),
              { step: 100000, formatter: (v: any) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ','), parser: (v: any) => `${v}`.replace(/,/g, '') })}
            {numField('月营收目标(元)', cfg.month_revenue_target, (v) => setCfg((c: any) => ({ ...c, month_revenue_target: v })),
              { step: 10000, formatter: (v: any) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ','), parser: (v: any) => `${v}`.replace(/,/g, '') })}
            {numField('个人月目标(元)', cfg.personal_month_target, (v) => setCfg((c: any) => ({ ...c, personal_month_target: v })),
              { step: 10000, formatter: (v: any) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ','), parser: (v: any) => `${v}`.replace(/,/g, '') })}
            {numField('平均客单价(元)', cfg.avg_deal_amount, (v) => setCfg((c: any) => ({ ...c, avg_deal_amount: v })),
              { step: 500, formatter: (v: any) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ','), parser: (v: any) => `${v}`.replace(/,/g, '') })}
          </>))}
          {cfgGroup('月度目标', grid(Object.entries(cfg.month_targets || {}).map(([k, v]: any) =>
            numField(MT_LABELS[k] || k, v, (nv) => setCfgSub('month_targets', k, nv)))))}
          {cfgGroup('漏斗转化基准(%)', grid(Object.entries(cfg.funnel_baseline || {}).map(([k, v]: any) =>
            numField(`→ ${k}(%)`, v, (nv) => setCfgSub('funnel_baseline', k, nv), { max: 100 }))))}
          {cfgGroup('活动效果基准', grid(Object.entries(cfg.activity_baseline || {}).map(([k, v]: any) =>
            numField(AB_LABELS[k] || k, v, (nv) => setCfgSub('activity_baseline', k, nv), k === 'roi' ? { step: 0.1 } : { max: 100 }))))}
          {cfgGroup(`健康度权重（合计 ${Number(weightSum).toFixed(2)}，建议=1）`, grid(Object.entries(cfg.health_weights || {}).map(([k, v]: any) =>
            numField(HW_LABELS[k] || k, v, (nv) => setCfgSub('health_weights', k, nv), { max: 1, step: 0.05 }))))}
        </Panel>
      </Col>
      <Col xs={24} lg={10}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Panel title={<><AlertOutlined style={{ color: '#f6a02d' }} /> 风控规则</>}
            extra={<span style={{ fontSize: 11, color: 'var(--ui-muted)' }}>命中即送审</span>} style={{ height: 'auto' }}>
            <Table size="small" rowKey="code" dataSource={cfg.risk_rules || []} pagination={false}
              columns={[
                { title: '规则名称', dataIndex: 'name', width: 130, render: (v: string) => <span style={{ fontWeight: 600, fontSize: 12.5 }}>{v}</span> },
                {
                  title: '等级', dataIndex: 'level', width: 64,
                  render: (v: string) => <Tag color={RISK_TAG[v]?.color || 'default'}>{v === 'high' ? '高' : v === 'medium' ? '中' : '低'}</Tag>,
                },
                {
                  title: '触发模式(正则)', dataIndex: 'pattern', ellipsis: true,
                  render: (v: string) => <Tooltip title={v}>
                    <span style={{ fontFamily: 'Consolas,Menlo,monospace', fontSize: 11, color: '#8a7450', background: 'var(--ui-surface)', borderRadius: 4, padding: '1px 6px' }}>{v}</span>
                  </Tooltip>,
                },
              ]} />
          </Panel>
          <Panel title={<><CloudServerOutlined style={{ color: '#22c4a8' }} /> 数据备份</>}
            extra={<Tooltip title={!canBackup ? '仅老板/管理员可操作备份' : ''}>
              <Button type="primary" size="small" icon={<CloudUploadOutlined />} loading={backingUp} disabled={!canBackup} onClick={doBackup}>立即备份</Button>
            </Tooltip>} style={{ height: 'auto' }}>
            <Table size="small" rowKey="file" dataSource={backups} pagination={false}
              columns={[
                { title: '文件名', dataIndex: 'file', ellipsis: true, render: (v: string) => <Tooltip title={v}><span style={{ fontFamily: 'Consolas,Menlo,monospace', fontSize: 11.5 }}>{v}</span></Tooltip> },
                { title: '大小', dataIndex: 'sizeKB', align: 'right', width: 80, render: (v: number) => fmtKBSize(v) },
                { title: '备份时间', dataIndex: 'at', width: 150, render: (v: string) => <span style={{ color: 'var(--ui-muted)', fontSize: 12 }}>{v}</span> },
              ]}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={canBackup ? '暂无备份，点击「立即备份」创建' : '仅老板/管理员可查看备份'} /> }} />
          </Panel>

          <Panel title={<><LinkOutlined style={{ color: 'var(--ui-accent)' }} /> 飞书集成</>}
            extra={feishuCfg?.enabled
              ? <Tag color="success">{feishuCfg.receiverName ? `已绑定：${feishuCfg.receiverName}` : '应用机器人已连接'}</Tag>
              : <Tag>未连接</Tag>} style={{ height: 'auto' }}>
            {feishuCfg?.enabled ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Alert type="success" showIcon
                  message={`飞书应用机器人运行中：活动会自动写入飞书日历，并推送给已绑定的老板/管理层（当前 ${feishuCfg.managerReceiverCount || 0} 人，${feishuCfg.managerCalendarCount || 0} 人可加入日历提醒）`} />
                {(feishuCfg.managerReceivers || []).length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {(feishuCfg.managerReceivers || []).map((r: any, i: number) => (
                      <div key={`${r.receiveIdType}-${r.receiveId}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--ui-surface)', border: '1px solid var(--ui-surface)', borderRadius: 8, padding: '7px 9px', fontSize: 12 }}>
                        <span style={{ color: 'var(--ui-text)', fontWeight: 600 }}>{r.receiverName || r.userName || '飞书用户'} <Tag color="blue" style={{ marginLeft: 6 }}>{r.roleLabel || '管理者'}</Tag></span>
                        <Space size={4}>
                          <Tag color={r.calendarReady ? 'green' : 'default'}>{r.calendarReady ? '日历提醒' : '仅消息'}</Tag>
                          {r.primary && <Tag color="gold">主接收人</Tag>}
                        </Space>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Alert type="warning" showIcon message="暂无老板/管理层接收人，请让老板、运营总监或管理员分别扫码绑定一次。" />
                )}
                <Space wrap>
                  <Button size="small" type="primary" onClick={() => {
                    api.post('/sys/feishu/test').then((r: any) => message.success(`测试卡片已发送：${r.sent || 0}/${r.total || 0}`)).catch(() => {});
                  }}>发送管理层测试消息</Button>
                  <Button size="small" onClick={openFeishuBind}>扫码添加管理者</Button>
                  <Button size="small" onClick={() => setFeishuManual({ receiveIdType: 'open_id', receiveId: '', receiverName: '' })}>手动绑定接收人</Button>
                  <Button size="small" icon={<LinkOutlined />} onClick={openFeishuBot}>在飞书中打开机器人</Button>
                  <Button size="small" danger onClick={() => {
                    api.put('/sys/feishu', { enabled: false }).then(() => { message.success('已停用飞书同步'); loadFeishu(); });
                  }}>停用</Button>
                </Space>
                <div style={{ fontSize: 11.5, color: 'var(--ui-muted)' }}>绑定后，经营提醒与每日经营日报会通过应用机器人推送给已绑定的老板/管理层。</div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '6px 0 2px' }}>
                <div style={{ fontSize: 12.5, color: 'var(--ui-text-2)', marginBottom: 10 }}>绑定后：经营提醒与每日经营日报推送到管理层飞书 · 活动自动写入飞书日历 · 不需要群机器人</div>
                <Button type="primary" size="large" icon={<RobotOutlined />} block
                  onClick={openFeishuBind}>扫码绑定飞书</Button>
                <div style={{ fontSize: 12, color: 'var(--ui-muted)', marginTop: 10 }}>
                  无法扫码？<a onClick={() => setFeishuManual({ receiveIdType: 'open_id', receiveId: '', receiverName: '' })}>手动填写接收人 ID 绑定</a>
                </div>
              </div>
            )}
            <Modal open={feishuQr} footer={null} width={500} onCancel={() => setFeishuQr(false)}
              title="扫码绑定飞书">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center', textAlign: 'center' }}>
                {feishuCfg && !feishuCfg.appReady ? (
                  <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12, textAlign: 'left' }}>
                    <Alert type="warning" showIcon
                      message="还没有配置飞书企业自建应用"
                      description={<span style={{ fontSize: 12 }}>老板/管理员填写一次 App ID 和 App Secret 后，系统会立即生成扫码二维码；普通员工不需要配置。</span>} />
                    <div style={{ background: 'var(--ui-surface-2)', border: '1px solid var(--ui-border)', borderRadius: 10, padding: '12px 14px' }}>
                      <div style={{ fontSize: 12.5, color: 'var(--ui-text-2)', marginBottom: 6 }}>飞书 App ID</div>
                      <Input placeholder="cli_xxxxxxxxxxxxxxxx" value={feishuAppForm.appId}
                        onChange={(e) => setFeishuAppForm({ ...feishuAppForm, appId: e.target.value })} />
                      <div style={{ fontSize: 12.5, color: 'var(--ui-text-2)', margin: '12px 0 6px' }}>飞书 App Secret</div>
                      <Input.Password placeholder="请输入飞书应用的 App Secret" value={feishuAppForm.appSecret}
                        onChange={(e) => setFeishuAppForm({ ...feishuAppForm, appSecret: e.target.value })} />
                      <Button type="primary" block loading={feishuAppSaving || feishuSaving} style={{ marginTop: 14 }}
                        onClick={saveFeishuAppAndScan}>保存配置并生成二维码</Button>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', lineHeight: 1.7 }}>
                      获取位置：飞书开放平台 → 企业自建应用 → 凭证与基础信息。保存后会按当前企业单独存储，不会影响其他企业。
                    </div>
                  </div>
                ) : (
                  <>
                    <Alert type="info" showIcon style={{ width: '100%', textAlign: 'left' }}
                      message="用飞书扫一扫，授权后自动绑定"
                      description={<span style={{ fontSize: 12 }}>不需要群机器人，不需要手填 open_id。老板、运营总监、管理员分别扫码后，活动通知会推送给所有已绑定管理者，日历会自动加入参与人和提醒。</span>} />
                    <div style={{ width: 282, height: 282, border: '1px solid var(--ui-surface)', borderRadius: 12, display: 'grid', placeItems: 'center', background: 'var(--ui-surface)' }}>
                      {feishuBind?.qrDataUrl
                        ? <img src={feishuBind.qrDataUrl} alt="飞书扫码绑定二维码" style={{ width: 260, height: 260 }} />
                        : <span style={{ color: 'var(--ui-muted)' }}>{feishuSaving ? '正在生成二维码...' : '二维码生成失败'}</span>}
                    </div>
                    {feishuBind?.appId && (
                      <div style={{ width: '100%', textAlign: 'left', border: '1px solid var(--ui-surface)', background: 'var(--ui-surface)', borderRadius: 10, padding: '10px 12px' }}>
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: '#1d4ed8', marginBottom: 6 }}>当前系统使用的飞书 App ID</div>
                        <Input value={feishuBind.appId} readOnly style={{ fontSize: 12, fontFamily: 'Consolas, Menlo, monospace' }} />
                        <Button size="small" icon={<CopyOutlined />} style={{ marginTop: 8 }} onClick={() => {
                          navigator.clipboard?.writeText(feishuBind.appId);
                          message.success('App ID 已复制');
                        }}>复制 App ID</Button>
                        <div style={{ fontSize: 11.5, color: 'var(--ui-text-2)', marginTop: 6, lineHeight: 1.6 }}>
                          请确认飞书后台「凭证与基础信息」里的 App ID 与这里完全一致；如果不一致，重定向 URL 加在另一个应用里也会报 20029。
                        </div>
                      </div>
                    )}
                    {feishuBind?.redirectUri && (
                      <div style={{ width: '100%', textAlign: 'left', border: '1px solid var(--ui-surface)', background: 'var(--ui-surface)', borderRadius: 10, padding: '10px 12px' }}>
                        <div style={{ fontSize: 12.5, fontWeight: 700, color: '#8a5a00', marginBottom: 6 }}>飞书提示 20029 时，复制这个重定向 URL 到飞书后台</div>
                        <Input.TextArea value={feishuBind.redirectUri} autoSize={{ minRows: 2, maxRows: 3 }} readOnly style={{ fontSize: 12, fontFamily: 'Consolas, Menlo, monospace' }} />
                        <Button size="small" icon={<CopyOutlined />} style={{ marginTop: 8 }} onClick={() => {
                          navigator.clipboard?.writeText(feishuBind.redirectUri);
                          message.success('重定向 URL 已复制');
                        }}>复制重定向 URL</Button>
                        <div style={{ fontSize: 11.5, color: '#9a6b00', marginTop: 6, lineHeight: 1.6 }}>
                          位置：飞书开发者后台 → 当前应用 → 开发配置 → 安全设置 → 重定向 URL。
                        </div>
                      </div>
                    )}
                    {feishuBind?.localMode && (
                      <Alert type="warning" showIcon style={{ width: '100%', textAlign: 'left' }}
                        message="当前是本地 localhost"
                        description={<span style={{ fontSize: 12 }}>手机扫码无法回调到电脑的 localhost。请先把上面的 URL 加到飞书后台；本地测试时点下方按钮在电脑打开授权页，再用飞书扫码确认。</span>} />
                    )}
                    <Space wrap style={{ justifyContent: 'center' }}>
                      <Button type="primary" icon={<RobotOutlined />} disabled={!feishuBind?.authorizeUrl}
                        onClick={() => window.open(feishuBind.authorizeUrl, '_blank')}>打开飞书授权页</Button>
                      <Button loading={feishuSaving} onClick={startFeishuScan}>重新生成二维码</Button>
                    </Space>
                    <div style={{ fontSize: 12, color: 'var(--ui-muted)' }}>
                      {feishuBindStatus === 'pending' && '等待扫码授权，成功后这里会自动关闭。'}
                      {feishuBindStatus === 'expired' && '二维码已过期，请重新生成。'}
                      {feishuBindStatus === 'error' && '绑定失败，请重新生成二维码再试。'}
                      {feishuBindStatus === 'missing' && '二维码会话不存在，请重新生成。'}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--ui-muted)' }}>
                      扫码走不通？<a onClick={() => setFeishuManual({ receiveIdType: 'open_id', receiveId: '', receiverName: '' })}>手动填写接收人 ID 绑定</a>
                    </div>
                  </>
                )}
              </div>
            </Modal>
            {/* 手动绑定应用机器人接收人（扫码兜底：直接填 receive_id） */}
            <Modal open={!!feishuManual} width={480} title="手动绑定飞书接收人" okText="确认绑定"
              confirmLoading={feishuManualSaving}
              onOk={submitFeishuManual} onCancel={() => setFeishuManual(null)}>
              {feishuManual && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
                  <Alert type="info" showIcon
                    message="扫码授权走不通时的兜底方式"
                    description={<span style={{ fontSize: 12 }}>在飞书开放平台或通讯录 API 中查到接收人的 open_id / user_id / union_id / 邮箱后填入即可。绑定成功会立即发送一张确认卡片；之后经营提醒与每日经营日报会推送给该接收人及已绑定管理层。</span>} />
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>ID 类型</div>
                    <Select style={{ width: '100%' }} value={feishuManual.receiveIdType} options={FEISHU_ID_TYPES}
                      onChange={(v) => setFeishuManual({ ...feishuManual, receiveIdType: v })} />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>接收人 ID <span style={{ color: '#f25b6b' }}>*</span></div>
                    <Input placeholder={feishuManual.receiveIdType === 'email' ? 'name@company.com' : 'ou_xxxxxxxxxxxxxxxx'}
                      value={feishuManual.receiveId}
                      onChange={(e) => setFeishuManual({ ...feishuManual, receiveId: e.target.value })} />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>接收人姓名（选填）</div>
                    <Input placeholder="便于识别当前绑定对象" maxLength={30} value={feishuManual.receiverName}
                      onChange={(e) => setFeishuManual({ ...feishuManual, receiverName: e.target.value })} />
                  </div>
                </div>
              )}
            </Modal>
          </Panel>
        </div>
      </Col>
    </Row>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 顶部快捷入口（图标按钮格，点击切换对应Tab） */}
      <Panel title="快捷入口">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(96px,1fr))', gap: 10 }}>
          {QUICK.map((q) => (
            <div key={q.label} onClick={() => changeTab(q.tab)}
              style={{ border: '1px solid var(--ui-border)', borderRadius: 8, padding: '12px 8px', textAlign: 'center', cursor: 'pointer', background: 'var(--ui-surface)', transition: 'box-shadow .2s' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 12px rgba(43,109,239,.12)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.boxShadow = 'none'; }}>
              <Badge count={q.badge || 0} size="small" offset={[2, 2]}>
                <div style={{ width: 36, height: 36, borderRadius: 9, margin: '0 auto', background: `${q.color}1a`, color: q.color, fontSize: 17, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {q.icon}
                </div>
              </Badge>
              <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginTop: 6, whiteSpace: 'nowrap' }}>{q.label}</div>
            </div>
          ))}
        </div>
      </Panel>

      {/* 六大区块 Tabs（核心数据全部加载失败时给明确错误态 + 重试，不展示空壳数据） */}
      {coreError ? (
        <ErrorState error={coreError} retrying={coreLoading} onRetry={loadCore} />
      ) : (
        <Tabs activeKey={tab} onChange={changeTab} items={[
          { key: 'overview', label: '系统概览', children: overviewTab },
          { key: 'data-intake', label: '数据录入中枢', children: isAdminish ? <DataIntake /> : noPermTip },
          {
            key: 'approvals',
            label: pendingCount > 0 ? <Badge size="small" count={pendingCount} offset={[10, -2]}>审批中心</Badge> : '审批中心',
            children: approvalsTab,
          },
          { key: 'kb', label: '知识库', children: kbTab },
          { key: 'prompts', label: '提示词模板', children: promptsTab },
          { key: 'users', label: '用户与日志', children: usersTab },
          { key: 'trash', label: '删除留痕', children: trashTab },
          { key: 'config', label: '配置与备份', children: configTab },
        ]} />
      )}

      {/* 驳回理由 Modal */}
      <Modal title={`驳回审批：${rejectRow?.title || ''}`} open={!!rejectRow} confirmLoading={deciding}
        okText="确认驳回" okButtonProps={{ danger: true }} cancelText="取消"
        onCancel={() => { setRejectRow(null); setRejectReason(''); }}
        onOk={() => {
          if (!rejectReason.trim()) { message.warning('驳回必须填写理由'); return; }
          decide(rejectRow, false, rejectReason.trim());
        }}>
        <div style={{ fontSize: 12, color: 'var(--ui-muted)', marginBottom: 8 }}>驳回理由将通知提交人（必填）</div>
        <Input.TextArea rows={4} maxLength={200} showCount placeholder="请填写驳回理由，例如：命中广告法绝对化用语，请修改后重新提交"
          value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
      </Modal>

      {/* 知识库文档 Modal */}
      <Modal title={kbForm?.id ? '编辑文档' : '新增文档'} open={!!kbForm} confirmLoading={kbSaving}
        okText="保存" cancelText="取消" onCancel={() => setKbForm(null)} onOk={submitKb} width={560}>
        {kbForm && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>分类</div>
              <Select style={{ width: '100%' }} value={kbForm.category} disabled={!!kbForm.id}
                options={kbCats.filter(c => c !== '员工产出').map((c) => ({ value: c, label: c }))}
                onChange={(v) => setKbForm({ ...kbForm, category: v })} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>标题 <span style={{ color: '#f25b6b' }}>*</span></div>
              <Input placeholder="如：门店品牌故事与核心卖点" value={kbForm.title} maxLength={50}
                onChange={(e) => setKbForm({ ...kbForm, title: e.target.value })} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>内容 <span style={{ color: '#f25b6b' }}>*</span></div>
              <Input.TextArea rows={8} placeholder="粘贴资料正文，AI生成内容时将自动引用该资料" value={kbForm.body}
                onChange={(e) => setKbForm({ ...kbForm, body: e.target.value })} />
            </div>
          </div>
        )}
      </Modal>

      {/* 提示词编辑 Modal */}
      <Modal title={promptForm ? <><Tag color="blue">{promptForm.code}</Tag>编辑提示词：{promptForm.name}</> : ''}
        open={!!promptForm} confirmLoading={promptSaving} okText="保存" cancelText="取消" width={620}
        onCancel={() => setPromptForm(null)} onOk={submitPrompt}>
        {promptForm && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
            {[['角色卡', 'role_card'], ['输出规则', 'output_rule'], ['风格要求', 'style']].map(([label, field]) => (
              <div key={field}>
                <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>{label}</div>
                <Input.TextArea rows={4} value={promptForm[field]}
                  onChange={(e) => setPromptForm({ ...promptForm, [field]: e.target.value })} />
              </div>
            ))}
            <div style={{ fontSize: 11.5, color: 'var(--ui-muted)' }}>保存后立即对所有 AI 生成生效，并保留内部审计记录</div>
          </div>
        )}
      </Modal>

      {/* 用户新增/编辑 Modal */}
      <Modal title={userForm?.id ? `编辑用户：${userForm.username}` : '新增用户'} open={!!userForm} confirmLoading={userSaving}
        okText="保存" cancelText="取消" onCancel={() => setUserForm(null)} onOk={submitUser}>
        {userForm && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
            {!userForm.id && (
              <div>
                <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>用户名 <span style={{ color: '#f25b6b' }}>*</span></div>
                <Input placeholder="登录账号，如 zhangsan" value={userForm.username}
                  onChange={(e) => setUserForm({ ...userForm, username: e.target.value })} />
              </div>
            )}
            <div>
              <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>
                {userForm.id ? '重置密码（留空则不修改）' : <>密码 <span style={{ color: '#f25b6b' }}>*</span></>}
              </div>
              <Input.Password placeholder={userForm.id ? '留空保持原密码' : '初始登录密码'} value={userForm.password}
                onChange={(e) => setUserForm({ ...userForm, password: e.target.value })} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>姓名 <span style={{ color: '#f25b6b' }}>*</span></div>
              <Input placeholder="真实姓名" value={userForm.name} onChange={(e) => setUserForm({ ...userForm, name: e.target.value })} />
            </div>
            <Row gutter={12}>
              <Col span={12}>
                <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>角色</div>
                <Select style={{ width: '100%' }} value={userForm.role}
                  options={Object.entries(ROLE_MAP).map(([v, m]) => ({ value: v, label: m.label }))}
                  onChange={(v) => setUserForm({ ...userForm, role: v })} />
              </Col>
              <Col span={12}>
                <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>部门</div>
                <Input placeholder="如：销售部" value={userForm.dept} onChange={(e) => setUserForm({ ...userForm, dept: e.target.value })} />
              </Col>
            </Row>
            {!userForm.id && (
              <div>
                <div style={{ fontSize: 12, color: 'var(--ui-text-2)', marginBottom: 4 }}>手机号</div>
                <Input placeholder="选填" value={userForm.phone} onChange={(e) => setUserForm({ ...userForm, phone: e.target.value })} />
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ===== 知识库权限设置 Modal ===== */}
      <Modal open={!!kbPerm} width={520} confirmLoading={kbPermSaving} okText="保存权限"
        onOk={saveKbPerm} onCancel={() => setKbPerm(null)}
        title={kbPerm ? `权限设置 · ${kbPerm.title}` : ''}>
        {kbPerm && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Alert type="info" showIcon message="两项均不勾选 = 全员开放；勾选后仅所选角色生效。老板与管理员始终拥有完整权限。" />
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>👀 谁可以查看（前台知识库列表可见性）</div>
              <Select mode="multiple" allowClear style={{ width: '100%' }} placeholder="不选=全员可见"
                value={kbPerm.visible} onChange={(v: string[]) => setKbPerm({ ...kbPerm, visible: v })}
                options={ROLE_OPTS} />
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>🤖 谁的AI可以调用（老板参谋/数字员工/内容生产仓引用上下文）</div>
              <Select mode="multiple" allowClear style={{ width: '100%' }} placeholder="不选=全员AI可引用"
                value={kbPerm.callable} onChange={(v: string[]) => setKbPerm({ ...kbPerm, callable: v })}
                options={ROLE_OPTS} />
              <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', marginTop: 6 }}>例：招商政策细则仅勾选「老板+管理层」，员工提问时AI不会引用该文档内容。</div>
            </div>
          </div>
        )}
      </Modal>

      {/* ===== 知识库文档详情抽屉（正文全文 + 附件预览） ===== */}
      <Drawer open={!!kbView} width={560} onClose={() => setKbView(null)}
        title={kbView ? <Space><BookOutlined style={{ color: '#22c4a8' }} />{kbView.title}<Tag>{kbView.category}</Tag></Space> : ''}
        extra={canEditKb && kbView && <Button size="small" icon={<EditOutlined />}
          onClick={() => { setKbForm({ id: kbView.id, category: kbView.category, title: kbView.title, body: kbView.body }); setKbView(null); }}>编辑</Button>}>
        {kbView && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--ui-muted)' }}>
              引用 {kbView.ref_count ?? 0} 次 · 更新于 {kbView.updated_at} {kbView.file_name ? `· 附件 ${kbView.file_name}` : ''}
            </div>
            {kbView.file_path && ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(kbView.file_type) && (
              <div style={{ textAlign: 'center', background: 'var(--ui-surface-2)', borderRadius: 10, padding: 8 }}>
                <img src={kbView.file_path} alt={kbView.file_name} style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 6 }} />
              </div>
            )}
            {kbView.file_path && kbView.file_type === 'pdf' && (
              <iframe src={kbView.file_path} title="pdf" style={{ width: '100%', height: 360, border: '1px solid var(--ui-border)', borderRadius: 8 }} />
            )}
            {kbView.file_path && !['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf'].includes(kbView.file_type) && (
              <Button block onClick={() => window.open(kbView.file_path, '_blank')}>⬇️ 下载原文件（{kbView.file_name}）</Button>
            )}
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ui-text)', marginBottom: 6 }}>知识正文（AI 引用内容）</div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, lineHeight: 1.85, maxHeight: 380, overflow: 'auto',
                background: 'var(--ui-surface-2)', border: '1px solid var(--ui-border)', borderRadius: 8, padding: '10px 12px', color: 'var(--ui-text-2)' }}>{kbView.body}</div>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--ui-muted)' }}>说明：老板参谋/数字员工/内容生产仓引用的是上方「知识正文」；附件原件永久存档可下载。图片识图与文档提取结果可点右上「编辑」修订。</div>
          </div>
        )}
      </Drawer>

      {/* ===== 删除快照详情抽屉 ===== */}
      <Drawer open={!!deletionView} width={680} onClose={() => setDeletionView(null)}
        title={deletionView ? <Space><DeleteOutlined style={{ color: '#f25b6b' }} />删除留痕 · {deletionView.title}<Tag>{deletionView.module}</Tag></Space> : ''}
        extra={deletionView && !deletionView.restored_at && (
          <Popconfirm title="确认恢复这条数据？" description="会按原始快照恢复主数据和关联数据。" okText="恢复" cancelText="取消"
            onConfirm={() => restoreDeletion(deletionView)}>
            <Button type="primary" ghost icon={<UndoOutlined />}>恢复数据</Button>
          </Popconfirm>
        )}>
        {deletionView && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Alert type={deletionView.restored_at ? 'success' : 'warning'} showIcon
              message={deletionView.restored_at ? `已由 ${deletionView.restored_by_name || '-'} 恢复：${deletionView.restored_at}` : '该数据当前在回收站，业务页面不可见。'} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 10 }}>
              {[
                ['删除人', `${deletionView.deleted_by_name || '-'}（${ROLE_MAP[deletionView.deleted_by_role]?.label || deletionView.deleted_by_role || '-'}）`],
                ['删除时间', deletionView.created_at || '-'],
                ['所需权限', deletionView.required_role === 'boss' ? '老板/管理员' : deletionView.required_role === 'manager' ? '管理层' : '本人'],
              ].map(([k, v]) => (
                <div key={k} style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '9px 11px' }}>
                  <div style={{ fontSize: 11.5, color: 'var(--ui-muted)' }}>{k}</div>
                  <div style={{ fontSize: 13, color: 'var(--ui-text)', fontWeight: 600, marginTop: 3 }}>{v}</div>
                </div>
              ))}
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>删除原因</div>
              <div style={{ background: 'var(--ui-surface)', border: '1px solid var(--ui-border)', borderRadius: 8, padding: '9px 11px', fontSize: 12.5, color: 'var(--ui-text-2)', lineHeight: 1.8 }}>
                {deletionView.reason || '-'}
              </div>
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>主数据快照</div>
              <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto', background: 'var(--ui-surface-2)', border: '1px solid var(--ui-border)', borderRadius: 8, padding: 12, fontSize: 11.5, color: 'var(--ui-text-2)' }}>
                {JSON.stringify(deletionView.snapshot?.row || {}, null, 2)}
              </pre>
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>关联数据快照</div>
              <Space wrap>
                {Object.entries(deletionView.child_snapshot || {}).map(([table, rows]: any) => (
                  <Tag key={table} color={Array.isArray(rows) && rows.length ? 'blue' : 'default'}>{table}：{Array.isArray(rows) ? rows.length : 0} 条</Tag>
                ))}
              </Space>
              <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto', background: 'var(--ui-surface-2)', border: '1px solid var(--ui-border)', borderRadius: 8, padding: 12, fontSize: 11.5, color: 'var(--ui-text-2)', marginTop: 8 }}>
                {JSON.stringify(deletionView.child_snapshot || {}, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
