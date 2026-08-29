import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Row,
  Col,
  Table,
  Tag,
  Button,
  Input,
  Select,
  Modal,
  Form,
  InputNumber,
  DatePicker,
  Tabs,
  Typography,
  Avatar,
  Empty,
  Spin,
  message,
  Space,
  Progress,
  Divider,
  Alert,
  Popconfirm,
} from 'antd';
import {
  UserAddOutlined,
  ClockCircleOutlined,
  TeamOutlined,
  CalendarOutlined,
  ShopOutlined,
  TrophyOutlined,
  BulbOutlined,
  RobotOutlined,
  ReloadOutlined,
  PlusOutlined,
  AlertOutlined,
  SendOutlined,
  RightOutlined,
  MessageOutlined,
  SearchOutlined,
  UploadOutlined,
  InboxOutlined,
  DownloadOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { api, notifyCredits } from '../api/client';
import { loadXlsx, type XlsxModule } from '../utils/xlsx';
import { parseGrowthSuggestions as parseSuggestions } from '../utils/growth';
import { StatCard, Panel, StageTag, GradeTag } from '../components/Kit';
import { Chart, CHART_COLORS, axisStyle } from '../components/Charts';
import GrowthTodayFocus from '../components/GrowthTodayFocus';
import BirthdayCare from '../components/BirthdayCare';
import { GrowthInfoRow as InfoRow, GrowthSectionTitle as SectionTitle } from '../components/GrowthPrimitives';

const { Paragraph } = Typography;

const STAGES = ['新线索', '已沟通', '已邀约', '已到店', '已成交', '复购', '已流失'];
const GRADES = ['A', 'B', 'C'];
const SOURCES = ['短视频', '朋友圈', '社群', '转介绍', '主题试吃', '到店', '合作伙伴推荐'];
// 身份标签兜底值：GET /api/meta/enums 拉取失败时回退，避免下拉框为空
const DEFAULT_IDENTITIES = ['企业主', '高管', '个体创业者', '普通消费者'];
const BUDGETS = ['高', '中', '低', '未知'];
const budgetColor: Record<string, string> = { 高: 'red', 中: 'orange', 低: 'default', 未知: 'default' };

const fmtTime = (v: any) => (v ? String(v).replace('T', ' ').slice(0, 16) : '');
const interactiveSurfaceStyle = {
  appearance: 'none',
  border: 0,
  padding: 0,
  margin: 0,
  width: '100%',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  textAlign: 'inherit',
} as const;

function leadBucketTags(lead: any) {
  if (!lead || ['已成交', '复购', '已流失'].includes(lead.stage)) return [];
  const tags: any[] = [];
  if (lead.grade === 'A')
    tags.push({
      key: 'aList',
      label: 'A类客户',
      color: 'red',
      reason: `评分 ${lead.score ?? '-'} 分，达到 A 类阈值 70 分`,
    });
  if (Number(lead.score) >= 80 || (lead.stage === '已到店' && ['高', '中'].includes(lead.budget_level))) {
    tags.push({
      key: 'closing',
      label: '即将成交',
      color: 'orange',
      reason:
        Number(lead.score) >= 80
          ? `评分 ${lead.score} 分，达到成交优先阈值 80 分`
          : `已到店且预算为${lead.budget_level}`,
    });
  }
  if (Number(lead.boss_alert) === 1 || (lead.grade === 'A' && lead.budget_level === '高')) {
    tags.push({
      key: 'bossList',
      label: '建议老板介入',
      color: 'purple',
      reason: 'A类客户 + 高预算，适合老板/总监出面促成',
    });
  }
  return tags;
}

export default function Growth() {
  // ===== 顶部 / 图表数据 =====
  const [summary, setSummary] = useState<any>({});
  const [sources, setSources] = useState<any[]>([]);
  const [funnel, setFunnel] = useState<any>({ funnel: [] });
  const [keyCust, setKeyCust] = useState<any>({ aList: [], closing: [], bossList: [] });
  const [kcTab, setKcTab] = useState('aList');

  // ===== AI 跟进建议卡 =====
  const [aiSugs, setAiSugs] = useState<string[]>([]);
  const [aiLoading, setAiLoading] = useState(false);

  // ===== 私域跟进工作台 =====
  const [convs, setConvs] = useState<any[]>([]);
  const [convKw, setConvKw] = useState('');
  const [selectedId, setSelectedId] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailRequestRef = useRef(0);
  const leadListRequestRef = useRef(0);
  const [followText, setFollowText] = useState('');
  const [followNextAt, setFollowNextAt] = useState<any>(null);
  const [followNextAction, setFollowNextAction] = useState('');
  const [savingFollow, setSavingFollow] = useState(false);
  const [wbSugs, setWbSugs] = useState<string[]>([]);
  const [wbAiLoading, setWbAiLoading] = useState(false);
  const [objText, setObjText] = useState('');
  const [objLoading, setObjLoading] = useState(false);
  const [objModal, setObjModal] = useState<{ open: boolean; text: string }>({ open: false, text: '' });

  // ===== 线索台账 =====
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const size = 10;
  const [fStage, setFStage] = useState<string | undefined>();
  const [fGrade, setFGrade] = useState<string | undefined>();
  const [fSource, setFSource] = useState<string | undefined>();
  const [fFollowStatus, setFFollowStatus] = useState<string | undefined>();
  const [kw, setKw] = useState('');
  const [sort, setSort] = useState('score');
  const [journey, setJourney] = useState<any>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  // KPI卡点击 → 台账联动筛选 + 滚动定位
  const kpiFilter = (opts: { stage?: string; sort?: string; hint: string }) => {
    setFStage(opts.stage);
    setFGrade(undefined);
    setFSource(undefined);
    setFFollowStatus(undefined);
    setKw('');
    setPage(1);
    setSort(opts.sort || 'score');
    message.info(opts.hint, 1.6);
    setTimeout(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  };
  const [tableLoading, setTableLoading] = useState(false);

  // ===== Modal：阶段推进 / 新增线索 =====
  const [advOpen, setAdvOpen] = useState(false);
  const [advLead, setAdvLead] = useState<any>(null);
  const [advSaving, setAdvSaving] = useState(false);
  const [advForm] = Form.useForm();
  const [addOpen, setAddOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportSaving, setReportSaving] = useState(false);
  const [reportForm] = Form.useForm();
  const [addSaving, setAddSaving] = useState(false);
  const [addForm] = Form.useForm();
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchRows, setBatchRows] = useState<any[]>([]);
  const [batchPaste, setBatchPaste] = useState('');
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [batchResult, setBatchResult] = useState<any>(null);
  const [followReport, setFollowReport] = useState<any>({ summary: {}, rows: [], staff: [] });
  const [followReportLoading, setFollowReportLoading] = useState(false);
  const [reportKw, setReportKw] = useState('');
  const [reportStage, setReportStage] = useState<string | undefined>();
  const [reportOwner, setReportOwner] = useState<string | undefined>();
  const [reportNextStatus, setReportNextStatus] = useState<string | undefined>();
  const [reportSort, setReportSort] = useState('lastFollow');
  const [keyKw, setKeyKw] = useState('');
  const [keyStage, setKeyStage] = useState<string | undefined>();
  const [keyBudget, setKeyBudget] = useState<string | undefined>();
  const [keySort, setKeySort] = useState('scoreDesc');
  // 身份标签单源化：挂载时从 /api/meta/enums 取一次，失败回退本地默认值（client 已自动提示错误）
  const [identities, setIdentities] = useState<string[]>(DEFAULT_IDENTITIES);
  const [exportingLeads, setExportingLeads] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api
      .get('/meta/enums')
      .then((d: any) => {
        if (!cancelled && Array.isArray(d?.identities) && d.identities.length) setIdentities(d.identities);
      })
      .catch(() => {
        /* 拉取失败保持 DEFAULT_IDENTITIES，页面不 crash */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const LEAD_HEADER_MAP: Record<string, string> = {
    姓名: 'name',
    客户姓名: 'name',
    客户: 'name',
    名称: 'name',
    name: 'name',
    手机: 'phone',
    手机号: 'phone',
    电话: 'phone',
    联系电话: 'phone',
    phone: 'phone',
    微信: 'wechat',
    微信号: 'wechat',
    微信id: 'wechat',
    wechat: 'wechat',
    来源: 'source',
    来源渠道: 'source',
    渠道: 'source',
    source: 'source',
    身份: 'identity_tag',
    客户身份: 'identity_tag',
    身份标签: 'identity_tag',
    identity: 'identity_tag',
    意向: 'interest',
    意向产品: 'interest',
    产品: 'interest',
    兴趣: 'interest',
    interest: 'interest',
    预算: 'budget_level',
    预算等级: 'budget_level',
    budget: 'budget_level',
    阶段: 'stage',
    客户阶段: 'stage',
    stage: 'stage',
    公司: 'company',
    企业: 'company',
    单位: 'company',
    company: 'company',
    区域: 'region',
    地区: 'region',
    城市: 'region',
    region: 'region',
    生日: 'birthday',
    客户生日: 'birthday',
    birthday: 'birthday',
    下次跟进: 'next_follow_at',
    跟进日期: 'next_follow_at',
    下次跟进日期: 'next_follow_at',
    next_follow_at: 'next_follow_at',
    下次动作: 'next_action',
    跟进动作: 'next_action',
    下一步动作: 'next_action',
    next_action: 'next_action',
    备注: 'note',
    跟进备注: 'note',
    沟通记录: 'note',
    note: 'note',
  };
  const pickOption = (v: any, list: string[], fallback: string) => {
    const s = String(v ?? '').trim();
    if (!s) return fallback;
    return list.find(x => x === s || s.includes(x)) || fallback;
  };
  const cellText = (v: any) => String(v ?? '').trim();
  // Excel 日期序列号解析依赖 xlsx 模块；粘贴导入路径全是字符串，不会走该分支
  const xlsxModRef = useRef<XlsxModule | null>(null);
  const dateText = (v: any) => {
    if (typeof v === 'number' && xlsxModRef.current) {
      const d = xlsxModRef.current.SSF.parse_date_code(v);
      if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    }
    return cellText(v).replace(/[./]/g, '-').slice(0, 20);
  };
  const mapLeadRows = (aoa: any[][]) => {
    if (!aoa.length) return [];
    const headers = (aoa[0] || []).map((h: any) => {
      const key = cellText(h).replace(/\s/g, '');
      return LEAD_HEADER_MAP[key] || LEAD_HEADER_MAP[key.toLowerCase()] || null;
    });
    if (!headers.includes('name')) {
      message.warning('表头需包含「客户姓名」或「姓名」列');
      return [];
    }
    const rows = aoa
      .slice(1)
      .map(row => {
        const o: any = {};
        headers.forEach((f, i) => {
          if (f && row[i] !== undefined && row[i] !== '') o[f] = row[i];
        });
        const provided = Object.fromEntries(
          headers.filter(Boolean).map(f => [f, o[f as string] !== undefined && o[f as string] !== '']),
        );
        const lead = {
          name: cellText(o.name),
          phone: cellText(o.phone),
          wechat: cellText(o.wechat),
          source: pickOption(o.source, SOURCES, '到店'),
          identity_tag: pickOption(o.identity_tag, identities, '普通消费者'),
          interest: cellText(o.interest),
          budget_level: pickOption(o.budget_level, BUDGETS, '未知'),
          stage: pickOption(o.stage, STAGES, '新线索'),
          company: cellText(o.company),
          region: cellText(o.region),
          birthday: cellText(o.birthday),
          next_follow_at: dateText(o.next_follow_at),
          next_action: cellText(o.next_action),
          note: cellText(o.note),
          _provided: provided,
        };
        return lead;
      })
      .filter(o => o.name);
    if (rows.length > 500) message.warning('单次最多导入500条，已自动截取前500条');
    return rows.slice(0, 500);
  };
  const parseLeadFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const XLSX = await loadXlsx();
        xlsxModRef.current = XLSX;
        const wb = XLSX.read(reader.result, { type: 'array' });
        const aoa: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
        const rows = mapLeadRows(aoa);
        setBatchRows(rows);
        setBatchResult(null);
        if (rows.length) message.success(`已解析 ${rows.length} 条线索，请核对预览后导入`);
      } catch {
        message.error('文件解析失败：请使用 .xlsx / .xls / .csv 格式');
      }
    };
    reader.readAsArrayBuffer(file);
    return false;
  };
  const parseLeadPaste = (text: string) => {
    setBatchPaste(text);
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) {
      setBatchRows([]);
      return;
    }
    const sep = lines[0].includes('\t') ? '\t' : /,|，/.test(lines[0]) ? /,|，/ : /\s{2,}/;
    const aoa = lines.map(l => l.split(sep as any).map(s => String(s).trim()));
    setBatchRows(mapLeadRows(aoa));
    setBatchResult(null);
  };
  const openBatch = () => {
    setBatchOpen(true);
    setBatchRows([]);
    setBatchPaste('');
    setBatchResult(null);
  };
  const submitLeadBatch = () => {
    if (!batchRows.length) {
      message.warning('没有可导入的线索');
      return;
    }
    setBatchSubmitting(true);
    api
      .post('/growth/leads/batch', { rows: batchRows })
      .then((r: any) => {
        setBatchResult(r);
        message.success(`导入完成：新增 ${r.created?.length || 0} 条，更新 ${r.updated?.length || 0} 条`);
        setPage(1);
        refreshAll();
      })
      .finally(() => setBatchSubmitting(false));
  };
  const exportFollowReport = async () => {
    const exportRows = filteredFollowRows.map((r: any) => ({
      客户: r.name,
      阶段: r.stage,
      等级: r.grade,
      评分: r.score,
      负责人: r.owner_name,
      本月沟通次数: r.month_follow_count,
      累计沟通次数: r.total_follow_count,
      最近跟进人: r.last_follower_name,
      参与账号: r.follower_names,
      最近沟通时间: fmtTime(r.last_follow_at),
      最近沟通内容: r.last_content,
      最近AI建议: r.last_ai_suggestion,
      AI建议次数: r.ai_suggestion_count,
      下次跟进: r.next_follow_at,
      下次动作: r.next_action,
    }));
    if (!exportRows.length) {
      message.warning('本月暂无可导出的沟通记录');
      return;
    }
    const XLSX = await loadXlsx();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportRows), '本月已沟通客户');
    XLSX.writeFile(wb, `本月已沟通客户-${followReport.month || new Date().toISOString().slice(0, 7)}.xlsx`);
  };
  // 导出当前筛选条件下的完整客户列表（后端单页上限100，按页拉全；电话保持后端脱敏原样）
  const exportLeads = async () => {
    setExportingLeads(true);
    try {
      const base = {
        stage: fStage || '',
        grade: fGrade || '',
        source: fSource || '',
        followStatus: fFollowStatus || '',
        kw,
        sort,
      };
      const all: any[] = [];
      for (let p = 1; p <= 50; p++) {
        const params = new URLSearchParams({ ...base, page: String(p), size: '100' });
        const d: any = await api.get(`/growth/leads?${params.toString()}`);
        const batch = d.rows || [];
        all.push(...batch);
        if (!batch.length || all.length >= (d.total || 0)) break;
      }
      if (!all.length) {
        message.warning('当前筛选条件下没有可导出的客户');
        return;
      }
      const XLSX = await loadXlsx();
      const sheetRows = all.map((r: any) => ({
        姓名: r.name || '',
        电话: r.phone || '',
        阶段: r.stage || '',
        等级: r.grade || '',
        身份: r.identity_tag || '',
        归属: r.owner_name || '',
        最近跟进: fmtTime(r.last_follow_at) || '',
        下次跟进: r.next_follow_at
          ? `${String(r.next_follow_at).slice(0, 10)}${r.next_action ? ` ${r.next_action}` : ''}`
          : '',
      }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows), '客户列表');
      XLSX.writeFile(wb, `客户列表-${new Date().toISOString().slice(0, 10)}.xlsx`);
      message.success(`已导出 ${all.length} 条客户`);
    } catch {
      message.error('客户列表导出失败，请稍后重试');
    } finally {
      setExportingLeads(false);
    }
  };

  // ===== loaders =====
  const loadSummary = () => api.get('/growth/summary').then(setSummary);
  const loadSources = () =>
    api.get('/growth/sources').then((d: any) => setSources(Array.isArray(d) ? d : d.rows || []));
  const loadFunnel = () => api.get('/growth/funnel').then(setFunnel);
  const loadKey = () => api.get('/growth/key-customers').then(setKeyCust);
  const loadFollowReport = () => {
    setFollowReportLoading(true);
    api
      .get('/growth/follow-report')
      .then(setFollowReport)
      .finally(() => setFollowReportLoading(false));
  };
  const loadConvs = () =>
    api.get('/growth/conversations').then((d: any) => {
      const list = Array.isArray(d) ? d : d.rows || [];
      setConvs(list);
      setSelectedId((prev: any) => prev ?? (list[0] ? (list[0].id ?? list[0].lead_id) : null));
    });
  const loadLeads = useCallback(() => {
    const requestId = ++leadListRequestRef.current;
    setTableLoading(true);
    const params = new URLSearchParams({
      stage: fStage || '',
      grade: fGrade || '',
      source: fSource || '',
      followStatus: fFollowStatus || '',
      kw,
      page: String(page),
      size: String(size),
      sort,
    });
    api
      .get(`/growth/leads?${params.toString()}`)
      .then((d: any) => {
        if (requestId === leadListRequestRef.current) {
          setRows(d.rows || []);
          setTotal(d.total || 0);
        }
      })
      .finally(() => {
        if (requestId === leadListRequestRef.current) setTableLoading(false);
      });
  }, [fFollowStatus, fGrade, fSource, fStage, kw, page, sort]);
  const loadDetail = useCallback((id: any) => {
    const requestId = ++detailRequestRef.current;
    if (id == null) {
      setDetail(null);
      setJourney(null);
      setDetailLoading(false);
      return;
    }
    setDetailLoading(true);
    api
      .get(`/growth/leads/${id}`)
      .then(data => {
        if (requestId === detailRequestRef.current) setDetail(data);
      })
      .finally(() => {
        if (requestId === detailRequestRef.current) setDetailLoading(false);
      });
    api
      .get(`/growth/leads/${id}/journey`)
      .then(data => {
        if (requestId === detailRequestRef.current) setJourney(data);
      })
      .catch(() => {
        if (requestId === detailRequestRef.current) setJourney(null);
      });
  }, []);
  const confirmAiCharge = (title: string, onOk: () => void) => {
    Modal.confirm({
      title,
      okText: '确认生成',
      cancelText: '取消',
      content: '本操作会调用 AI 生成内容并按积分计费；仅点击确认后才会扣费。',
      onOk,
    });
  };
  const fetchAiCard = () => {
    setAiLoading(true);
    api
      .post('/growth/suggest-reply', {})
      .then((d: any) => {
        setAiSugs(parseSuggestions(d.suggestions));
        if (d.billing) {
          notifyCredits(d.billing.balance);
          if (d.billing.credits > 0) message.success(`AI跟进建议已生成，消耗 ${d.billing.credits} 积分`);
        }
      })
      .finally(() => setAiLoading(false));
  };
  // 数据变更后统一刷新
  const refreshAll = (id?: any) => {
    loadSummary();
    loadFunnel();
    loadSources();
    loadKey();
    loadConvs();
    loadLeads();
    loadFollowReport();
    const target = id ?? selectedId;
    if (target != null) loadDetail(target);
  };

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        loadSummary();
        loadSources();
        loadFunnel();
        loadKey();
        loadConvs();
        loadFollowReport();
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadLeads();
    });
    return () => {
      cancelled = true;
    };
  }, [loadLeads]);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setWbSugs([]);
      setFollowText('');
      setFollowNextAt(null);
      setFollowNextAction('');
      setObjText('');
      loadDetail(selectedId);
    });
    return () => {
      cancelled = true;
    };
  }, [loadDetail, selectedId]);

  // ===== 工作台操作 =====
  const saveFollow = () => {
    if (selectedId == null) return;
    if (!followText.trim()) {
      message.warning('请先填写本次沟通摘要');
      return;
    }
    setSavingFollow(true);
    api
      .post(`/growth/leads/${selectedId}/follow`, {
        content: followText.trim(),
        next_follow_at: followNextAt ? followNextAt.format('YYYY-MM-DD') : undefined,
        next_action: followNextAction.trim() || undefined,
      })
      .then(() => {
        message.success('跟进记录已保存');
        setFollowText('');
        setFollowNextAt(null);
        setFollowNextAction('');
        loadDetail(selectedId);
        loadConvs();
        loadSummary();
        loadLeads();
        loadFollowReport();
      })
      .finally(() => setSavingFollow(false));
  };
  const fetchWbSuggest = (goal = '生成可复制的私域回复话术') => {
    if (selectedId == null) return;
    const current = detail || {};
    const recentFollows = [...(current.follows || [])]
      .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
      .slice(-4)
      .map((f: any) => `${fmtTime(f.created_at)} ${f.stage_after ? `推进至${f.stage_after}：` : ''}${f.content}`)
      .join('\n');
    const buckets =
      leadBucketTags(current)
        .map(t => `${t.label}（${t.reason}）`)
        .join('；') || '暂未命中重点分层';
    const context = [
      `目标：${goal}`,
      `客户分层：${buckets}`,
      recentFollows ? `历史跟进记录：\n${recentFollows}` : '历史跟进记录：暂无',
      followText.trim() ? `最新聊天/活动记录：${followText.trim()}` : '',
      followNextAt ? `希望下次跟进日期：${followNextAt.format('YYYY-MM-DD')}` : '',
      followNextAction.trim() ? `希望下次动作：${followNextAction.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    setWbAiLoading(true);
    api
      .post('/growth/suggest-reply', { leadId: selectedId, context })
      .then((d: any) => {
        setWbSugs(parseSuggestions(d.suggestions));
        if (d.billing) {
          notifyCredits(d.billing.balance);
          if (d.billing.credits > 0) message.success(`AI话术已生成，消耗 ${d.billing.credits} 积分`);
        }
        loadFollowReport();
      })
      .finally(() => setWbAiLoading(false));
  };
  const addObjection = () => {
    if (selectedId == null) return;
    if (!objText.trim()) {
      message.warning('请先填写客户顾虑');
      return;
    }
    setObjLoading(true);
    api
      .post(`/growth/leads/${selectedId}/objection`, { text: objText.trim() })
      .then((d: any) => {
        setObjModal({ open: true, text: d.suggestion || '' });
        setObjText('');
        loadDetail(selectedId);
      })
      .finally(() => setObjLoading(false));
  };
  const resolveObjection = (i: number) => {
    api.post(`/growth/leads/${selectedId}/objection`, { resolveIndex: i }).then(() => {
      message.success('顾虑已标记解决');
      loadDetail(selectedId);
    });
  };

  // ===== 阶段推进 =====
  const openAdvance = (lead: any) => {
    setAdvLead(lead);
    advForm.resetFields();
    setAdvOpen(true);
  };
  const submitAdvance = async () => {
    let v: any;
    try {
      v = await advForm.validateFields();
    } catch {
      return;
    }
    setAdvSaving(true);
    try {
      await api.post(`/growth/leads/${advLead.id}/advance`, v);
      message.success(`「${advLead.name}」已推进至「${v.stage}」`);
      setAdvOpen(false);
      refreshAll(advLead.id);
    } catch {
      /* client 已自动 toast */
    } finally {
      setAdvSaving(false);
    }
  };

  // ===== 新增线索 =====
  const openAdd = () => {
    addForm.resetFields();
    setAddOpen(true);
  };
  const submitAdd = async () => {
    let v: any;
    try {
      v = await addForm.validateFields();
    } catch {
      return;
    }
    const body = { ...v, next_follow_at: v.next_follow_at ? v.next_follow_at.format('YYYY-MM-DD') : undefined };
    setAddSaving(true);
    try {
      await api.post('/growth/leads', body);
      message.success('线索已录入');
      setAddOpen(false);
      setPage(1);
      loadLeads();
      loadSummary();
      loadSources();
      loadConvs();
      loadFunnel();
    } catch {
      /* client 已自动 toast */
    } finally {
      setAddSaving(false);
    }
  };
  const deleteLead = (r: any) => {
    api
      .del(`/growth/leads/${r.id}`)
      .then(() => {
        message.success('线索已删除并进入回收站');
        if (Number(selectedId) === Number(r.id)) setSelectedId(null);
        refreshAll();
      })
      .catch(() => {});
  };

  // ===== 派生数据 =====
  const srcSorted = [...sources].sort((a, b) => (a.n || 0) - (b.n || 0)); // 升序 → y轴category最大值在顶部
  const filteredConvs = convs.filter(c => !convKw || String(c.name || '').includes(convKw));
  const follows = [...(detail?.follows || [])].sort((a, b) =>
    String(a.created_at || '').localeCompare(String(b.created_at || '')),
  );
  const scoreEntries = Object.entries(detail?.score_detail || {});
  const maxDim = Math.max(...scoreEntries.map(([, v]) => Number(v) || 0), 1);
  const bottleneckItem = (funnel.funnel || []).find((x: any) => x.stage === funnel.bottleneck);
  const followUpList = (keyCust.aList || []).slice(0, 4);
  const selectedBuckets = leadBucketTags(detail);
  const [todayText] = useState(() => {
    const localNow = new Date();
    localNow.setMinutes(localNow.getMinutes() - localNow.getTimezoneOffset());
    return localNow.toISOString().slice(0, 10);
  });
  const budgetRank = (v: string) => (({ 高: 1, 中: 2, 低: 3, 未知: 4 }) as Record<string, number>)[v] || 5;
  const stageRank = (v: string) => (STAGES.indexOf(v) >= 0 ? STAGES.indexOf(v) : 99);
  const textRank = (v: any) => String(v || '');
  const dateRank = (v: any) => String(v || '').slice(0, 16);
  const numRank = (v: any) => Number(v || 0);
  const containsText = (v: any, q: string) =>
    String(v || '')
      .toLowerCase()
      .includes(q.toLowerCase());

  const followReportOwnerOptions = useMemo(() => {
    const names = new Set<string>();
    (followReport.staff || []).forEach((s: any) => {
      if (s.name) names.add(String(s.name));
    });
    (followReport.rows || []).forEach((r: any) => {
      [r.owner_name, r.last_follower_name].forEach(v => {
        if (v) names.add(String(v));
      });
      String(r.follower_names || '')
        .split(/[、,，\s]+/)
        .filter(Boolean)
        .forEach(n => names.add(n));
    });
    return Array.from(names).map(name => ({ value: name, label: name }));
  }, [followReport]);

  const filteredFollowRows = useMemo(() => {
    const q = reportKw.trim();
    const rows = [...(followReport.rows || [])].filter((r: any) => {
      const hasNext = Boolean(r.next_follow_at || r.next_action);
      const nextDate = String(r.next_follow_at || '').slice(0, 10);
      if (
        q &&
        ![
          r.name,
          r.company,
          r.owner_name,
          r.last_follower_name,
          r.follower_names,
          r.last_content,
          r.last_ai_suggestion,
          r.next_action,
        ].some(v => containsText(v, q))
      )
        return false;
      if (reportStage && r.stage !== reportStage) return false;
      if (
        reportOwner &&
        ![r.owner_name, r.last_follower_name, r.follower_names].some(v => containsText(v, reportOwner))
      )
        return false;
      if (reportNextStatus === 'hasNext' && !hasNext) return false;
      if (reportNextStatus === 'noNext' && hasNext) return false;
      if (reportNextStatus === 'overdue' && !(nextDate && nextDate < todayText)) return false;
      return true;
    });
    rows.sort((a: any, b: any) => {
      if (reportSort === 'monthCount') return numRank(b.month_follow_count) - numRank(a.month_follow_count);
      if (reportSort === 'totalCount') return numRank(b.total_follow_count) - numRank(a.total_follow_count);
      if (reportSort === 'nextFollow')
        return dateRank(a.next_follow_at || '9999-12-31').localeCompare(dateRank(b.next_follow_at || '9999-12-31'));
      if (reportSort === 'score') return numRank(b.score) - numRank(a.score);
      if (reportSort === 'name') return textRank(a.name).localeCompare(textRank(b.name), 'zh-Hans-CN');
      return dateRank(b.last_follow_at).localeCompare(dateRank(a.last_follow_at));
    });
    return rows;
  }, [followReport, reportKw, reportStage, reportOwner, reportNextStatus, reportSort, todayText]);

  const filteredKeyRows = useMemo(() => {
    const q = keyKw.trim();
    const rows = [...(keyCust[kcTab] || [])].filter((r: any) => {
      if (q && ![r.name, r.company, r.phone, r.owner_name, r.source, r.interest].some(v => containsText(v, q)))
        return false;
      if (keyStage && r.stage !== keyStage) return false;
      if (keyBudget && r.budget_level !== keyBudget) return false;
      return true;
    });
    rows.sort((a: any, b: any) => {
      if (keySort === 'scoreAsc') return numRank(a.score) - numRank(b.score);
      if (keySort === 'budget')
        return budgetRank(a.budget_level) - budgetRank(b.budget_level) || numRank(b.score) - numRank(a.score);
      if (keySort === 'stage') return stageRank(a.stage) - stageRank(b.stage) || numRank(b.score) - numRank(a.score);
      if (keySort === 'name') return textRank(a.name).localeCompare(textRank(b.name), 'zh-Hans-CN');
      return numRank(b.score) - numRank(a.score);
    });
    return rows;
  }, [keyCust, kcTab, keyKw, keyStage, keyBudget, keySort]);

  const ledgerSortMap: Record<string, Record<string, string>> = {
    name: { ascend: 'name', descend: 'nameDesc' },
    source: { ascend: 'source', descend: 'sourceDesc' },
    budget_level: { ascend: 'budget', descend: 'budgetLow' },
    stage: { ascend: 'stage', descend: 'stageDesc' },
    score: { ascend: 'scoreAsc', descend: 'score' },
    owner_name: { ascend: 'owner', descend: 'ownerDesc' },
    follow_backup: { ascend: 'followCountAsc', descend: 'followCount' },
    next_follow_at: { ascend: 'follow', descend: 'followDesc' },
  };
  const ledgerSortOrder = (asc: string, desc?: string) =>
    sort === asc ? 'ascend' : desc && sort === desc ? 'descend' : undefined;
  const handleLedgerTableChange = (_pagination: any, _filters: any, tableSorter: any, extra: any) => {
    if (extra?.action !== 'sort') return;
    const s = Array.isArray(tableSorter) ? tableSorter[0] : tableSorter;
    const key = String(s?.columnKey || s?.field || '');
    const nextSort = s?.order ? ledgerSortMap[key]?.[s.order] : undefined;
    if (nextSort) {
      setSort(nextSort);
      setPage(1);
    }
  };
  const resetReportFilters = () => {
    setReportKw('');
    setReportStage(undefined);
    setReportOwner(undefined);
    setReportNextStatus(undefined);
    setReportSort('lastFollow');
  };
  const resetKeyFilters = () => {
    setKeyKw('');
    setKeyStage(undefined);
    setKeyBudget(undefined);
    setKeySort('scoreDesc');
  };
  const resetLedgerFilters = () => {
    setFStage(undefined);
    setFGrade(undefined);
    setFSource(undefined);
    setFFollowStatus(undefined);
    setKw('');
    setSort('score');
    setPage(1);
  };

  const ledgerCols: any[] = [
    {
      title: '姓名',
      dataIndex: 'name',
      columnKey: 'name',
      width: 110,
      sorter: true,
      sortOrder: ledgerSortOrder('name', 'nameDesc'),
      render: (v: string, r: any) => (
        <button
          type="button"
          className="ui-link-button"
          onClick={() => setSelectedId(r.id)}
          style={{ fontWeight: 600 }}
        >
          {v} {r.grade && <GradeTag grade={r.grade} />}
        </button>
      ),
    },
    { title: '电话', dataIndex: 'phone', width: 112, render: (v: string) => v || '-' },
    {
      title: '来源',
      dataIndex: 'source',
      columnKey: 'source',
      width: 80,
      sorter: true,
      sortOrder: ledgerSortOrder('source', 'sourceDesc'),
      render: (v: string) => v || '-',
    },
    { title: '身份', dataIndex: 'identity_tag', width: 92, render: (v: string) => v || '-' },
    {
      title: '预算',
      dataIndex: 'budget_level',
      columnKey: 'budget_level',
      width: 62,
      sorter: true,
      sortOrder: ledgerSortOrder('budget', 'budgetLow'),
      render: (v: string) => (
        <Tag color={budgetColor[v] || 'default'} style={{ margin: 0 }}>
          {v || '未知'}
        </Tag>
      ),
    },
    {
      title: '阶段',
      dataIndex: 'stage',
      columnKey: 'stage',
      width: 80,
      sorter: true,
      sortOrder: ledgerSortOrder('stage', 'stageDesc'),
      render: (v: string) => <StageTag stage={v} />,
    },
    {
      title: '评分',
      dataIndex: 'score',
      columnKey: 'score',
      width: 58,
      align: 'right',
      sorter: true,
      sortOrder: ledgerSortOrder('scoreAsc', 'score'),
      render: (v: number) => (
        <span style={{ fontWeight: 600, color: v >= 70 ? 'var(--danger)' : 'var(--ui-text-2)' }}>{v ?? '-'}</span>
      ),
    },
    {
      title: '负责人',
      dataIndex: 'owner_name',
      columnKey: 'owner_name',
      width: 74,
      sorter: true,
      sortOrder: ledgerSortOrder('owner', 'ownerDesc'),
      render: (v: string) => v || '-',
    },
    {
      title: '跟进备份',
      key: 'follow_backup',
      columnKey: 'follow_backup',
      width: 128,
      sorter: true,
      sortOrder: ledgerSortOrder('followCountAsc', 'followCount'),
      render: (_: any, r: any) =>
        Number(r.follow_count) > 0 ? (
          <div>
            <div style={{ fontSize: 12, color: 'var(--ui-text)' }}>
              {r.last_follower_name || '-'}{' '}
              <Tag color="blue" style={{ marginLeft: 4, fontSize: 10, lineHeight: '15px' }}>
                {r.follow_count}次
              </Tag>
            </div>
            <div
              style={{
                fontSize: 11,
                color: 'var(--ui-muted)',
                maxWidth: 116,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={r.follower_names || ''}
            >
              {r.follower_names || '已备份'}
            </div>
          </div>
        ) : (
          <Tag color="default" style={{ margin: 0 }}>
            未跟进
          </Tag>
        ),
    },
    {
      title: '下次跟进',
      dataIndex: 'next_follow_at',
      columnKey: 'next_follow_at',
      width: 132,
      sorter: true,
      sortOrder: ledgerSortOrder('follow', 'followDesc'),
      render: (v: string, r: any) =>
        v ? (
          <div>
            <div style={{ fontSize: 12 }}>{String(v).slice(0, 10)}</div>
            {r.next_action && (
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--ui-muted)',
                  maxWidth: 118,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.next_action}
              </div>
            )}
          </div>
        ) : (
          <span style={{ color: 'var(--ui-muted)' }}>-</span>
        ),
    },
    {
      title: '操作',
      key: 'op',
      width: 146,
      fixed: 'right',
      render: (_: any, r: any) => (
        <Space size={6}>
          <button type="button" className="ui-link-button" onClick={() => setSelectedId(r.id)}>
            跟进
          </button>
          <button type="button" className="ui-link-button" onClick={() => openAdvance(r)}>
            推进
          </button>
          <Popconfirm
            title={`删除线索「${r.name}」？`}
            description="删除后进入回收站，老板/管理员可恢复。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => deleteLead(r)}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />} style={{ padding: 0 }}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const kcCols: any[] = [
    {
      title: '客户',
      dataIndex: 'name',
      sorter: (a: any, b: any) => textRank(a.name).localeCompare(textRank(b.name), 'zh-Hans-CN'),
      render: (v: string, r: any) => (
        <>
          <span style={{ fontWeight: 600 }}>{v}</span> <GradeTag grade={r.grade} />
        </>
      ),
    },
    {
      title: '阶段',
      dataIndex: 'stage',
      width: 80,
      sorter: (a: any, b: any) => stageRank(a.stage) - stageRank(b.stage),
      render: (v: string) => <StageTag stage={v} />,
    },
    {
      title: '评分',
      dataIndex: 'score',
      width: 60,
      align: 'right',
      sorter: (a: any, b: any) => numRank(a.score) - numRank(b.score),
      render: (v: number) => (
        <span style={{ fontWeight: 600, color: v >= 70 ? 'var(--danger)' : 'var(--ui-text-2)' }}>{v}分</span>
      ),
    },
    {
      title: '预算',
      dataIndex: 'budget_level',
      width: 60,
      sorter: (a: any, b: any) => budgetRank(a.budget_level) - budgetRank(b.budget_level),
      render: (v: string) => (
        <Tag color={budgetColor[v] || 'default'} style={{ margin: 0 }}>
          {v || '未知'}
        </Tag>
      ),
    },
    {
      title: '意向产品',
      dataIndex: 'interest',
      ellipsis: true,
      render: (v: string) => <span style={{ color: 'var(--ui-text-2)' }}>{v || '-'}</span>,
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ===== 今日必跟：第一屏先回答「今天该跟谁」 ===== */}
      <GrowthTodayFocus
        onOpenLead={id => {
          if (id === -1) {
            kpiFilter({ sort: 'follow', hint: '台账已按「下次跟进时间」排序，最上方为最急迫客户' });
            return;
          }
          loadDetail(id);
        }}
      />
      {/* ===== 近期生日客户：低成本复购动作 ===== */}
      <BirthdayCare />
      {/* ===== KPI 行（逐卡可点：台账联动筛选 + 自动滚动定位）===== */}
      <Row gutter={[12, 12]}>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<UserAddOutlined />}
            color="var(--ui-accent)"
            label="今日新增线索"
            value={summary.todayNew ?? '-'}
            suffix="人"
            onClick={() => kpiFilter({ sort: 'created', hint: '台账已按「最新创建」排序，最上方即今日新增' })}
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<ClockCircleOutlined />}
            color="var(--warn)"
            label="待跟进客户"
            value={summary.pending ?? '-'}
            suffix="人"
            onClick={() => kpiFilter({ sort: 'follow', hint: '台账已按「下次跟进时间」排序，最上方为最急迫客户' })}
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<TeamOutlined />}
            color="var(--chart-3)"
            label="线索总池"
            value={summary.total ?? '-'}
            suffix="人"
            onClick={() => kpiFilter({ hint: '已清空筛选，展示全部线索池（按成交概率排序）' })}
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<CalendarOutlined />}
            color="var(--ui-muted)"
            label="已邀约"
            value={summary.invited ?? '-'}
            suffix="人"
            onClick={() =>
              kpiFilter({ stage: '已邀约', hint: '已筛选「已邀约」客户：跟进重点=确认到店（会前1天确认+当天提醒）' })
            }
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<ShopOutlined />}
            color="var(--chart-2)"
            label="已到店"
            value={summary.arrived ?? '-'}
            suffix="人"
            onClick={() => kpiFilter({ stage: '已到店', hint: '已筛选「已到店」客户：跟进重点=到店体验+方案促成' })}
          />
        </Col>
        <Col xs={12} md={8} xl={4}>
          <StatCard
            icon={<TrophyOutlined />}
            color="var(--danger)"
            label="已成交"
            value={summary.dealt ?? '-'}
            suffix="人"
            onClick={() =>
              kpiFilter({ stage: '已成交', hint: '已筛选「已成交」客户：进入复购经营（节日套餐/会员关怀）' })
            }
          />
        </Col>
      </Row>

      {Number(summary.importedOps?.rows || 0) > 0 && (
        <Alert
          type="info"
          showIcon
          message={`经营日报已同步 ${summary.importedOps.rows} 天（${summary.importedOps.startDate} 至 ${summary.importedOps.endDate}）`}
          description={`日报汇总：新增线索 ${summary.importedOps.newLeads}、邀约 ${summary.importedOps.invited}、到店 ${summary.importedOps.arrived}、成交 ${summary.importedOps.deals}。这里展示经营汇总；客户姓名、电话等明细需客户表成功导入后进入下方客户台账。`}
        />
      )}

      {/* ===== 第二行：来源分析 + 转化漏斗 + AI跟进建议 ===== */}
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={6}>
          <Panel title="线索来源分析" extra={<span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>线索数</span>}>
            <Chart
              height={262}
              option={{
                tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
                grid: { left: 8, right: 36, top: 8, bottom: 8, containLabel: true },
                xAxis: { type: 'value', ...axisStyle },
                yAxis: {
                  type: 'category',
                  data: srcSorted.map(s => s.source),
                  axisLabel: { color: 'var(--ui-text-2)', fontSize: 12 },
                  axisLine: { show: false },
                  axisTick: { show: false },
                },
                series: [
                  {
                    name: '线索数',
                    type: 'bar',
                    barWidth: 12,
                    data: srcSorted.map(s => s.n),
                    itemStyle: {
                      borderRadius: [0, 6, 6, 0],
                      color: (p: any) => CHART_COLORS[p.dataIndex % CHART_COLORS.length],
                    },
                    label: { show: true, position: 'right', color: 'var(--ui-text-2)', fontSize: 11 },
                  },
                ],
              }}
            />
          </Panel>
        </Col>
        <Col xs={24} lg={11}>
          <Panel
            title="客户转化漏斗"
            extra={<span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>点击层级可筛选下方台账</span>}
          >
            <Chart
              height={228}
              onClick={(p: any) => {
                setFStage(p.name);
                setPage(1);
                message.info(`线索台账已筛选至「${p.name}」阶段`);
              }}
              option={{
                tooltip: {
                  formatter: (p: any) => {
                    const f = funnel.funnel?.[p.dataIndex];
                    return `${p.name}：${p.value} 人<br/>层级转化率 ${f?.rate ?? '-'}%（基准 ${f?.baseline ?? '-'}%）`;
                  },
                },
                series: [
                  {
                    type: 'funnel',
                    left: 16,
                    right: 160,
                    top: 6,
                    bottom: 6,
                    gap: 4,
                    minSize: '24%',
                    label: {
                      show: true,
                      position: 'right',
                      color: 'var(--ui-text-2)',
                      fontSize: 12,
                      formatter: (p: any) => {
                        const f = funnel.funnel?.[p.dataIndex];
                        return `${p.name}  ${p.value}人${f?.rate != null ? `  转化率 ${f.rate}%` : ''}`;
                      },
                    },
                    itemStyle: { borderRadius: 4 },
                    color: CHART_COLORS,
                    data: (funnel.funnel || []).map((x: any) => ({ name: x.stage, value: x.count })),
                  },
                ],
              }}
            />
            {funnel.bottleneck && (
              <div
                style={{
                  background: 'var(--ui-surface)',
                  borderRadius: 8,
                  padding: '8px 12px',
                  fontSize: 12,
                  color: '#cf1322',
                }}
              >
                <AlertOutlined /> 当前卡点：「{funnel.bottleneck}」环节
                {bottleneckItem ? ` 转化率 ${bottleneckItem.rate}%，低于基准 ${bottleneckItem.baseline}%` : ' 低于基准'}
                ，建议优先安排跟进与邀约动作。
              </div>
            )}
          </Panel>
        </Col>
        <Col xs={24} lg={7}>
          <Panel
            title={
              <>
                <RobotOutlined style={{ color: 'var(--ui-accent)' }} /> AI跟进建议
              </>
            }
            extra={
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={aiLoading}
                onClick={() => confirmAiCharge('生成AI跟进建议？', fetchAiCard)}
              >
                换一批
              </Button>
            }
          >
            <Spin spinning={aiLoading}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 140 }}>
                {aiSugs.map((s, i) => (
                  <div
                    key={i}
                    style={{
                      background: 'var(--ui-surface-2)',
                      borderRadius: 8,
                      padding: '8px 12px',
                      display: 'flex',
                      gap: 8,
                    }}
                  >
                    <Avatar
                      size={20}
                      style={{
                        background: 'var(--ui-primary)',
                        color: 'var(--ui-on-primary)',
                        fontSize: 11,
                        flexShrink: 0,
                      }}
                    >
                      {i + 1}
                    </Avatar>
                    <Paragraph
                      copyable
                      style={{ margin: 0, fontSize: 12.5, color: 'var(--ui-text-2)', lineHeight: 1.7 }}
                    >
                      {s}
                    </Paragraph>
                  </div>
                ))}
                {!aiLoading && aiSugs.length === 0 && (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无建议，点击「换一批」生成" />
                )}
              </div>
            </Spin>
            <Divider style={{ margin: '10px 0' }} />
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ui-text)', marginBottom: 4 }}>
              <BulbOutlined style={{ color: 'var(--warn)' }} /> 建议优先跟进
            </div>
            {followUpList.map((c: any) => (
              <button
                type="button"
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                style={{
                  ...interactiveSurfaceStyle,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '5px 0',
                  cursor: 'pointer',
                  fontSize: 12.5,
                }}
              >
                <span style={{ color: 'var(--ui-text-2)' }}>
                  <span style={{ fontWeight: 600 }}>{c.name}</span> <GradeTag grade={c.grade} />
                </span>
                <span style={{ color: 'var(--ui-muted)', fontSize: 12 }}>
                  {c.score}分 <RightOutlined />
                </span>
              </button>
            ))}
            {followUpList.length === 0 && <div style={{ fontSize: 12, color: 'var(--ui-muted)' }}>暂无 A 类客户</div>}
          </Panel>
        </Col>
      </Row>

      {/* ===== 第三行：私域跟进工作台 ===== */}
      <Panel
        title={
          <>
            <MessageOutlined style={{ color: 'var(--chart-2)' }} /> 私域跟进工作台
          </>
        }
        extra={<span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>左侧=最近跟进队列；下方=自动分层客户池</span>}
      >
        <div
          style={{
            display: 'flex',
            border: '1px solid var(--ui-border)',
            borderRadius: 10,
            overflow: 'hidden',
            height: 520,
          }}
        >
          {/* 左：最近跟进队列 */}
          <div
            style={{
              width: 268,
              flexShrink: 0,
              borderRight: '1px solid var(--ui-border)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ padding: 10, borderBottom: '1px solid var(--ui-border)' }}>
              <Input
                allowClear
                size="small"
                prefix={<SearchOutlined style={{ color: 'var(--ui-muted)' }} />}
                placeholder="搜索客户"
                value={convKw}
                onChange={e => setConvKw(e.target.value)}
              />
              <div style={{ fontSize: 11, color: 'var(--ui-muted)', marginTop: 6 }}>
                按最近跟进时间排序，不等于重点客户来源
              </div>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 6 }}>
              {filteredConvs.map((c: any) => {
                const id = c.id ?? c.lead_id;
                const active = id === selectedId;
                return (
                  <button
                    type="button"
                    key={id}
                    onClick={() => setSelectedId(id)}
                    style={{
                      ...interactiveSurfaceStyle,
                      display: 'flex',
                      gap: 10,
                      padding: '10px 10px',
                      cursor: 'pointer',
                      borderRadius: 8,
                      marginBottom: 2,
                      background: active ? 'var(--ui-surface-2)' : 'transparent',
                      borderLeft: active ? '3px solid var(--ui-primary)' : '3px solid transparent',
                    }}
                  >
                    <Avatar
                      style={{
                        background: active ? 'var(--ui-primary)' : 'var(--ui-surface-2)',
                        color: active ? 'var(--ui-on-primary)' : 'var(--ui-accent)',
                        flexShrink: 0,
                      }}
                    >
                      {String(c.name || '?').slice(0, 1)}
                    </Avatar>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span
                          style={{
                            fontWeight: 600,
                            fontSize: 13,
                            color: 'var(--ui-text)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {c.name}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--ui-muted)', flexShrink: 0 }}>
                          {fmtTime(c.last_at || c.last_time || c.updated_at).slice(5)}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', marginTop: 3 }}>
                        <StageTag stage={c.stage} />
                        {Number(c.follow_count) > 0 && (
                          <Tag color="blue" style={{ fontSize: 10, lineHeight: '15px', marginLeft: 4 }}>
                            {c.follow_count}次
                          </Tag>
                        )}
                        <span
                          style={{
                            fontSize: 12,
                            color: 'var(--ui-muted)',
                            flex: 1,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {c.last_msg || c.last_content || c.last_follow || c.summary || '暂无跟进记录'}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: '#a6afbd', marginTop: 2 }}>
                        {c.last_user_name ? `最近跟进：${c.last_user_name}` : '尚未有人跟进'}
                      </div>
                    </div>
                  </button>
                );
              })}
              {filteredConvs.length === 0 && (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无客户记录" style={{ marginTop: 60 }} />
              )}
            </div>
          </div>

          {/* 中：沟通详情（跟进时间线 + 摘要录入） */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              borderRight: '1px solid var(--ui-border)',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--ui-surface)',
            }}
          >
            {detail ? (
              <>
                <div
                  style={{
                    padding: '10px 16px',
                    borderBottom: '1px solid var(--ui-border)',
                    background: 'var(--ui-surface)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flexShrink: 0,
                  }}
                >
                  <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--ui-text)' }}>{detail.name}</span>
                  {detail.identity_tag && (
                    <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>（{detail.identity_tag}）</span>
                  )}
                  <StageTag stage={detail.stage} />
                  {detail.grade && <GradeTag grade={detail.grade} />}
                  {selectedBuckets.map(b => (
                    <Tag key={b.key} color={b.color} style={{ margin: 0, fontSize: 11 }}>
                      {b.label}
                    </Tag>
                  ))}
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--ui-muted)' }}>
                    共 {follows.length} 条跟进记录
                  </span>
                </div>
                <div
                  style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}
                >
                  <Spin spinning={detailLoading}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      {follows.map((f: any) => (
                        <div key={f.id} style={{ display: 'flex', gap: 8 }}>
                          <Avatar
                            size={28}
                            style={{
                              background: 'var(--ui-surface-2)',
                              color: 'var(--ui-accent)',
                              fontSize: 12,
                              flexShrink: 0,
                            }}
                          >
                            {String(f.user_name || '未').slice(0, 1)}
                          </Avatar>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 11, color: 'var(--ui-muted)', marginBottom: 3 }}>
                              {f.user_name || '未知账号'} · {fmtTime(f.created_at)}
                              {f.stage_after && (
                                <Tag color="blue" style={{ fontSize: 10, lineHeight: '16px', marginLeft: 6 }}>
                                  推进至 {f.stage_after}
                                </Tag>
                              )}
                            </div>
                            <div
                              style={{
                                background: 'var(--ui-surface)',
                                border: '1px solid var(--ui-border)',
                                borderRadius: '2px 10px 10px 10px',
                                padding: '8px 12px',
                                fontSize: 12.5,
                                color: 'var(--ui-text-2)',
                                lineHeight: 1.7,
                                display: 'inline-block',
                              }}
                            >
                              {f.content}
                            </div>
                          </div>
                        </div>
                      ))}
                      {follows.length === 0 && (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description="暂无跟进记录，录入第一条吧"
                          style={{ marginTop: 60 }}
                        />
                      )}
                    </div>
                  </Spin>
                </div>
                {wbSugs.length > 0 && (
                  <div
                    style={{
                      background: 'var(--ui-surface-2)',
                      borderRadius: 8,
                      padding: '8px 12px',
                      margin: '8px 12px 0',
                      flexShrink: 0,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: 12,
                        fontWeight: 600,
                        color: 'var(--ui-accent)',
                        marginBottom: 2,
                      }}
                    >
                      <span>
                        <RobotOutlined /> AI话术推荐（复制后发到微信/企微）
                      </span>
                      <button
                        type="button"
                        className="ui-link-button"
                        style={{ fontSize: 11 }}
                        onClick={() => setWbSugs([])}
                      >
                        收起
                      </button>
                    </div>
                    {wbSugs.map((s, i) => (
                      <Paragraph
                        key={i}
                        copyable
                        style={{ margin: '4px 0', fontSize: 12, color: 'var(--ui-text-2)', lineHeight: 1.6 }}
                      >
                        {i + 1}. {s}
                      </Paragraph>
                    ))}
                  </div>
                )}
                <div
                  style={{
                    borderTop: '1px solid var(--ui-border)',
                    padding: 12,
                    background: 'var(--ui-surface)',
                    flexShrink: 0,
                    marginTop: 8,
                  }}
                >
                  <Input.TextArea
                    rows={2}
                    value={followText}
                    onChange={e => setFollowText(e.target.value)}
                    placeholder="把微信/企微/电话沟通后的结果写在这里，例如：客户对价格有顾虑，约下周二到店试吃…"
                    style={{ marginBottom: 8 }}
                  />
                  <Row gutter={8} style={{ marginBottom: 8 }}>
                    <Col xs={24} md={8}>
                      <DatePicker
                        size="small"
                        value={followNextAt}
                        onChange={setFollowNextAt}
                        style={{ width: '100%' }}
                        placeholder="下次跟进日期"
                      />
                    </Col>
                    <Col xs={24} md={16}>
                      <Input
                        size="small"
                        value={followNextAction}
                        onChange={e => setFollowNextAction(e.target.value)}
                        placeholder="下次动作，如 发方案 / 约试吃 / 老板介入"
                      />
                    </Col>
                  </Row>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <Space size={8} wrap>
                      <Button
                        size="small"
                        icon={<RobotOutlined />}
                        loading={wbAiLoading}
                        onClick={() =>
                          confirmAiCharge('生成可复制私域话术？', () =>
                            fetchWbSuggest('根据当前客户画像、分层标签和最近沟通记录，生成可复制的私域回复话术'),
                          )
                        }
                      >
                        生成可复制话术
                      </Button>
                      <Button
                        size="small"
                        icon={<CalendarOutlined />}
                        loading={wbAiLoading}
                        onClick={() =>
                          confirmAiCharge('生成下月邀约话术？', () =>
                            fetchWbSuggest(
                              '根据客户画像、入选分层、最近聊天和活动记录，生成下个月主题试吃、会员活动或到店邀约话术，重点说明活动信息与预约方式，不制造名额紧张',
                            ),
                          )
                        }
                      >
                        下月邀约话术
                      </Button>
                      <Button size="small" icon={<RightOutlined />} onClick={() => openAdvance(detail)}>
                        推进阶段
                      </Button>
                    </Space>
                    <Button
                      size="small"
                      type="primary"
                      icon={<SendOutlined />}
                      loading={savingFollow}
                      onClick={saveFollow}
                    >
                      保存跟进
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择左侧客户" style={{ margin: 'auto' }} />
            )}
          </div>

          {/* 右：客户画像卡 */}
          <div style={{ width: 312, flexShrink: 0, overflow: 'auto', padding: 14 }}>
            {detail ? (
              <Spin spinning={detailLoading}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <Avatar
                    size={42}
                    style={{ background: 'var(--ui-primary)', color: 'var(--ui-on-primary)', flexShrink: 0 }}
                  >
                    {String(detail.name || '?').slice(0, 1)}
                  </Avatar>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ui-text)' }}>{detail.name}</div>
                    <div style={{ marginTop: 2 }}>
                      {detail.grade && <GradeTag grade={detail.grade} />}
                      <StageTag stage={detail.stage} />
                    </div>
                  </div>
                  <span style={{ marginLeft: 'auto', textAlign: 'center' }}>
                    <div
                      style={{
                        fontSize: 20,
                        fontWeight: 700,
                        color: (detail.score ?? 0) >= 70 ? 'var(--danger)' : 'var(--ui-accent)',
                      }}
                    >
                      {detail.score ?? '-'}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--ui-muted)' }}>意向评分</div>
                  </span>
                </div>
                <div style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '8px 12px' }}>
                  <InfoRow label="身份" value={detail.identity_tag} />
                  <InfoRow
                    label="预算"
                    value={
                      detail.budget_level && (
                        <Tag color={budgetColor[detail.budget_level] || 'default'} style={{ margin: 0 }}>
                          {detail.budget_level}
                        </Tag>
                      )
                    }
                  />
                  <InfoRow label="意向产品" value={detail.interest} />
                  <InfoRow label="公司" value={detail.company} />
                  <InfoRow label="来源" value={detail.source} />
                  <InfoRow label="负责人" value={detail.owner_name} />
                </div>

                <SectionTitle>跟进备份</SectionTitle>
                <div
                  style={{
                    background: 'var(--ui-surface-2)',
                    border: '1px solid var(--ui-border)',
                    borderRadius: 8,
                    padding: '8px 10px',
                    fontSize: 12,
                  }}
                >
                  {detail.follow_stats?.total ? (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ color: 'var(--ui-text-2)' }}>
                          累计跟进 <b style={{ color: 'var(--ui-text)' }}>{detail.follow_stats.total}</b> 次
                        </span>
                        <span style={{ color: 'var(--ui-text-2)' }}>{detail.follow_stats.user_count} 个账号参与</span>
                      </div>
                      {(detail.follow_stats.followers || []).map((u: any) => (
                        <div
                          key={`${u.user_id || 'x'}-${u.name}`}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            padding: '3px 0',
                            color: 'var(--ui-text-2)',
                          }}
                        >
                          <span>{u.name}</span>
                          <span>
                            {u.follow_count}次 · 最近 {fmtTime(u.last_at).slice(5)}
                          </span>
                        </div>
                      ))}
                    </>
                  ) : (
                    <div style={{ color: 'var(--ui-muted)' }}>还没有跟进备份，保存第一条跟进后会记录当前账号。</div>
                  )}
                </div>

                <SectionTitle>入选逻辑</SectionTitle>
                {selectedBuckets.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {selectedBuckets.map(b => (
                      <div
                        key={b.key}
                        style={{
                          background: 'var(--ui-surface)',
                          border: '1px solid var(--ui-border)',
                          borderRadius: 6,
                          padding: '6px 8px',
                          fontSize: 12,
                        }}
                      >
                        <Tag color={b.color} style={{ marginBottom: 4 }}>
                          {b.label}
                        </Tag>
                        <div style={{ color: 'var(--ui-text-2)', lineHeight: 1.5 }}>{b.reason}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--ui-muted)',
                      background: 'var(--ui-surface-2)',
                      borderRadius: 6,
                      padding: '6px 8px',
                    }}
                  >
                    当前未命中 A类客户 / 即将成交 / 建议老板介入，可继续记录跟进或推进阶段后自动重算。
                  </div>
                )}

                {journey && (
                  <>
                    <SectionTitle>
                      客户生命周期（{journey.current} · 第{(journey.journey || []).filter((j: any) => j.reached).length}
                      /11节点 · 已{journey.totalDays}天）
                    </SectionTitle>
                    <div
                      style={{
                        background: 'var(--ui-surface-2)',
                        border: '1px solid var(--ui-border)',
                        borderRadius: 8,
                        padding: '10px 12px',
                        maxHeight: 260,
                        overflow: 'auto',
                      }}
                    >
                      {(journey.journey || []).map((j: any, i: number) => {
                        const isCurrent = j.node === journey.current;
                        return (
                          <div key={j.node} style={{ display: 'flex', gap: 8, position: 'relative' }}>
                            <div
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                width: 14,
                                flexShrink: 0,
                              }}
                            >
                              <span
                                style={{
                                  width: 12,
                                  height: 12,
                                  borderRadius: 7,
                                  marginTop: 3,
                                  flexShrink: 0,
                                  fontSize: 8,
                                  lineHeight: '12px',
                                  textAlign: 'center',
                                  color: isCurrent ? 'var(--ui-on-primary)' : '#fff',
                                  background: j.reached
                                    ? isCurrent
                                      ? 'var(--ui-primary)'
                                      : 'var(--chart-2)'
                                    : 'var(--ui-surface)',
                                  boxShadow: isCurrent ? '0 0 0 3px var(--ui-primary-soft)' : 'none',
                                }}
                              >
                                {j.reached ? '✓' : ''}
                              </span>
                              {i < 10 && (
                                <span
                                  style={{
                                    width: 2,
                                    flex: 1,
                                    minHeight: 10,
                                    background: j.reached ? 'var(--ui-surface)' : 'var(--ui-border)',
                                  }}
                                />
                              )}
                            </div>
                            <div style={{ flex: 1, paddingBottom: 8, minWidth: 0 }}>
                              <div
                                style={{
                                  fontSize: 12,
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  flexWrap: 'wrap',
                                }}
                              >
                                <span
                                  style={{
                                    fontWeight: isCurrent ? 700 : j.reached ? 600 : 400,
                                    color: isCurrent
                                      ? 'var(--ui-accent)'
                                      : j.reached
                                        ? 'var(--ui-text)'
                                        : 'var(--ui-muted)',
                                  }}
                                >
                                  {j.node}
                                </span>
                                {isCurrent && (
                                  <Tag
                                    color="blue"
                                    style={{ margin: 0, fontSize: 10, lineHeight: '15px', padding: '0 4px' }}
                                  >
                                    当前
                                  </Tag>
                                )}
                                {j.at && (
                                  <span style={{ fontSize: 10.5, color: 'var(--ui-muted)' }}>
                                    {String(j.at).slice(0, 10)}
                                  </span>
                                )}
                                {j.reached && j.stayDays != null && j.stayDays > 0 && !isCurrent && (
                                  <span style={{ fontSize: 10.5, color: '#cbb887' }}>停留{j.stayDays}天</span>
                                )}
                                {j.inferred && <span style={{ fontSize: 10, color: 'var(--ui-muted)' }}>(推导)</span>}
                              </div>
                              {j.note && (
                                <div
                                  style={{
                                    fontSize: 11,
                                    color: 'var(--ui-muted)',
                                    marginTop: 1,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                  title={`${j.note}${j.by ? `｜经办：${j.by}` : ''}`}
                                >
                                  {j.note}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {journey.nextHint && (
                      <div
                        style={{
                          marginTop: 6,
                          fontSize: 11.5,
                          color: 'var(--ui-accent)',
                          background: 'var(--ui-surface)',
                          borderRadius: 6,
                          padding: '5px 8px',
                        }}
                      >
                        💡 下一步：{journey.nextHint}
                      </div>
                    )}
                  </>
                )}

                {scoreEntries.length > 0 && (
                  <>
                    <SectionTitle>评分构成</SectionTitle>
                    {scoreEntries.map(([k, v]) => (
                      <div
                        key={k}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '3px 0' }}
                      >
                        <span style={{ color: 'var(--ui-muted)', width: 62, flexShrink: 0 }}>{k}</span>
                        <Progress
                          percent={Math.round(((Number(v) || 0) / maxDim) * 100)}
                          showInfo={false}
                          size="small"
                          strokeColor="var(--ui-accent)"
                          style={{ flex: 1 }}
                        />
                        <span style={{ color: 'var(--ui-text)', fontWeight: 600, width: 34, textAlign: 'right' }}>
                          {String(v)}分
                        </span>
                      </div>
                    ))}
                  </>
                )}

                <SectionTitle>
                  客户顾虑（{(detail.concerns || []).filter((c: any) => !c.resolved).length} 条未解决）
                </SectionTitle>
                {(detail.concerns || []).map((c: any, i: number) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12,
                      padding: '5px 8px',
                      marginBottom: 4,
                      background: c.resolved ? 'var(--ui-surface)' : 'var(--ui-warning-surface)',
                      borderRadius: 6,
                    }}
                  >
                    <span
                      style={{
                        flex: 1,
                        color: c.resolved ? 'var(--ui-muted)' : '#e0a253',
                        textDecoration: c.resolved ? 'line-through' : 'none',
                      }}
                    >
                      {c.text}
                    </span>
                    {c.resolved ? (
                      <Tag color="green" style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>
                        已解决
                      </Tag>
                    ) : (
                      <button
                        type="button"
                        className="ui-link-button"
                        style={{ fontSize: 11, flexShrink: 0 }}
                        onClick={() => resolveObjection(i)}
                      >
                        标记解决
                      </button>
                    )}
                  </div>
                ))}
                {(detail.concerns || []).length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--ui-muted)' }}>暂未记录顾虑</div>
                )}
                <Input.Search
                  size="small"
                  placeholder="记录新顾虑，AI生成应对话术"
                  value={objText}
                  loading={objLoading}
                  onChange={e => setObjText(e.target.value)}
                  onSearch={addObjection}
                  enterButton={
                    <span>
                      <RobotOutlined /> AI应对
                    </span>
                  }
                  style={{ marginTop: 6 }}
                />

                {(detail.next_follow_at || detail.next_action) && (
                  <div
                    style={{
                      background: 'var(--ui-surface-2)',
                      borderRadius: 8,
                      padding: '8px 12px',
                      marginTop: 12,
                      fontSize: 12,
                    }}
                  >
                    <div style={{ color: 'var(--ui-muted)' }}>
                      <ClockCircleOutlined /> 下次跟进
                    </div>
                    <div style={{ color: 'var(--ui-text)', fontWeight: 600, marginTop: 2 }}>
                      {detail.next_follow_at ? String(detail.next_follow_at).slice(0, 10) : ''}{' '}
                      {detail.next_action || ''}
                    </div>
                  </div>
                )}

                <Button
                  type="primary"
                  block
                  icon={<RightOutlined />}
                  style={{ marginTop: 14 }}
                  onClick={() => openAdvance(detail)}
                >
                  阶段推进
                </Button>
              </Spin>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择客户后查看画像" style={{ marginTop: 120 }} />
            )}
          </div>
        </div>
      </Panel>

      {/* ===== 本月已沟通客户总表：老板/上级查看与导出 ===== */}
      <Panel
        title="本月已沟通客户"
        extra={
          <Space size={8}>
            <Tag color="blue">客户 {followReport.summary?.communicatedCustomers || 0}</Tag>
            <Tag color="green">记录 {followReport.summary?.followRecords || 0}</Tag>
            <Tag color="purple">账号 {followReport.summary?.activeStaff || 0}</Tag>
            <Button size="small" icon={<ReloadOutlined />} onClick={loadFollowReport}>
              刷新
            </Button>
            <Button
              size="small"
              type="primary"
              ghost
              icon={<DownloadOutlined />}
              onClick={() => {
                exportFollowReport().catch(() => message.error('导出组件加载失败，请检查网络后重试'));
              }}
            >
              导出表格
            </Button>
          </Space>
        }
      >
        <Row gutter={[12, 12]} style={{ marginBottom: 10 }}>
          {(followReport.staff || []).slice(0, 4).map((s: any) => (
            <Col xs={12} md={6} key={s.name}>
              <div
                style={{
                  background: 'var(--ui-surface)',
                  border: '1px solid var(--ui-surface)',
                  borderRadius: 8,
                  padding: '8px 10px',
                }}
              >
                <div style={{ fontSize: 12, color: 'var(--ui-text-2)' }}>{s.name}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ui-text)' }}>
                  {s.follow_count}次{' '}
                  <span style={{ fontSize: 11, color: 'var(--ui-muted)', fontWeight: 400 }}>
                    覆盖{s.customer_count}人
                  </span>
                </div>
              </div>
            </Col>
          ))}
          {(followReport.staff || []).length === 0 && (
            <Col span={24}>
              <div style={{ fontSize: 12, color: 'var(--ui-muted)' }}>
                本月暂无沟通记录，员工保存跟进后这里会自动出现。
              </div>
            </Col>
          )}
        </Row>
        <Space wrap size={8} style={{ marginBottom: 12 }}>
          <Input.Search
            allowClear
            placeholder="搜索客户/内容/建议"
            size="small"
            style={{ width: 190 }}
            value={reportKw}
            onChange={e => setReportKw(e.target.value)}
            onSearch={setReportKw}
          />
          <Select
            allowClear
            placeholder="阶段"
            size="small"
            style={{ width: 112 }}
            value={reportStage}
            onChange={setReportStage}
            options={STAGES.map(s => ({ value: s, label: s }))}
          />
          <Select
            allowClear
            showSearch
            placeholder="账号"
            size="small"
            style={{ width: 112 }}
            value={reportOwner}
            onChange={setReportOwner}
            options={followReportOwnerOptions}
            optionFilterProp="label"
          />
          <Select
            allowClear
            placeholder="下次跟进"
            size="small"
            style={{ width: 126 }}
            value={reportNextStatus}
            onChange={setReportNextStatus}
            options={[
              { value: 'hasNext', label: '已设置下次' },
              { value: 'noNext', label: '未设置下次' },
              { value: 'overdue', label: '已超期' },
            ]}
          />
          <Select
            size="small"
            style={{ width: 144 }}
            value={reportSort}
            onChange={setReportSort}
            options={[
              { value: 'lastFollow', label: '最近沟通优先' },
              { value: 'monthCount', label: '本月次数最多' },
              { value: 'totalCount', label: '累计次数最多' },
              { value: 'nextFollow', label: '下次跟进最近' },
              { value: 'score', label: '评分高到低' },
              { value: 'name', label: '客户名排序' },
            ]}
          />
          <Tag color="blue">显示 {filteredFollowRows.length}</Tag>
          <Button size="small" onClick={resetReportFilters}>
            清空筛选
          </Button>
        </Space>
        <Table
          size="small"
          rowKey="id"
          loading={followReportLoading}
          dataSource={filteredFollowRows}
          scroll={{ x: 1180 }}
          pagination={{ pageSize: 6, size: 'small', showSizeChanger: false }}
          columns={
            [
              {
                title: '客户',
                dataIndex: 'name',
                width: 110,
                fixed: 'left',
                sorter: (a: any, b: any) => textRank(a.name).localeCompare(textRank(b.name), 'zh-Hans-CN'),
                render: (v: string, r: any) => (
                  <button type="button" className="ui-link-button" onClick={() => setSelectedId(r.id)}>
                    {v} <GradeTag grade={r.grade} />
                  </button>
                ),
              },
              {
                title: '阶段',
                dataIndex: 'stage',
                width: 84,
                sorter: (a: any, b: any) => stageRank(a.stage) - stageRank(b.stage),
                render: (v: string) => <StageTag stage={v} />,
              },
              {
                title: '负责人',
                dataIndex: 'owner_name',
                width: 82,
                sorter: (a: any, b: any) => textRank(a.owner_name).localeCompare(textRank(b.owner_name), 'zh-Hans-CN'),
                render: (v: string) => v || '-',
              },
              {
                title: '沟通次数',
                key: 'counts',
                width: 96,
                sorter: (a: any, b: any) => numRank(a.month_follow_count) - numRank(b.month_follow_count),
                render: (_: any, r: any) => (
                  <span>
                    {r.month_follow_count || 0}次{' '}
                    <span style={{ color: 'var(--ui-muted)', fontSize: 11 }}>累计{r.total_follow_count || 0}</span>
                  </span>
                ),
              },
              {
                title: '最近跟进',
                key: 'last',
                width: 250,
                sorter: (a: any, b: any) => dateRank(a.last_follow_at).localeCompare(dateRank(b.last_follow_at)),
                render: (_: any, r: any) => (
                  <div>
                    <div style={{ fontSize: 12 }}>
                      {r.last_follower_name || '-'} · {fmtTime(r.last_follow_at)}
                    </div>
                    <div
                      style={{
                        color: 'var(--ui-muted)',
                        fontSize: 11,
                        maxWidth: 230,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={r.last_content || ''}
                    >
                      {r.last_content || '-'}
                    </div>
                  </div>
                ),
              },
              {
                title: 'AI建议',
                dataIndex: 'last_ai_suggestion',
                width: 220,
                sorter: (a: any, b: any) => numRank(a.ai_suggestion_count) - numRank(b.ai_suggestion_count),
                render: (v: string) =>
                  v ? (
                    <span title={v}>
                      {String(v).replace(/\n/g, ' ').slice(0, 38)}
                      {String(v).length > 38 ? '…' : ''}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--ui-muted)' }}>未生成</span>
                  ),
              },
              {
                title: '下次跟进',
                key: 'next',
                width: 150,
                sorter: (a: any, b: any) =>
                  dateRank(a.next_follow_at || '9999-12-31').localeCompare(dateRank(b.next_follow_at || '9999-12-31')),
                render: (_: any, r: any) =>
                  r.next_follow_at || r.next_action ? (
                    <div>
                      <div style={{ fontSize: 12 }}>{r.next_follow_at || '-'}</div>
                      <div style={{ fontSize: 11, color: 'var(--ui-muted)' }}>{r.next_action || '-'}</div>
                    </div>
                  ) : (
                    <span style={{ color: 'var(--ui-muted)' }}>未设置</span>
                  ),
              },
              {
                title: '参与账号',
                dataIndex: 'follower_names',
                width: 130,
                sorter: (a: any, b: any) =>
                  textRank(a.follower_names).localeCompare(textRank(b.follower_names), 'zh-Hans-CN'),
                render: (v: string) => v || '-',
              },
            ] as any
          }
        />
      </Panel>

      {/* ===== 底部：重点客户列表 + 客户线索台账 ===== */}
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={9}>
          <Panel title="重点客户列表" bodyStyle={{ paddingTop: 8 }}>
            <Tabs
              size="small"
              activeKey={kcTab}
              onChange={setKcTab}
              items={[
                { key: 'aList', label: `A类客户 ${(keyCust.aList || []).length}` },
                { key: 'closing', label: `即将成交 ${(keyCust.closing || []).length}` },
                { key: 'bossList', label: `建议老板介入 ${(keyCust.bossList || []).length}` },
              ]}
            />
            <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', margin: '-4px 0 8px', lineHeight: 1.6 }}>
              分层口径：A类=评分≥70；即将成交=评分≥80或已到店且预算高/中；老板介入=A类且高预算。
            </div>
            <Space wrap size={8} style={{ marginBottom: 10 }}>
              <Input.Search
                allowClear
                placeholder="搜客户/产品"
                size="small"
                style={{ width: 132 }}
                value={keyKw}
                onChange={e => setKeyKw(e.target.value)}
                onSearch={setKeyKw}
              />
              <Select
                allowClear
                placeholder="阶段"
                size="small"
                style={{ width: 104 }}
                value={keyStage}
                onChange={setKeyStage}
                options={STAGES.map(s => ({ value: s, label: s }))}
              />
              <Select
                allowClear
                placeholder="预算"
                size="small"
                style={{ width: 82 }}
                value={keyBudget}
                onChange={setKeyBudget}
                options={BUDGETS.map(b => ({ value: b, label: b }))}
              />
              <Select
                size="small"
                style={{ width: 122 }}
                value={keySort}
                onChange={setKeySort}
                options={[
                  { value: 'scoreDesc', label: '评分高到低' },
                  { value: 'scoreAsc', label: '评分低到高' },
                  { value: 'budget', label: '预算高优先' },
                  { value: 'stage', label: '阶段排序' },
                  { value: 'name', label: '客户名排序' },
                ]}
              />
              <Button size="small" onClick={resetKeyFilters}>
                清空
              </Button>
            </Space>
            <Table
              size="small"
              rowKey="id"
              columns={kcCols}
              dataSource={filteredKeyRows}
              pagination={{ pageSize: 8, size: 'small', showSizeChanger: false }}
              onRow={(r: any) => ({ onClick: () => setSelectedId(r.id), style: { cursor: 'pointer' } })}
            />
          </Panel>
        </Col>
        <Col xs={24} lg={15}>
          <Panel
            title="客户线索台账"
            extra={
              <Space>
                <Button size="small" icon={<DownloadOutlined />} loading={exportingLeads} onClick={exportLeads}>
                  导出 Excel
                </Button>
                <Button size="small" icon={<InboxOutlined />} onClick={openBatch}>
                  批量导入线索
                </Button>
                <Button
                  size="small"
                  icon={<UploadOutlined />}
                  onClick={() => {
                    reportForm.resetFields();
                    setReportOpen(true);
                  }}
                >
                  今日数据上报
                </Button>
                <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openAdd}>
                  新增线索
                </Button>
              </Space>
            }
          >
            <div ref={tableRef} />
            <Space wrap size={8} style={{ marginBottom: 12 }}>
              <Select
                allowClear
                placeholder="阶段"
                size="small"
                style={{ width: 104 }}
                value={fStage}
                onChange={v => {
                  setFStage(v);
                  setPage(1);
                }}
                options={STAGES.map(s => ({ value: s, label: s }))}
              />
              <Select
                allowClear
                placeholder="等级"
                size="small"
                style={{ width: 90 }}
                value={fGrade}
                onChange={v => {
                  setFGrade(v);
                  setPage(1);
                }}
                options={GRADES.map(g => ({ value: g, label: `${g}级` }))}
              />
              <Select
                allowClear
                placeholder="来源"
                size="small"
                style={{ width: 104 }}
                value={fSource}
                onChange={v => {
                  setFSource(v);
                  setPage(1);
                }}
                options={SOURCES.map(s => ({ value: s, label: s }))}
              />
              <Select
                allowClear
                placeholder="跟进状态"
                size="small"
                style={{ width: 112 }}
                value={fFollowStatus}
                onChange={v => {
                  setFFollowStatus(v);
                  setPage(1);
                }}
                options={[
                  { value: 'followed', label: '已跟进' },
                  { value: 'unfollowed', label: '未跟进' },
                  { value: 'next', label: '有下次跟进' },
                  { value: 'overdue', label: '已超期' },
                ]}
              />
              <Select
                size="small"
                style={{ width: 132 }}
                value={sort}
                onChange={v => {
                  setSort(v);
                  setPage(1);
                }}
                options={[
                  { value: 'score', label: '评分高到低' },
                  { value: 'scoreAsc', label: '评分低到高' },
                  { value: 'created', label: '最新创建' },
                  { value: 'follow', label: '下次跟进最近' },
                  { value: 'followCount', label: '跟进次数最多' },
                  { value: 'lastFollow', label: '最近沟通优先' },
                  { value: 'budget', label: '预算高优先' },
                  { value: 'source', label: '来源排序' },
                  { value: 'stage', label: '阶段排序' },
                  { value: 'name', label: '客户名排序' },
                ]}
              />
              <Input.Search
                allowClear
                placeholder="姓名/电话/公司"
                size="small"
                style={{ width: 180 }}
                value={kw}
                onChange={e => setKw(e.target.value)}
                onSearch={v => {
                  setKw(v);
                  setPage(1);
                }}
              />
              <Button size="small" onClick={resetLedgerFilters}>
                清空筛选
              </Button>
            </Space>
            <Table
              size="small"
              rowKey="id"
              loading={tableLoading}
              columns={ledgerCols}
              dataSource={rows}
              scroll={{ x: 1060 }}
              onChange={handleLedgerTableChange}
              pagination={{
                current: page,
                pageSize: size,
                total,
                size: 'small',
                showSizeChanger: false,
                showTotal: t => `共 ${t} 条`,
                onChange: p => setPage(p),
              }}
            />
          </Panel>
        </Col>
      </Row>

      {/* ===== Modal：阶段推进 ===== */}
      <Modal
        title={`阶段推进${advLead ? ` · ${advLead.name}（当前：${advLead.stage}）` : ''}`}
        open={advOpen}
        forceRender
        onCancel={() => setAdvOpen(false)}
        onOk={submitAdvance}
        confirmLoading={advSaving}
        okText="确认推进"
        cancelText="取消"
      >
        <Form form={advForm} layout="vertical">
          <Form.Item name="stage" label="目标阶段" rules={[{ required: true, message: '请选择目标阶段' }]}>
            <Select
              placeholder="选择推进到的阶段"
              options={STAGES.filter(s => s !== advLead?.stage).map(s => ({ value: s, label: s }))}
            />
          </Form.Item>
          <Form.Item name="note" label="推进说明" rules={[{ required: true, message: '推进必须填写说明' }]}>
            <Input.TextArea rows={3} placeholder="本次推进依据 / 沟通要点（必填）" />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, c) => p.stage !== c.stage}>
            {({ getFieldValue }) => {
              const st = getFieldValue('stage');
              return (
                <>
                  {(st === '已成交' || st === '复购') && (
                    <>
                      <Form.Item
                        name="deal_amount"
                        label="成交金额（元）"
                        rules={st === '已成交' ? [{ required: true, message: '成交必须填写成交金额' }] : []}
                      >
                        <InputNumber style={{ width: '100%' }} min={0} placeholder="如 56800" />
                      </Form.Item>
                      <Form.Item name="deal_reason" label="成交原因">
                        <Input placeholder="如 主题试吃现场转化 / 老客转介绍" />
                      </Form.Item>
                    </>
                  )}
                  {st === '已流失' && (
                    <Form.Item
                      name="lost_reason"
                      label="流失原因"
                      rules={[{ required: true, message: '流失必须填写流失原因' }]}
                    >
                      <Input placeholder="如 价格顾虑未解决 / 选择竞品" />
                    </Form.Item>
                  )}
                </>
              );
            }}
          </Form.Item>
        </Form>
      </Modal>

      {/* ===== Modal：新增线索 ===== */}
      {/* 员工每日数据上报：累加进经营数据表，总控台/分析/周报全联动（PRD V2 §17） */}
      <Modal
        title="今日数据上报（员工口子）"
        open={reportOpen}
        forceRender
        width={520}
        onCancel={() => setReportOpen(false)}
        okText="提交上报"
        cancelText="取消"
        confirmLoading={reportSaving}
        onOk={async () => {
          const v = await reportForm.validateFields();
          setReportSaving(true);
          try {
            const res = await api.post('/growth/daily-report', v);
            message.success(res.msg || '上报成功');
            setReportOpen(false);
            loadSummary();
            loadLeads();
          } catch {
            /* client已toast */
          } finally {
            setReportSaving(false);
          }
        }}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="仅上报无明细来源的四项（线索/邀约/到店/内容数）；成交与复购金额随客户阶段推进自动归集，无需也不可二次上报"
        />
        <Form form={reportForm} layout="vertical">
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="new_leads" label="新增线索数">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="invited" label="邀约人数">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="arrived" label="到店人数">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="content_count" label="内容发布数">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* ===== Modal：批量导入线索 ===== */}
      <Modal
        open={batchOpen}
        width={760}
        footer={null}
        onCancel={() => {
          setBatchOpen(false);
          setBatchRows([]);
          setBatchPaste('');
          setBatchResult(null);
        }}
        title={
          <>
            <InboxOutlined style={{ color: 'var(--ui-accent)' }} /> 批量导入线索（文件 / 粘贴）
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Alert
            type="info"
            showIcon
            message={
              <span>
                表头至少包含 <b>客户姓名</b>；可选列：
                <b>手机 / 微信 / 来源 / 身份 / 意向产品 / 预算 / 阶段 / 公司 / 区域 / 下次跟进 / 下次动作 / 备注</b>。
              </span>
            }
          />
          <label
            htmlFor="growth-lead-batch-file"
            style={{
              display: 'block',
              width: '100%',
              border: '1.5px dashed #d1d1d1',
              borderRadius: 8,
              padding: '18px 12px',
              textAlign: 'center',
              cursor: 'pointer',
              background: 'var(--ui-surface)',
            }}
          >
            <InboxOutlined style={{ fontSize: 30, color: 'var(--ui-accent)' }} />
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ui-text)', marginTop: 6 }}>
              选择 Excel(.xlsx/.xls) / CSV 文件
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', marginTop: 2 }}>
              员工导入后默认归属本人；同手机号会自动更新原线索
            </div>
            <input
              id="growth-lead-batch-file"
              type="file"
              accept=".xlsx,.xls,.csv"
              style={{ display: 'none' }}
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) parseLeadFile(f);
                (e.target as HTMLInputElement).value = '';
              }}
            />
          </label>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ui-text)', marginBottom: 6 }}>
              或：从 Excel 直接复制粘贴（含表头）
            </div>
            <Input.TextArea
              rows={4}
              value={batchPaste}
              onChange={e => parseLeadPaste(e.target.value)}
              placeholder={
                '客户姓名\t手机\t来源\t身份\t意向产品\t预算\t下次跟进\t备注\n王建国\t13800000000\t主题试吃\t企业客户\t企业团餐\t高\t2026-06-25\t已约到店沟通'
              }
            />
          </div>
          {batchRows.length > 0 && (
            <>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ui-text)' }}>
                预览（{batchRows.length} 条）
              </div>
              <Table
                size="small"
                rowKey={(_, i) => String(i)}
                dataSource={batchRows}
                pagination={{ pageSize: 5, size: 'small' }}
                scroll={{ x: 980 }}
                columns={[
                  { title: '客户姓名', dataIndex: 'name', width: 96, render: (v: any) => <b>{v}</b> },
                  { title: '手机', dataIndex: 'phone', width: 112, render: (v: any) => v || '-' },
                  { title: '来源', dataIndex: 'source', width: 82 },
                  { title: '身份', dataIndex: 'identity_tag', width: 96 },
                  { title: '预算', dataIndex: 'budget_level', width: 64 },
                  { title: '阶段', dataIndex: 'stage', width: 82, render: (v: any) => <StageTag stage={v} /> },
                  {
                    title: '意向产品',
                    dataIndex: 'interest',
                    width: 130,
                    ellipsis: true,
                    render: (v: any) => v || '-',
                  },
                  { title: '下次跟进', dataIndex: 'next_follow_at', width: 104, render: (v: any) => v || '-' },
                  { title: '备注', dataIndex: 'note', ellipsis: true, render: (v: any) => v || '-' },
                  {
                    title: '',
                    width: 46,
                    fixed: 'right',
                    render: (_: any, __: any, i: number) => (
                      <button
                        type="button"
                        className="ui-link-button"
                        onClick={() => setBatchRows(prev => prev.filter((_x, j) => j !== i))}
                      >
                        删
                      </button>
                    ),
                  },
                ]}
              />
              <Button type="primary" block loading={batchSubmitting} onClick={submitLeadBatch}>
                确认导入 {batchRows.length} 条线索
              </Button>
            </>
          )}
          {batchResult && (
            <Alert
              type={batchResult.errors?.length || batchResult.skipped?.length ? 'warning' : 'success'}
              showIcon
              message={`导入完成：新增 ${batchResult.created?.length || 0} 条，更新 ${batchResult.updated?.length || 0} 条`}
              description={
                [
                  batchResult.skipped?.length ? `跳过 ${batchResult.skipped.length} 条（客户姓名为空）` : '',
                  batchResult.errors?.length ? `失败 ${batchResult.errors.length} 条，请检查表格内容后重试` : '',
                ]
                  .filter(Boolean)
                  .join('；') || '线索台账与增长统计已刷新'
              }
            />
          )}
        </div>
      </Modal>

      <Modal
        title="新增线索"
        open={addOpen}
        forceRender
        width={620}
        onCancel={() => setAddOpen(false)}
        onOk={submitAdd}
        confirmLoading={addSaving}
        okText="保存"
        cancelText="取消"
      >
        <Form form={addForm} layout="vertical">
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="name" label="客户姓名" rules={[{ required: true, message: '请填写客户姓名' }]}>
                <Input placeholder="如 王建国" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="phone" label="电话">
                <Input placeholder="手机号" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="source" label="来源渠道">
                <Select allowClear placeholder="选择来源" options={SOURCES.map(s => ({ value: s, label: s }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="identity_tag" label="身份">
                <Select allowClear placeholder="选择身份" options={identities.map(s => ({ value: s, label: s }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="budget_level" label="预算等级">
                <Select allowClear placeholder="选择预算" options={BUDGETS.map(s => ({ value: s, label: s }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="interest" label="意向产品">
                <Input placeholder="如 招牌菜预订 / 企业团餐" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="company" label="公司">
                <Input placeholder="客户公司名称" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="region" label="区域">
                <Input placeholder="如 临沂兰山区" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="birthday" label="生日（用于生日关怀）">
                <Input placeholder="如 08-28 或 1990-08-28" maxLength={10} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="next_follow_at" label="下次跟进日期">
                <DatePicker style={{ width: '100%' }} placeholder="选择日期" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="next_action" label="下次动作">
                <Input placeholder="如 电话回访 / 邀约主题试吃" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* ===== Modal：AI 顾虑应对话术 ===== */}
      <Modal
        title={
          <>
            <RobotOutlined style={{ color: 'var(--ui-accent)' }} /> AI 顾虑应对话术
          </>
        }
        open={objModal.open}
        footer={null}
        onCancel={() => setObjModal({ open: false, text: '' })}
      >
        <Paragraph
          copyable={{ text: objModal.text }}
          style={{
            whiteSpace: 'pre-wrap',
            fontSize: 13,
            color: 'var(--ui-text-2)',
            lineHeight: 1.8,
            background: 'var(--ui-surface-2)',
            borderRadius: 8,
            padding: '10px 12px',
          }}
        >
          {objModal.text || '生成中…'}
        </Paragraph>
      </Modal>
    </div>
  );
}
