import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Pagination,
  Rate,
  Segmented,
  Select,
  Skeleton,
  Space,
  Tag,
  message,
} from 'antd';
import { ImportOutlined, PlusOutlined, RobotOutlined, StarFilled } from '@ant-design/icons';
import { api } from '../api/client';
import { loadXlsx } from '../utils/xlsx';
import './Reviews.css';

// 评价中心：好评差评台账（手录/Excel 导入）+ AI 回复稿（真实计费）+ 差评预警。
// 边界：AI 只生成回复草稿，发布必须由人复制到平台操作——系统不代替对外发布。

const PLATFORMS = ['美团', '饿了么', '大众点评', '抖音', '其他'];
// 与后端一致的差评六类归因（行业 SOP：归因决定整改责任人）
const CATEGORIES = ['漏发错发', '口味出品', '配送问题', '服务态度', '出餐慢', '恶意差评'];

type Review = {
  id: number;
  platform: string;
  rating: number;
  content: string;
  author?: string;
  store_name?: string;
  review_date?: string;
  status: string;
  reply?: string;
  replied_at?: string;
  category?: string | null;
  slaOverdue?: boolean;
};

type ReviewInsights = {
  categories: { category: string; count: number }[];
  mentionedDishes: { name: string; count: number }[];
  slaHours: number;
};

export default function Reviews() {
  const [summary, setSummary] = useState<any>(null);
  const [insights, setInsights] = useState<ReviewInsights | null>(null);
  const [rows, setRows] = useState<Review[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('pending');
  const [platform, setPlatform] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [detail, setDetail] = useState<Review | null>(null);
  const [draft, setDraft] = useState('');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addForm] = Form.useForm();
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    const query = new URLSearchParams();
    query.set('page', String(page));
    query.set('size', '20');
    if (filter === 'pending') query.set('status', '待回复');
    if (filter === 'bad') query.set('bad', '1');
    if (platform) query.set('platform', platform);
    if (categoryFilter) query.set('category', categoryFilter);
    try {
      const [list, stats, insightsData] = await Promise.all([
        api.get(`/reviews?${query.toString()}`),
        api.get('/reviews/summary'),
        api.get('/reviews/insights').catch(() => null),
      ]);
      // 处理完当页最后一条后 total 缩小，深页码会拿到空数组：自动回退到真实的最后一页，
      // 避免明明还有数据却显示「没有评价记录」的假空态
      const totalCount = Number(list.total || 0);
      const lastPage = Math.max(1, Math.ceil(totalCount / 20));
      if (totalCount > 0 && (list.rows || []).length === 0 && page > lastPage) {
        setPage(lastPage);
        return;
      }
      setRows(list.rows || []);
      setTotal(totalCount);
      setSummary(stats);
      if (insightsData) setInsights(insightsData);
    } catch (err: any) {
      message.error(err?.message || '评价读取失败');
      setRows([]);
    }
  }, [page, filter, platform, categoryFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const openDetail = (review: Review) => {
    setDetail(review);
    setDraft(review.reply || '');
  };

  const generateReply = async () => {
    if (!detail) return;
    setGenerating(true);
    try {
      const out = await api.post(`/reviews/${detail.id}/ai-reply`, {});
      setDraft(out.draft || '');
      message.success(`回复稿已生成（${out.billing?.chargedCredits ?? '-'} 积分）；确认后复制到平台发布`);
    } catch (err: any) {
      message.error(err?.message || '回复稿生成失败');
    } finally {
      setGenerating(false);
    }
  };

  const saveReply = async (status: '已回复' | '无需回复') => {
    if (!detail) return;
    setSaving(true);
    try {
      await api.put(`/reviews/${detail.id}/reply`, { reply: draft, status });
      message.success(status === '已回复' ? '已标记回复完成' : '已标记无需回复');
      setDetail(null);
      await load();
    } catch {
      /* client 已 toast */
    } finally {
      setSaving(false);
    }
  };

  const submitAdd = async () => {
    const values = await addForm.validateFields();
    setAdding(true);
    try {
      await api.post('/reviews', values);
      message.success('评价已录入');
      setAddOpen(false);
      addForm.resetFields();
      await load();
    } catch {
      /* client 已 toast（重复录入会提示 409） */
    } finally {
      setAdding(false);
    }
  };

  // Excel 导入：本地解析（表头包含 平台/评分/内容/日期/顾客 任意命名近似列）
  const importExcel = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls,.csv';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setImporting(true);
      try {
        const XLSX = await loadXlsx();
        // cellDates：Excel 日期列会读成序列号（如 45678），必须转成 Date 再格式化，
        // 否则整列评价日期丢失，且去重键退化误杀不同日期的同内容评价
        const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const records: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        const pick = (row: any, keys: string[]) => {
          for (const key of Object.keys(row)) {
            if (keys.some(k => String(key).toLowerCase().includes(k))) return row[key];
          }
          return '';
        };
        const asDateText = (value: unknown) => {
          if (value instanceof Date && !Number.isNaN(value.valueOf())) {
            return value.toLocaleDateString('sv-SE');
          }
          return String(value || '')
            .trim()
            .slice(0, 10);
        };
        const rowsToImport = records
          .map(row => ({
            platform: String(pick(row, ['平台', 'platform']) || '其他').trim(),
            rating: Number(pick(row, ['评分', '星', 'rating', 'star'])) || 0,
            content: String(pick(row, ['内容', '评价', '评论', 'content', 'review', 'comment']) || '').trim(),
            author: String(pick(row, ['顾客', '用户', '昵称', 'author', 'user']) || '').trim(),
            reviewDate: asDateText(pick(row, ['日期', '时间', 'date', 'time'])),
          }))
          .filter(row => row.content);
        if (!rowsToImport.length) {
          message.warning('没有识别到评价内容列；表头需包含「内容/评价/评论」之一');
          return;
        }
        // 超过 500 条自动分批提交（后端单次上限 500，避免整批被拒或静默丢行）
        let imported = 0;
        let skipped = 0;
        for (let start = 0; start < rowsToImport.length; start += 500) {
          const out = await api.post('/reviews/import', { rows: rowsToImport.slice(start, start + 500) });
          imported += Number(out.imported || 0);
          skipped += Number(out.failures?.length || 0);
        }
        message.success(
          `导入完成：成功 ${imported} 条${skipped ? `，跳过 ${skipped} 条（重复或缺字段）` : ''}（共读取 ${rowsToImport.length} 行）`,
        );
        await load();
      } catch (err: any) {
        message.error(err?.message || '导入失败，请检查表格');
      } finally {
        setImporting(false);
      }
    };
    input.click();
  };

  return (
    <div className="rv-page">
      <header className="rv-head">
        <div>
          <span className="rv-kicker">评价中心 · 好评差评一站处理</span>
          <h1>平台评价</h1>
          <p>差评当天回，好评带节奏。AI 起草回复，你确认后复制到平台发布——系统不代替对外发布。</p>
        </div>
        <Space wrap>
          <Button icon={<ImportOutlined />} loading={importing} onClick={importExcel}>
            导入 Excel
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
            录入评价
          </Button>
        </Space>
      </header>

      {summary && (
        <div className="rv-stats">
          <button
            type="button"
            data-alert={summary.slaOverdue > 0 || undefined}
            onClick={() => {
              setFilter('bad');
              setPage(1);
            }}
          >
            <strong>{summary.slaOverdue}</strong>
            <span>差评超 {summary.slaHours || 24}h 未回</span>
          </button>
          <button
            type="button"
            data-alert={summary.pendingBad > 0 || undefined}
            onClick={() => {
              setFilter('bad');
              setPage(1);
            }}
          >
            <strong>{summary.pendingBad}</strong>
            <span>差评待回复</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setFilter('pending');
              setPage(1);
            }}
          >
            <strong>{summary.pending}</strong>
            <span>全部待回复</span>
          </button>
          <button
            type="button"
            data-alert={summary.avgRating != null && summary.avgRating < 4.5 ? true : undefined}
            onClick={() => {
              setFilter('all');
              setPage(1);
            }}
          >
            <strong>{summary.avgRating ?? '—'}</strong>
            <span>平均评分{summary.avgRating != null && summary.avgRating < 4.5 ? '（低于4.5流量线）' : ''}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setFilter('all');
              setPage(1);
            }}
          >
            <strong>{summary.total}</strong>
            <span>累计评价</span>
          </button>
        </div>
      )}

      {insights && (insights.categories.length > 0 || insights.mentionedDishes.length > 0) && (
        <div className="rv-insights">
          {insights.categories.length > 0 && (
            <div className="rv-insights-row">
              <span className="rv-insights-label">差评归因</span>
              {insights.categories.map(item => (
                <button
                  type="button"
                  key={item.category}
                  className={categoryFilter === item.category ? 'active' : ''}
                  onClick={() => {
                    setCategoryFilter(current => (current === item.category ? '' : item.category));
                    setFilter('bad');
                    setPage(1);
                  }}
                >
                  {item.category} <b>{item.count}</b>
                </button>
              ))}
            </div>
          )}
          {insights.mentionedDishes.length > 0 && (
            <div className="rv-insights-row">
              <span className="rv-insights-label">被点名的菜</span>
              {insights.mentionedDishes.map(dish => (
                <em key={dish.name}>
                  {dish.name} <b>{dish.count} 次</b>
                </em>
              ))}
              <small>差评正文点到名的菜品，优先复盘出品</small>
            </div>
          )}
        </div>
      )}

      <div className="rv-toolbar">
        <Segmented
          value={filter}
          onChange={value => {
            setFilter(String(value));
            setPage(1);
          }}
          options={[
            { value: 'pending', label: '待回复' },
            { value: 'bad', label: '差评（≤3星）' },
            { value: 'all', label: '全部' },
          ]}
        />
        <Select
          allowClear
          placeholder="全部平台"
          style={{ width: 130 }}
          value={platform || undefined}
          options={PLATFORMS.map(item => ({ value: item, label: item }))}
          onChange={value => {
            setPlatform(value || '');
            setPage(1);
          }}
        />
      </div>

      {rows === null ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : rows.length === 0 ? (
        // 有筛选时的空结果 ≠ 没有任何台账，文案分开说，别误导用户去「录入第一条」
        (summary?.total || 0) > 0 ? (
          <Empty description="当前筛选条件下没有匹配的评价；试试切换「全部」或清掉平台/归因筛选" />
        ) : (
          <Empty description="没有评价记录；点右上角「录入评价」或「导入 Excel」把平台评价搬进来">
            <Button type="primary" onClick={() => setAddOpen(true)}>
              录入第一条评价
            </Button>
          </Empty>
        )
      ) : (
        <div className="rv-list">
          {rows.map(review => (
            <button type="button" className="rv-card" key={review.id} onClick={() => openDetail(review)}>
              <div className="rv-card-head">
                {review.slaOverdue && <Tag color="error">超24h未回</Tag>}
                <Tag color={review.rating <= 3 ? 'error' : 'success'}>
                  <StarFilled /> {review.rating} 星
                </Tag>
                {review.category && <Tag color="purple">{review.category}</Tag>}
                <span className="rv-card-platform">{review.platform}</span>
                {review.author && <span className="rv-card-author">{review.author}</span>}
                <span className="rv-card-date">{review.review_date || ''}</span>
                <Tag
                  color={review.status === '待回复' ? 'warning' : review.status === '已回复' ? 'success' : 'default'}
                >
                  {review.status}
                </Tag>
              </div>
              <p className="rv-card-content">{review.content}</p>
              {review.reply && <p className="rv-card-reply">回复：{review.reply}</p>}
            </button>
          ))}
          <Pagination
            current={page}
            total={total}
            pageSize={20}
            onChange={setPage}
            showSizeChanger={false}
            style={{ alignSelf: 'flex-end' }}
          />
        </div>
      )}

      <Drawer
        title={
          detail ? (
            <Space>
              <Rate disabled value={detail.rating} style={{ fontSize: 14 }} />
              <span>
                {detail.platform}
                {detail.author ? ` · ${detail.author}` : ''}
              </span>
            </Space>
          ) : (
            '评价详情'
          )
        }
        width={560}
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
      >
        {detail && (
          <div className="rv-detail">
            <blockquote className="rv-detail-content">{detail.content}</blockquote>
            {detail.rating <= 3 && (
              <div className="rv-detail-category">
                <span>归因（决定 AI 回复策略与整改方向）：</span>
                <Select
                  size="small"
                  style={{ width: 130 }}
                  value={detail.category || undefined}
                  placeholder="选择归因"
                  options={CATEGORIES.map(item => ({ value: item, label: item }))}
                  onChange={async value => {
                    try {
                      await api.put(`/reviews/${detail.id}/category`, { category: value });
                      setDetail(current => (current ? { ...current, category: value } : current));
                      // 同步列表卡片上的归因 Tag 与归因统计，不留陈旧数据
                      setRows(current =>
                        current
                          ? current.map(row => (row.id === detail.id ? { ...row, category: value } : row))
                          : current,
                      );
                      void api
                        .get('/reviews/insights')
                        .then(setInsights)
                        .catch(() => {});
                      message.success('归因已更新，AI 回复会按此策略起草');
                    } catch {
                      /* client 已 toast */
                    }
                  }}
                />
              </div>
            )}
            <div className="rv-detail-actions">
              <Button type="primary" icon={<RobotOutlined />} loading={generating} onClick={() => void generateReply()}>
                {generating ? 'AI 起草中…' : draft ? '重新生成回复稿' : 'AI 起草回复'}
              </Button>
              <span className="rv-detail-hint">
                {detail.rating <= 3 ? '差评回复：先道歉、回应具体问题、给改进动作' : '好评回复：具体感谢＋自然带出招牌'}
              </span>
            </div>
            <Input.TextArea
              value={draft}
              onChange={event => setDraft(event.target.value)}
              placeholder="回复内容（AI 起草后可修改，确认后复制到平台发布）"
              autoSize={{ minRows: 4, maxRows: 8 }}
              maxLength={500}
            />
            <Space wrap>
              <Button
                type="primary"
                disabled={!draft.trim()}
                loading={saving}
                onClick={() => {
                  void navigator.clipboard?.writeText(draft).catch(() => {});
                  void saveReply('已回复');
                }}
              >
                复制并标记已回复
              </Button>
              <Button loading={saving} onClick={() => void saveReply('无需回复')}>
                无需回复
              </Button>
            </Space>
            <Alert type="info" showIcon message="系统只生成草稿并留档；请把回复复制到对应平台商家后台发布。" />
          </div>
        )}
      </Drawer>

      <Modal
        title="录入评价"
        open={addOpen}
        okText="保存"
        confirmLoading={adding}
        onOk={() => void submitAdd()}
        onCancel={() => {
          setAddOpen(false);
          addForm.resetFields();
        }}
      >
        <Form form={addForm} layout="vertical" initialValues={{ platform: '美团', rating: 5 }}>
          <Form.Item name="platform" label="平台" rules={[{ required: true }]}>
            <Select options={PLATFORMS.map(item => ({ value: item, label: item }))} />
          </Form.Item>
          <Form.Item name="rating" label="星级" rules={[{ required: true }]}>
            <InputNumber min={1} max={5} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="content" label="评价内容" rules={[{ required: true, message: '请粘贴评价内容' }]}>
            <Input.TextArea autoSize={{ minRows: 3, maxRows: 6 }} maxLength={2000} />
          </Form.Item>
          <Form.Item name="author" label="顾客昵称">
            <Input maxLength={50} />
          </Form.Item>
          <Form.Item name="reviewDate" label="评价日期（YYYY-MM-DD）">
            <Input placeholder="2026-08-28" maxLength={10} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
