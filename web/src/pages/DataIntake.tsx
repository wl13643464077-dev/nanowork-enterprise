import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Steps,
  Table,
  Tag,
  message,
} from 'antd';
import {
  CheckCircleOutlined,
  CloudUploadOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FileExcelOutlined,
  FileSearchOutlined,
  HistoryOutlined,
  InboxOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { loadXlsx } from '../utils/xlsx';
import { Panel } from '../components/Kit';
import { UnifiedFilePicker, type UploadedFileRef } from '../components/UnifiedFilePicker';

interface RawSheet {
  name: string;
  rows: any[][];
  target?: string;
}
const MAX_WORKBOOK_SHEETS = 10;
const MAX_WORKBOOK_ROWS = 5000;
const LONG_EDIT_FIELDS = new Set(['body', 'detail', 'week_problem', 'next_action']);

function newImportKey() {
  return globalThis.crypto?.randomUUID?.() || `import-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

const STARTER_GUIDE = [
  {
    key: 'leads',
    order: 1,
    sheet: '客户线索表',
    required: '客户姓名',
    recommended: '手机号、微信、来源、身份标签、意向产品、预算等级、客户阶段、地区、企业、下次跟进',
    output: '客群结构、客户阶段漏斗、重点客户、待跟进提醒',
  },
  {
    key: 'orders',
    order: 2,
    sheet: '订单销售表',
    required: '客户姓名、订单金额',
    recommended: '产品名称、订单类型、地区、渠道、订单时间、手机号',
    output: '销售额、商品销售TOP10、区域销售、渠道转化、客户消费结构',
  },
  {
    key: 'daily_ops',
    order: 3,
    sheet: '经营日报表',
    required: '日期',
    recommended: '新增线索、邀约、到店、成交数、成交金额、复购金额、订单数、营销费用、经营问题、下一步动作',
    output: '总裁驾驶舱、销售趋势、目标缺口、每日战果与经营简报',
  },
  {
    key: 'activities',
    order: 4,
    sheet: '活动数据表',
    required: '活动名称、活动日期',
    recommended: '活动类型、状态、地点、目标人数、目标成交、预算、邀约、报名、到场、成交、收入、成本、满意度',
    output: '活动日历、到场率、转化率、活动收入、ROI与活动复盘',
  },
];

const TEMPLATE_SHEETS: Record<string, string[]> = {
  客户线索表: [
    '客户姓名',
    '手机号',
    '微信',
    '来源',
    '身份标签',
    '意向产品',
    '预算等级',
    '客户阶段',
    '地区',
    '企业名称',
    '推荐人',
    '下次跟进',
    '下一步动作',
  ],
  订单销售表: ['客户姓名', '手机号', '产品名称', '订单金额', '订单类型', '地区', '渠道', '订单时间'],
  经营日报表: [
    '日期',
    '内容产出',
    '新增线索',
    '邀约数',
    '到店数',
    '成交数',
    '成交金额',
    '复购金额',
    '活跃合伙人',
    '订单数',
    '营销费用',
    '经营问题',
    '下一步动作',
  ],
  活动数据表: [
    '活动名称',
    '活动类型',
    '状态',
    '活动日期',
    '活动地点',
    '目标人数',
    '目标成交',
    '预算',
    '邀约人数',
    '报名人数',
    '到场人数',
    '成交人数',
    '收入',
    '成本',
    '满意度',
  ],
};

async function downloadStarterWorkbook() {
  const XLSX = await loadXlsx();
  const workbook = XLSX.utils.book_new();
  const notes = [
    ['表格', '每行代表', '最少字段', '日期格式', '填写要求'],
    ['客户线索表', '一个客户/线索', '客户姓名', '下次跟进：YYYY-MM-DD', '第一行必须是表头；手机号建议按文本填写'],
    ['订单销售表', '一笔订单', '客户姓名、订单金额', '订单时间：YYYY-MM-DD', '金额只填数字；产品名称决定商品销售TOP10'],
    ['经营日报表', '一天的经营汇总', '日期', 'YYYY-MM-DD', '同一天再次导入会更新当日数据，不重复累计'],
    ['活动数据表', '一场活动', '活动名称、活动日期', 'YYYY-MM-DD', '活动名称+日期相同时更新原活动'],
  ];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(notes), '填写说明');
  Object.entries(TEMPLATE_SHEETS).forEach(([name, headers]) => {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers]), name);
  });
  XLSX.writeFile(workbook, '纳米WorkOS_数据录入标准模板.xlsx');
}

export default function DataIntake() {
  const navigate = useNavigate();
  const [schemas, setSchemas] = useState<any[]>([]);
  const [rawSheets, setRawSheets] = useState<RawSheet[]>([]);
  const [batches, setBatches] = useState<any[]>([]);
  const [files, setFiles] = useState<UploadedFileRef[]>([]);
  const [archivingFileId, setArchivingFileId] = useState<number | null>(null);
  const [archivedFileIds, setArchivedFileIds] = useState<Set<number>>(() => new Set());
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [importKey, setImportKey] = useState(newImportKey);
  const [history, setHistory] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingItemId, setDeletingItemId] = useState<number | null>(null);
  const [editForm] = Form.useForm();

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const [historyResult, jobsResult] = await Promise.allSettled([
        api.get('/data-intake/history?limit=100'),
        api.get('/data-intake/jobs?limit=30'),
      ]);
      if (historyResult.status === 'fulfilled')
        setHistory(Array.isArray(historyResult.value) ? historyResult.value : []);
      if (jobsResult.status === 'fulfilled') setJobs(Array.isArray(jobsResult.value) ? jobsResult.value : []);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    api
      .get('/data-intake/schema')
      .then(setSchemas)
      .catch(() => {});
    api
      .get('/files?purpose=data-intake&limit=12')
      .then(rows => setFiles(Array.isArray(rows) ? rows : []))
      .catch(() => {});
    api
      .post('/data-intake/reconcile', {})
      .catch(() => null)
      .finally(() => {
        void loadHistory();
      });
  }, [loadHistory]);

  const archiveFile = async (file: UploadedFileRef) => {
    setArchivingFileId(file.id);
    try {
      const out = await api.post(`/files/${file.id}/archive`, { category: '品牌资料' });
      setArchivedFileIds(current => new Set(current).add(file.id));
      message.success(
        out.alreadyArchived
          ? '该资料已在知识库中'
          : out.enabled
            ? '资料已入档并可被AI调用'
            : '资料已入档，等待管理层启用',
      );
    } finally {
      setArchivingFileId(null);
    }
  };

  const preview = async (sheets: RawSheet[]) => {
    if (!sheets.length) return;
    setParsing(true);
    try {
      const out = await api.post('/data-intake/preview', { sheets });
      setBatches(out.batches || []);
      setResult(null);
    } finally {
      setParsing(false);
    }
  };

  // 文件处理与入口解耦：点击选择和拖拽投递共用同一条读取→识别→预览链路
  const handleWorkbookFiles = async (selected: File[]) => {
    if (!selected.length) return;
    setParsing(true);
    try {
      const XLSX = await loadXlsx();
      const next: RawSheet[] = [];
      for (const file of selected) {
        const buf = await file.arrayBuffer();
        const workbook = XLSX.read(buf, { type: 'array', cellDates: false });
        for (const sheetName of workbook.SheetNames) {
          // Preserve Excel date serials so the server can normalize dates without
          // depending on the workbook's locale-specific display format.
          const rows: any[][] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
            header: 1,
            raw: true,
            defval: '',
          });
          if (rows.length) {
            if (next.length >= MAX_WORKBOOK_SHEETS)
              throw new Error(`单次最多读取 ${MAX_WORKBOOK_SHEETS} 个工作表，请拆分文件后上传`);
            if (rows.length - 1 > MAX_WORKBOOK_ROWS)
              throw new Error(
                `${file.name} / ${sheetName} 超过 ${MAX_WORKBOOK_ROWS} 行，请拆分后上传，系统不会静默截断数据`,
              );
            next.push({ name: selected.length > 1 ? `${file.name} / ${sheetName}` : sheetName, rows });
          }
        }
      }
      setRawSheets(next);
      setImportKey(newImportKey());
      await preview(next);
      message.success(`已读取 ${next.length} 个工作表，系统已自动判断写入位置`);
    } catch (error: any) {
      message.error(error?.message || '表格读取失败，请检查文件是否损坏或加密');
    } finally {
      setParsing(false);
    }
  };

  const pickWorkbook = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.xlsx,.xls,.csv';
    input.onchange = () => {
      void handleWorkbookFiles(Array.from(input.files || []));
    };
    input.click();
  };

  const [dragOver, setDragOver] = useState(false);
  const onDropWorkbook = (event: React.DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    const accepted = Array.from(event.dataTransfer?.files || []).filter(file => /\.(xlsx|xls|csv)$/iu.test(file.name));
    if (!accepted.length) {
      message.warning('请拖入 Excel（.xlsx/.xls）或 CSV 文件');
      return;
    }
    void handleWorkbookFiles(accepted);
  };

  const changeTarget = async (sheet: string, target: string) => {
    const next = rawSheets.map(s => (s.name === sheet ? { ...s, target } : s));
    setRawSheets(next);
    await preview(next);
  };

  const commit = async () => {
    const valid = batches.reduce((sum, b) => sum + Number(b.validRows || 0), 0);
    if (!valid) return message.warning('没有通过校验的有效数据');
    setImporting(true);
    try {
      const out = await api.post('/data-intake/commit', { batches, idempotencyKey: importKey });
      setResult(out);
      window.dispatchEvent(new CustomEvent('nanowork-data-updated', { detail: out.sync || {} }));
      await loadHistory();
      message.success(out.replayed ? '该批数据已导入，本次未重复写入' : `导入完成，共写入 ${out.imported} 行经营数据`);
    } finally {
      setImporting(false);
    }
  };

  const openEdit = (item: any) => {
    setEditingItem(item);
    editForm.resetFields();
    editForm.setFieldsValue(item.data || {});
  };

  const saveEdit = async () => {
    if (!editingItem) return;
    const data = await editForm.validateFields();
    setSavingEdit(true);
    try {
      await api.put(`/data-intake/items/${editingItem.id}`, { data });
      window.dispatchEvent(new CustomEvent('nanowork-data-updated', { detail: { target: editingItem.target } }));
      message.success('导入数据已修改，相关经营分析将使用新数据');
      setEditingItem(null);
      await loadHistory();
    } finally {
      setSavingEdit(false);
    }
  };

  const deleteOrRevert = async (item: any) => {
    setDeletingItemId(item.id);
    try {
      const out = await api.del(`/data-intake/items/${item.id}`);
      window.dispatchEvent(new CustomEvent('nanowork-data-updated', { detail: { target: item.target } }));
      message.success(out.message || (item.importAction === '更新' ? '本次更新已撤回' : '数据已删除'));
      await loadHistory();
    } finally {
      setDeletingItemId(null);
    }
  };

  const totalRows = useMemo(() => batches.reduce((s, b) => s + (b.rows?.length || 0), 0), [batches]);
  const validRows = useMemo(() => batches.reduce((s, b) => s + Number(b.validRows || 0), 0), [batches]);
  const failedJobs = useMemo(() => jobs.filter(job => job.status !== 'success'), [jobs]);

  const wizardStep = result ? 3 : batches.length ? 2 : rawSheets.length ? 1 : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* 向导步骤条：老板/管理员随时知道自己在第几步、下一步干什么 */}
      <Panel>
        <Steps
          size="small"
          current={wizardStep}
          items={[
            { title: '准备表格', description: '按模板整理 Excel/CSV' },
            { title: '上传识别', description: '拖进来自动判断写入位置' },
            { title: '预览确认', description: '核对无误再写入' },
            { title: '完成', description: '驾驶舱实时更新' },
          ]}
        />
      </Panel>

      <details
        open={!batches.length || undefined}
        style={{
          border: '1px solid var(--ui-border)',
          borderRadius: 14,
          background: 'var(--ui-surface)',
          padding: '4px 0',
        }}
      >
        <summary
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 16px',
            cursor: 'pointer',
            fontWeight: 650,
            color: 'var(--ui-text)',
            listStyle: 'none',
          }}
        >
          <FileExcelOutlined /> 第一次用？先看这份准备指南（四类基础表 + 标准模板）
          <Button
            size="small"
            icon={<DownloadOutlined />}
            style={{ marginLeft: 'auto' }}
            onClick={event => {
              event.preventDefault();
              downloadStarterWorkbook().catch(() => message.error('模板组件加载失败，请检查网络后重试'));
            }}
          >
            下载标准模板
          </Button>
        </summary>
        <div style={{ padding: '4px 16px 14px' }}>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 10 }}
            message="建议按“客户 → 订单 → 经营日报 → 活动”顺序导入"
            description="只有客户表无法形成销售分析；补充订单表后才会出现商品销售TOP10、渠道和区域结构，日报与活动表负责驱动驾驶舱趋势、经营简报和活动复盘。"
          />
          <Table
            size="small"
            rowKey="key"
            pagination={false}
            dataSource={STARTER_GUIDE}
            scroll={{ x: 1040 }}
            columns={[
              { title: '顺序', dataIndex: 'order', width: 58, render: (v: number) => <Tag color="blue">{v}</Tag> },
              { title: '上传表格', dataIndex: 'sheet', width: 110, render: (v: string) => <b>{v}</b> },
              { title: '最少字段', dataIndex: 'required', width: 150 },
              { title: '建议补全字段', dataIndex: 'recommended', width: 340 },
              { title: '导入后驱动', dataIndex: 'output', width: 330 },
            ]}
          />
          <div style={{ marginTop: 9, fontSize: 12, color: 'var(--ui-muted)', lineHeight: 1.75 }}>
            表头必须放在第一行，每行只放一条记录，不要合并单元格；日期建议使用
            YYYY-MM-DD，金额只填数字。工作表名称可以不同，系统主要按表头识别，写入前仍会给你预览和修改目标表。
          </div>
        </div>
      </details>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.45fr) minmax(280px,.75fr)', gap: 12 }}>
        <Panel
          title={
            <>
              <InboxOutlined /> 结构化数据文件
            </>
          }
        >
          {/* 拖拽投递区：把文件拖进来即上传，也可点击选择 */}
          <div
            role="button"
            tabIndex={0}
            aria-label="拖入或点击选择 Excel/CSV 文件"
            onClick={pickWorkbook}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                pickWorkbook();
              }
            }}
            onDragOver={event => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDropWorkbook}
            style={{
              display: 'grid',
              justifyItems: 'center',
              gap: 6,
              padding: '26px 16px',
              marginBottom: batches.length ? 12 : 0,
              border: `2px dashed ${dragOver ? 'var(--ui-primary)' : 'var(--ui-border)'}`,
              borderRadius: 14,
              background: dragOver
                ? 'color-mix(in srgb, var(--ui-primary) 6%, var(--ui-surface))'
                : 'var(--ui-surface-2)',
              cursor: 'pointer',
              transition: 'border-color 0.15s ease, background 0.15s ease',
            }}
          >
            <CloudUploadOutlined style={{ fontSize: 30, color: 'var(--ui-primary)' }} />
            <b style={{ color: 'var(--ui-text)', fontSize: 14 }}>
              {parsing ? '正在读取表格…' : '把 Excel / CSV 拖到这里，或点击选择文件'}
            </b>
            <span style={{ color: 'var(--ui-muted)', fontSize: 12 }}>
              上传后自动识别每张表写入哪个业务模块；写入前一定先给你预览确认
            </span>
          </div>
          {!batches.length ? null : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
                <Tag color="blue">{batches.length} 个工作表</Tag>
                <Tag color="green">{validRows} 行可导入</Tag>
                {totalRows > validRows && <Tag color="orange">{totalRows - validRows} 行待修正</Tag>}
                <Progress
                  percent={totalRows ? Math.round((validRows / totalRows) * 100) : 0}
                  size="small"
                  style={{ maxWidth: 220 }}
                />
              </div>
              {batches.map(batch => {
                const fields = Array.from(
                  new Set((batch.rows || []).flatMap((r: any) => Object.keys(r.data || {}))),
                ).slice(0, 8) as string[];
                return (
                  <div key={batch.sheet} style={{ border: '1px solid var(--ui-border)', borderRadius: 8, padding: 12 }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 10,
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        marginBottom: 8,
                      }}
                    >
                      <div>
                        <b>{batch.sheet}</b>
                        <Tag
                          color={batch.confidence >= 80 ? 'green' : batch.confidence >= 55 ? 'orange' : 'red'}
                          style={{ marginLeft: 8 }}
                        >
                          识别置信度 {batch.confidence}%
                        </Tag>
                      </div>
                      <Space>
                        <span style={{ fontSize: 12, color: 'var(--ui-muted)' }}>写入到</span>
                        <Select
                          size="small"
                          value={batch.target}
                          style={{ width: 150 }}
                          onChange={v => changeTarget(batch.sheet, v)}
                          options={schemas.map(s => ({ value: s.key, label: s.label }))}
                        />
                      </Space>
                    </div>
                    <Table
                      size="small"
                      rowKey="rowNumber"
                      pagination={false}
                      dataSource={(batch.rows || []).slice(0, 5)}
                      scroll={{ x: true }}
                      columns={
                        [
                          { title: '行', dataIndex: 'rowNumber', width: 48 },
                          ...fields.map(field => ({
                            title: field,
                            key: field,
                            ellipsis: true,
                            render: (_: any, r: any) => String(r.data?.[field] ?? ''),
                          })),
                          {
                            title: '校验',
                            width: 180,
                            render: (_: any, r: any) =>
                              r.valid ? (
                                <Tag color="green">可导入</Tag>
                              ) : (
                                <Tag color="orange">{r.error || `缺少${r.missing?.join('、')}`}</Tag>
                              ),
                          },
                        ] as any
                      }
                    />
                    {(batch.rows || []).length > 5 && (
                      <div style={{ fontSize: 11.5, color: 'var(--ui-muted)', marginTop: 6 }}>
                        仅预览前5行，确认后将处理全部 {batch.rows.length} 行
                      </div>
                    )}
                  </div>
                );
              })}
              <Button type="primary" size="large" icon={<CheckCircleOutlined />} loading={importing} onClick={commit}>
                确认映射并写入业务数据
              </Button>
            </div>
          )}
        </Panel>

        <Panel
          title={
            <>
              <FileSearchOutlined /> 非结构化资料
            </>
          }
        >
          <div style={{ fontSize: 12.5, color: 'var(--ui-text-2)', lineHeight: 1.75, marginBottom: 12 }}>
            Word、PDF、文本和图片会自动读取正文或识图。上传记录会保留在全局文件库，可在战略中枢和餐饮数字员工中再次选择，也可直接入档知识库。
          </div>
          <UnifiedFilePicker
            files={files}
            onChange={setFiles}
            purpose="data-intake"
            maxFiles={12}
            label="上传文档 / 图片"
          />
          {!!files.length && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {files.map(file => (
                <div key={file.id} style={{ background: 'var(--ui-surface-2)', borderRadius: 8, padding: '9px 10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                    <b style={{ fontSize: 12.5 }}>{file.name}</b>
                    <Space size={4}>
                      <Tag color={file.readable ? 'green' : 'orange'}>{file.readable ? '已读取' : '已存档'}</Tag>
                      <Button
                        size="small"
                        disabled={!file.readable || archivedFileIds.has(file.id)}
                        loading={archivingFileId === file.id}
                        onClick={() => archiveFile(file)}
                      >
                        {archivedFileIds.has(file.id) ? '已入档' : '入档知识库'}
                      </Button>
                    </Space>
                  </div>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: 'var(--ui-muted)',
                      marginTop: 4,
                      maxHeight: 72,
                      overflow: 'hidden',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {file.preview || file.extract_mode}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {result && (
        <Panel
          title={
            <>
              <DatabaseOutlined /> 本次导入结果
            </>
          }
        >
          <Alert
            type={result.imported > 0 ? 'success' : 'warning'}
            showIcon
            message={`成功写入 ${result.imported} 行`}
            description={(result.results || []).map((r: any) => (
              <div key={r.jobId || r.sheet} style={{ marginBottom: 4 }}>
                <div>
                  {r.sheet} → {r.targetLabel || r.target}：成功 {r.imported}，跳过 {r.skipped}
                </div>
                {(r.errors || []).slice(0, 3).map((error: any, index: number) => (
                  <div key={index} style={{ color: 'var(--ui-danger)', fontSize: 12 }}>
                    {typeof error === 'string' ? error : `第 ${error.row || '-'} 行：${error.error || '未通过校验'}`}
                  </div>
                ))}
              </div>
            ))}
          />
          {result.sync?.status === 'completed' && result.sync.destinations?.length > 0 && (
            <div
              style={{
                marginTop: 12,
                padding: '12px 14px',
                border: '1px solid var(--ui-border)',
                borderRadius: 8,
                background: 'var(--ui-surface)',
              }}
            >
              <div style={{ fontWeight: 650, marginBottom: 8 }}>业务同步完成</div>
              <div style={{ color: 'var(--ui-text-2)', fontSize: 12.5, marginBottom: 10 }}>
                已写入正式业务表并建立数据资产记录，可直接进入以下模块核对。
              </div>
              <Space size={[8, 8]} wrap>
                {result.sync.destinations.map((destination: any) => (
                  <Button key={destination.key} size="small" onClick={() => navigate(destination.path)}>
                    {destination.label}
                  </Button>
                ))}
              </Space>
            </div>
          )}
        </Panel>
      )}

      <Panel
        title={
          <>
            <HistoryOutlined /> 导入批次结果
          </>
        }
        extra={
          <Tag color={failedJobs.length ? 'orange' : 'green'}>
            {failedJobs.length ? `${failedJobs.length} 个批次需处理` : '最近批次正常'}
          </Tag>
        }
      >
        {failedJobs.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 10 }}
            message="有批次没有写入或仅部分写入，不能视为已同步"
            description="请按右侧失败原因修正后重新上传。已成功写入的行会继续保留，不会因为重传而被清空。"
          />
        )}
        <Table
          size="small"
          rowKey="id"
          loading={historyLoading}
          dataSource={jobs}
          pagination={{ pageSize: 8, showSizeChanger: false }}
          scroll={{ x: 920 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无导入批次" /> }}
          columns={
            [
              { title: '导入时间', dataIndex: 'createdAt', width: 155 },
              {
                title: '工作表',
                width: 170,
                render: (_: any, job: any) => <b>{job.sheet || job.targetLabel || '未命名工作表'}</b>,
              },
              { title: '写入位置', dataIndex: 'targetLabel', width: 120 },
              {
                title: '结果',
                width: 165,
                render: (_: any, job: any) => (
                  <Space size={5}>
                    <Tag color="green">成功 {job.imported}</Tag>
                    <Tag color={job.skipped ? 'orange' : 'default'}>跳过 {job.skipped}</Tag>
                    <span style={{ color: 'var(--ui-muted)' }}>/ {job.total}</span>
                  </Space>
                ),
              },
              {
                title: '状态',
                width: 90,
                render: (_: any, job: any) =>
                  job.status === 'success' ? (
                    <Tag color="green">已同步</Tag>
                  ) : job.status === 'partial' ? (
                    <Tag color="orange">部分成功</Tag>
                  ) : (
                    <Tag color="red">未写入</Tag>
                  ),
              },
              {
                title: '失败原因',
                width: 300,
                render: (_: any, job: any) =>
                  job.errors?.length ? (
                    <div style={{ fontSize: 12, color: 'var(--ui-text-2)' }}>
                      {job.errors
                        .slice(0, 2)
                        .map((error: any) => `第${error.row || '-'}行：${error.error || '未通过校验'}`)
                        .join('；')}
                    </div>
                  ) : (
                    <span style={{ color: 'var(--ui-muted)' }}>无</span>
                  ),
              },
            ] as any
          }
        />
      </Panel>

      <Panel
        title={
          <>
            <HistoryOutlined /> 导入记录管理
          </>
        }
        extra={
          <Button icon={<HistoryOutlined />} loading={historyLoading} onClick={loadHistory}>
            刷新
          </Button>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 10 }}
          message="上传错了可以修正；新增数据可删除，覆盖旧数据只能撤回本次更新"
          description="删除的数据会进入系统管理回收站，老板可恢复。若记录已在客户、订单或活动模块继续使用，系统会阻止直接删除，避免业务数据断裂。"
        />
        <Table
          size="small"
          rowKey="id"
          loading={historyLoading}
          dataSource={history}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          scroll={{ x: 980 }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无导入记录" /> }}
          columns={
            [
              { title: '导入时间', dataIndex: 'createdAt', width: 155 },
              {
                title: '工作表 / 行',
                width: 170,
                render: (_: any, item: any) => (
                  <div>
                    <b>{item.sheet || '未命名工作表'}</b>
                    <div style={{ color: 'var(--ui-muted)', fontSize: 11.5 }}>
                      第 {item.rowNumber || '-'} 行 · 记录 #{item.recordId}
                    </div>
                  </div>
                ),
              },
              { title: '写入位置', dataIndex: 'targetLabel', width: 120 },
              {
                title: '数据摘要',
                width: 260,
                ellipsis: true,
                render: (_: any, item: any) =>
                  Object.entries(item.data || {})
                    .filter(([, value]) => value !== null && value !== '')
                    .slice(0, 3)
                    .map(
                      ([key, value]) =>
                        `${item.editableFields?.find((f: any) => f.key === key)?.label || key}：${String(value)}`,
                    )
                    .join('；') || '暂无摘要',
              },
              {
                title: '导入动作',
                dataIndex: 'importAction',
                width: 90,
                render: (value: string) => <Tag color={value === '新增' ? 'green' : 'blue'}>{value}</Tag>,
              },
              {
                title: '状态',
                dataIndex: 'status',
                width: 92,
                render: (value: string) =>
                  value === 'active' ? (
                    <Tag color="green">生效中</Tag>
                  ) : value === 'deleted' ? (
                    <Tag>已删除</Tag>
                  ) : (
                    <Tag color="orange">已撤回</Tag>
                  ),
              },
              {
                title: '操作',
                width: 190,
                fixed: 'right' as const,
                render: (_: any, item: any) =>
                  item.status === 'active' ? (
                    <Space size={4}>
                      <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(item)}>
                        修改
                      </Button>
                      <Popconfirm
                        title={item.importAction === '更新' ? '撤回本次导入更新？' : '删除这条导入数据？'}
                        description={
                          item.importAction === '更新'
                            ? '系统会恢复导入前的数据，不会删除原记录。'
                            : '删除后进入回收站，老板仍可恢复。'
                        }
                        okText={item.importAction === '更新' ? '确认撤回' : '确认删除'}
                        cancelText="取消"
                        onConfirm={() => deleteOrRevert(item)}
                      >
                        <Button
                          danger={item.importAction !== '更新'}
                          size="small"
                          loading={deletingItemId === item.id}
                          icon={item.importAction === '更新' ? <UndoOutlined /> : <DeleteOutlined />}
                        >
                          {item.importAction === '更新' ? '撤回' : '删除'}
                        </Button>
                      </Popconfirm>
                    </Space>
                  ) : (
                    <span style={{ color: 'var(--ui-muted)' }}>已处理</span>
                  ),
              },
            ] as any
          }
        />
      </Panel>

      <Modal
        title={`修改${editingItem?.targetLabel || '导入数据'}`}
        open={!!editingItem}
        onCancel={() => setEditingItem(null)}
        onOk={saveEdit}
        confirmLoading={savingEdit}
        okText="保存修改"
        cancelText="取消"
        destroyOnClose
        width={680}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message="保存前会再次检查业务记录是否被其他人修改，检测到冲突时不会覆盖。"
        />
        <Form form={editForm} layout="vertical">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: '0 14px' }}>
            {(editingItem?.editableFields || []).map((field: any) => {
              const required = schemas
                .find(schema => schema.key === editingItem?.target)
                ?.required?.includes(field.key);
              return (
                <Form.Item
                  key={field.key}
                  name={field.key}
                  label={field.label}
                  rules={required ? [{ required: true, message: `请填写${field.label}` }] : undefined}
                  style={LONG_EDIT_FIELDS.has(field.key) ? { gridColumn: '1 / -1' } : undefined}
                >
                  {LONG_EDIT_FIELDS.has(field.key) ? (
                    <Input.TextArea
                      rows={field.key === 'body' ? 8 : 3}
                      maxLength={field.key === 'body' ? 60000 : 8000}
                      showCount
                    />
                  ) : (
                    <Input maxLength={1000} />
                  )}
                </Form.Item>
              );
            })}
          </div>
        </Form>
      </Modal>
    </div>
  );
}
