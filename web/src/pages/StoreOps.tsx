import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  DatePicker,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Select,
  Skeleton,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  message,
} from 'antd';
import {
  AudioOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CoffeeOutlined,
  InboxOutlined,
  PlusOutlined,
  RocketOutlined,
  ScheduleOutlined,
  SoundOutlined,
} from '@ant-design/icons';
import { api, getUser } from '../api/client';
import { useStoreVersion } from '../api/store-context';
import './StoreOps.css';

// 门店日常操作台：日清检查 / 沽清板 / 排班考勤 / AI 晨会。
// 店长和员工每天开门要用的操作性功能；勾选留痕、真实台账，全部按租户隔离。

type ChecklistItem = { key: string; label: string; done: boolean; doneBy: string | null; doneAt: string | null };
type Checklist = {
  key: string;
  name: string;
  period: string;
  items: ChecklistItem[];
  doneCount: number;
  total: number;
};

function DailyChecklists() {
  const [data, setData] = useState<{ date: string; checklists: Checklist[]; total: number; done: number } | null>(null);
  const [error, setError] = useState('');
  const [togglingKey, setTogglingKey] = useState('');

  const load = useCallback(
    () =>
      api
        .get('/store-ops/checklists/today')
        .then(setData)
        .catch((err: any) => setError(err?.message || '日清清单读取失败')),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Alert type="error" showIcon message={error} />;
  if (!data) return <Skeleton active paragraph={{ rows: 6 }} />;

  const toggle = async (checklistKey: string, itemKey: string, done: boolean) => {
    const lockKey = `${checklistKey}:${itemKey}`;
    setTogglingKey(lockKey);
    try {
      // 携带目标态：多端同用时（前厅平板+店长手机）不会互相翻转对方刚勾的项
      await api.post(`/store-ops/checklists/${checklistKey}/toggle`, { itemKey, done });
      await load();
    } catch {
      /* client 已 toast */
    } finally {
      setTogglingKey('');
    }
  };

  const percent = data.total ? Math.round((data.done / data.total) * 100) : 0;

  return (
    <div className="sop-checklists">
      <div className="sop-progress">
        <Progress
          type="circle"
          size={72}
          percent={percent}
          format={() => (
            <span className="sop-progress-num">
              {data.done}
              <small>/{data.total}</small>
            </span>
          )}
        />
        <div className="sop-progress-copy">
          <strong>{data.date} 日清进度</strong>
          <span>开店、食安三件套（晨检/消毒/留样）、交接班、闭店——勾一项留一条痕，老板端看得到完成率。</span>
        </div>
      </div>
      <div className="sop-checklist-grid">
        {data.checklists.map(list => (
          <section className="sop-checklist" key={list.key} data-complete={list.doneCount === list.total || undefined}>
            <header>
              <strong>{list.name}</strong>
              <span>{list.period}</span>
              <em>
                {list.doneCount}/{list.total}
              </em>
            </header>
            {list.items.map(item => (
              <label
                className="sop-check-item"
                key={item.key}
                htmlFor={`store-check-${list.key}-${item.key}`}
                data-done={item.done || undefined}
              >
                <input
                  id={`store-check-${list.key}-${item.key}`}
                  type="checkbox"
                  checked={item.done}
                  disabled={togglingKey === `${list.key}:${item.key}`}
                  onChange={() => void toggle(list.key, item.key, !item.done)}
                />
                <span className="sop-check-label">{item.label}</span>
                {item.done && item.doneBy && (
                  <small>
                    {item.doneBy} · {String(item.doneAt || '').slice(11, 16)}
                  </small>
                )}
              </label>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function SoldoutBoard() {
  const [data, setData] = useState<{
    date: string;
    dishes: any[];
    soldoutCount: number;
    frequentSoldout?: { name: string; days: number }[];
  } | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(
    () =>
      api
        .get('/store-ops/soldout/today')
        .then(setData)
        .catch((err: any) => setError(err?.message || '沽清板读取失败')),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Alert type="error" showIcon message={error} />;
  if (!data) return <Skeleton active paragraph={{ rows: 5 }} />;
  if (!data.dishes.length)
    return <Empty description="还没有菜品档案；先到「门店数据 → 菜品」建菜单，这里就能一键标沽清" />;

  const groups = data.dishes.reduce<Record<string, any[]>>((acc, dish) => {
    const key = dish.category || '未分类';
    (acc[key] ||= []).push(dish);
    return acc;
  }, {});

  const toggle = async (dish: any) => {
    setBusyId(dish.id);
    try {
      // 携带目标态：两台设备同时操作同一个菜时不会互相翻转
      const out = await api.post(`/store-ops/soldout/${dish.id}/toggle`, { soldout: !dish.soldout });
      message.success(out.soldout ? `「${dish.name}」已标记沽清` : `「${dish.name}」恢复供应`);
      await load();
    } catch {
      /* client 已 toast */
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="sop-soldout">
      <Alert
        type={data.soldoutCount ? 'warning' : 'success'}
        showIcon
        message={
          data.soldoutCount
            ? `今日已沽清 ${data.soldoutCount} 个菜品——点单、外卖记得同步下架`
            : '今日全菜单可供——某个菜卖完了就点它标沽清，前厅后厨都看得到'
        }
      />
      {(data.frequentSoldout || []).length > 0 && (
        <Alert
          type="error"
          showIcon
          message="备货预警：这些菜近 7 天频繁卖断，备货量该上调了"
          description={
            <span>
              {(data.frequentSoldout || []).map(item => (
                <Tag color="volcano" key={item.name}>
                  {item.name} · 沽清 {item.days} 天
                </Tag>
              ))}
              <small style={{ color: 'var(--ui-muted)' }}>
                频繁沽清 =
                白丢的营业额；按行业做法：上调备货基数，并检查是不是原料供应问题（可到「库存订货」核对安全线）。
              </small>
            </span>
          }
        />
      )}
      {Object.entries(groups).map(([category, dishes]) => (
        <section className="sop-soldout-group" key={category}>
          <header>{category}</header>
          <div className="sop-soldout-grid">
            {dishes.map(dish => (
              <button
                type="button"
                key={dish.id}
                className="sop-dish"
                data-soldout={dish.soldout || undefined}
                disabled={busyId === dish.id}
                onClick={() => void toggle(dish)}
                title={dish.soldout ? `${dish.markedBy || ''} 标记沽清，点击恢复` : '点击标记沽清'}
              >
                <strong>{dish.name}</strong>
                <span>{dish.soldout ? '已沽清' : `¥${dish.price ?? '-'}`}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ShiftAttendance() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [mine, setMine] = useState<any>(null);
  const [clocking, setClocking] = useState('');
  // 周起点：空 = 本周；周日排下周班是行业常规动作，必须能翻页
  const [weekStart, setWeekStart] = useState('');
  const user = getUser();

  const load = useCallback(
    () =>
      Promise.all([
        api.get(`/store-ops/shifts/week${weekStart ? `?start=${weekStart}` : ''}`),
        api.get('/store-ops/attendance/mine'),
      ])
        .then(([week, attendance]) => {
          setData(week);
          setMine(attendance);
        })
        .catch((err: any) => setError(err?.message || '排班数据读取失败')),
    [weekStart],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Alert type="error" showIcon message={error} />;
  if (!data) return <Skeleton active paragraph={{ rows: 6 }} />;

  const shiftWeekBy = (deltaDays: number) => {
    const base = new Date(`${data.dates[0]}T00:00:00`);
    base.setDate(base.getDate() + deltaDays);
    setWeekStart(base.toLocaleDateString('sv-SE'));
  };
  const isCurrentWeek = (() => {
    const now = new Date();
    const day = now.getDay() || 7;
    now.setDate(now.getDate() - day + 1);
    return data.dates[0] === now.toLocaleDateString('sv-SE');
  })();

  const templateMap = new Map<string, any>(data.templates.map((tpl: any) => [tpl.key, tpl]));
  const assignmentMap = new Map<string, string>(
    data.assignments.map((row: any) => [`${row.user_id}:${row.date}`, row.shift_key]),
  );
  const attendanceMap = new Map<string, any>(data.attendance.map((row: any) => [`${row.user_id}:${row.date}`, row]));
  // 本地时区取“今天”：toISOString 是 UTC，晚间会把“今天”高亮标错一天
  const todayStr = new Date().toLocaleDateString('sv-SE');

  const assign = async (userId: number, date: string, shiftKey: string | undefined) => {
    try {
      await api.put('/store-ops/shifts/assign', { userId, date, shiftKey: shiftKey || '' });
      await load();
    } catch {
      /* client 已 toast */
    }
  };

  const clock = async (direction: 'in' | 'out') => {
    setClocking(direction);
    try {
      const out = await api.post('/store-ops/attendance/clock', { direction });
      message.success(`${direction === 'in' ? '上班' : '下班'}打卡成功 ${out.time}`);
      await load();
    } catch {
      /* client 已 toast */
    } finally {
      setClocking('');
    }
  };

  return (
    <div className="sop-shifts">
      <div className="sop-clock">
        <div className="sop-clock-copy">
          <strong>
            <ClockCircleOutlined /> 今日打卡
          </strong>
          <span>
            {mine?.today?.clock_in ? `上班 ${mine.today.clock_in}` : '未打上班卡'}
            {' · '}
            {mine?.today?.clock_out ? `下班 ${mine.today.clock_out}` : '未打下班卡'}
          </span>
        </div>
        <div className="sop-clock-actions">
          <Button
            type="primary"
            loading={clocking === 'in'}
            disabled={Boolean(mine?.today?.clock_in)}
            onClick={() => void clock('in')}
          >
            上班打卡
          </Button>
          <Button
            loading={clocking === 'out'}
            disabled={!mine?.today?.clock_in || Boolean(mine?.today?.clock_out)}
            onClick={() => void clock('out')}
          >
            下班打卡
          </Button>
        </div>
      </div>

      <div className="sop-week">
        <header className="sop-week-head">
          <strong>{isCurrentWeek ? '本周排班' : `${String(data.dates[0]).slice(5)} 起一周排班`}</strong>
          <span>{data.canSchedule ? '点格子选班次即可排班（早/中/晚/全/休）' : '排班由店长安排，这里看你的班次'}</span>
          <Space size={4} className="sop-week-nav">
            <Button size="small" onClick={() => shiftWeekBy(-7)}>
              上一周
            </Button>
            <Button size="small" disabled={isCurrentWeek} onClick={() => setWeekStart('')}>
              本周
            </Button>
            <Button size="small" onClick={() => shiftWeekBy(7)}>
              下一周
            </Button>
          </Space>
        </header>
        <div className="sop-week-table" role="table" aria-label="本周排班表">
          <div className="sop-week-row sop-week-row-head" role="row">
            <span className="sop-week-name">员工</span>
            {data.dates.map((date: string) => (
              <span key={date} data-today={date === todayStr || undefined}>
                {date.slice(5)}
                <small>{'日一二三四五六'[new Date(`${date}T00:00:00`).getDay()]}</small>
              </span>
            ))}
          </div>
          {data.staff.map((staff: any) => (
            <div className="sop-week-row" role="row" key={staff.id} data-me={staff.id === user?.id || undefined}>
              <span className="sop-week-name">
                {staff.name}
                {staff.id === user?.id && <Tag>我</Tag>}
              </span>
              {data.dates.map((date: string) => {
                const key = `${staff.id}:${date}`;
                const shiftKey = assignmentMap.get(key);
                const template = shiftKey ? templateMap.get(shiftKey) : null;
                const attendance = attendanceMap.get(key);
                return (
                  <span key={date} className="sop-week-cell" data-today={date === todayStr || undefined}>
                    {data.canSchedule ? (
                      <Select
                        size="small"
                        variant="borderless"
                        placeholder="—"
                        value={shiftKey || undefined}
                        style={{ width: '100%' }}
                        allowClear
                        options={data.templates.map((tpl: any) => ({ value: tpl.key, label: tpl.label }))}
                        onChange={value => void assign(staff.id, date, value)}
                      />
                    ) : template ? (
                      <Tooltip title={template.time}>
                        <i
                          className="sop-shift-pill"
                          style={{ background: `${template.color}22`, color: template.color }}
                        >
                          {template.label}
                        </i>
                      </Tooltip>
                    ) : (
                      <i className="sop-shift-none">—</i>
                    )}
                    {attendance?.clock_in && (
                      <small
                        className="sop-attend-mark"
                        title={`上班 ${attendance.clock_in}${attendance.clock_out ? ` · 下班 ${attendance.clock_out}` : ''}`}
                      >
                        <CheckCircleFilled />
                      </small>
                    )}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function InventoryBoard() {
  const [data, setData] = useState<{ items: any[]; lowCount: number } | null>(null);
  const [error, setError] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [addForm] = Form.useForm();
  const [moveItem, setMoveItem] = useState<any>(null);
  const [moveForm] = Form.useForm();
  const [reorder, setReorder] = useState<any[] | null>(null);

  const load = useCallback(
    () =>
      api
        .get('/store-ops/inventory')
        .then(setData)
        .catch((err: any) => setError(err?.message || '库存读取失败')),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Alert type="error" showIcon message={error} />;
  if (!data) return <Skeleton active paragraph={{ rows: 5 }} />;

  const submitAdd = async () => {
    try {
      const values = await addForm.validateFields();
      await api.post('/store-ops/inventory', values);
      message.success('物料已建档');
      setAddOpen(false);
      addForm.resetFields();
      await load();
    } catch {
      /* 校验失败留在表单；接口失败 client 已 toast */
    }
  };

  const submitMove = async () => {
    try {
      const values = await moveForm.validateFields();
      const out = await api.post(`/store-ops/inventory/${moveItem.id}/move`, values);
      message.success(`「${moveItem.name}」现有 ${out.quantity}${moveItem.unit}`);
      setMoveItem(null);
      moveForm.resetFields();
      await load();
    } catch {
      /* 校验失败留在表单；接口失败 client 已 toast */
    }
  };

  const showReorder = async () => {
    try {
      const out = await api.get('/store-ops/inventory/reorder');
      setReorder(out.items || []);
    } catch {
      /* client 已 toast */
    }
  };

  return (
    <div className="sop-inventory">
      <div className="sop-inventory-toolbar">
        <Alert
          type={data.lowCount ? 'warning' : 'success'}
          showIcon
          message={
            data.lowCount ? `${data.lowCount} 项物料低于安全线——点「生成订货清单」按缺口订货` : '库存都在安全线以上'
          }
          style={{ flex: 1 }}
        />
        <Space>
          <Button icon={<RocketOutlined />} onClick={() => void showReorder()}>
            生成订货清单
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
            建物料
          </Button>
        </Space>
      </div>
      <small className="sop-inventory-benchmark">
        行业基准参考：损耗率 ≤3%、库存周转 5~8 天、盘点差异 ≤1%；高损耗物料建议每日盘点、常温干货两日一盘、周末全盘。
      </small>
      {data.items.length === 0 ? (
        <Empty description="还没有库存物料；把常用食材/物料建档，每天盘一次就能自动提醒订货">
          <Button type="primary" onClick={() => setAddOpen(true)}>
            建第一个物料
          </Button>
        </Empty>
      ) : (
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={data.items}
          columns={[
            {
              title: '物料',
              dataIndex: 'name',
              render: (value: string, row: any) => (
                <Space size={6}>
                  <strong>{value}</strong>
                  {Number(row.quantity) < Number(row.safe_line) && <Tag color="error">低于安全线</Tag>}
                </Space>
              ),
            },
            { title: '分类', dataIndex: 'category', width: 100, render: (value: string) => value || '—' },
            {
              title: '当前量',
              dataIndex: 'quantity',
              width: 110,
              render: (value: number, row: any) => (
                <b style={{ color: Number(value) < Number(row.safe_line) ? 'var(--danger)' : 'var(--ui-text)' }}>
                  {value} {row.unit}
                </b>
              ),
            },
            {
              title: '安全线',
              dataIndex: 'safe_line',
              width: 90,
              render: (value: number, row: any) => `${value} ${row.unit}`,
            },
            {
              title: '最近更新',
              dataIndex: 'updated_at',
              width: 150,
              render: (value: string, row: any) => (
                <span style={{ color: 'var(--ui-muted)', fontSize: 12 }}>
                  {String(value || '').slice(5, 16)} {row.updated_by_name || ''}
                </span>
              ),
            },
            {
              title: '操作',
              width: 170,
              render: (_: any, row: any) => (
                <Space size={4}>
                  {['入库', '出库', '盘点修正'].map(reason => (
                    <Button
                      key={reason}
                      size="small"
                      onClick={() => {
                        setMoveItem(row);
                        moveForm.setFieldsValue({ reason, value: undefined, note: '' });
                      }}
                    >
                      {reason.slice(0, 2)}
                    </Button>
                  ))}
                </Space>
              ),
            },
          ]}
        />
      )}

      <Modal
        title="新建库存物料"
        open={addOpen}
        okText="保存"
        onOk={() => void submitAdd()}
        onCancel={() => {
          setAddOpen(false);
          addForm.resetFields();
        }}
      >
        <Form form={addForm} layout="vertical" initialValues={{ unit: 'kg', quantity: 0, safeLine: 0 }}>
          <Form.Item name="name" label="物料名称" rules={[{ required: true, message: '如：烧鹅胚 / 大米 / 打包盒' }]}>
            <Input maxLength={60} placeholder="烧鹅胚 / 大米 / 打包盒" />
          </Form.Item>
          <Form.Item name="category" label="分类">
            <Input maxLength={30} placeholder="肉类 / 干货 / 耗材" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="quantity" label="当前量" style={{ flex: 1 }}>
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="unit" label="单位" style={{ flex: 1 }}>
              <Input maxLength={10} />
            </Form.Item>
            <Form.Item name="safeLine" label="安全线" style={{ flex: 1 }} tooltip="低于这个量就提醒订货">
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      <Modal
        title={moveItem ? `${moveItem.name}（现有 ${moveItem.quantity}${moveItem.unit}）` : ''}
        open={Boolean(moveItem)}
        okText="记一笔"
        onOk={() => void submitMove()}
        onCancel={() => {
          setMoveItem(null);
          moveForm.resetFields();
        }}
      >
        <Form form={moveForm} layout="vertical">
          <Form.Item name="reason" label="变动类型" rules={[{ required: true }]}>
            <Select
              options={[
                { value: '入库', label: '入库（收货）' },
                { value: '出库', label: '出库（领用/损耗）' },
                { value: '盘点修正', label: '盘点修正（直接改成实际数量）' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="value"
            label="数量"
            rules={[{ required: true, message: '填数量' }]}
            tooltip="入库/出库填变动量；盘点修正填盘点后的实际数量"
          >
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input maxLength={100} placeholder="如：早市备货 / 供应商到货" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="订货清单（按安全线缺口）"
        open={reorder !== null}
        footer={
          <Button type="primary" onClick={() => setReorder(null)}>
            知道了
          </Button>
        }
        onCancel={() => setReorder(null)}
      >
        {reorder && reorder.length ? (
          <ul className="sop-reorder-list">
            {reorder.map(item => (
              <li key={item.name}>
                <strong>{item.name}</strong>
                <span>
                  现有 {item.quantity}
                  {item.unit} / 安全线 {item.safe_line}
                  {item.unit}
                </span>
                <b>
                  建议订 {item.gap}
                  {item.unit}
                </b>
              </li>
            ))}
          </ul>
        ) : (
          <Empty description="没有低于安全线的物料，暂时不用订货" />
        )}
      </Modal>
    </div>
  );
}

function DeliveryDaily() {
  const [data, setData] = useState<{ rows: any[]; summary: any } | null>(null);
  const [error, setError] = useState('');
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    () =>
      api
        .get('/store-ops/delivery-daily')
        .then(setData)
        .catch((err: any) => setError(err?.message || '外卖日报读取失败')),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Alert type="error" showIcon message={error} />;
  if (!data) return <Skeleton active paragraph={{ rows: 5 }} />;

  const submit = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      // DatePicker 给的是 dayjs 对象，转成后端要的 YYYY-MM-DD；不选默认今天
      await api.post('/store-ops/delivery-daily', {
        ...values,
        date: values.date ? values.date.format('YYYY-MM-DD') : undefined,
      });
      message.success('外卖日报已记录（同日同平台会覆盖更新）');
      form.resetFields(['orders', 'revenue', 'rating', 'avgPrepMinutes', 'badReviews']);
      await load();
    } catch {
      /* 校验失败留在表单；接口失败 client 已 toast */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sop-delivery">
      <div className="sop-delivery-stats">
        <div>
          <strong>{data.summary.weekOrders}</strong>
          <span>近7天单量</span>
        </div>
        <div>
          <strong>¥{Number(data.summary.weekRevenue).toLocaleString()}</strong>
          <span>近7天营收</span>
        </div>
        <div>
          <strong>{data.summary.weekAvgRating ?? '—'}</strong>
          <span>近7天均分</span>
        </div>
        <div data-alert={data.summary.weekBadReviews > 0 || undefined}>
          <strong>{data.summary.weekBadReviews}</strong>
          <span>近7天差评</span>
        </div>
      </div>

      <Form form={form} layout="inline" className="sop-delivery-form" initialValues={{ platform: '美团' }}>
        <Form.Item name="platform" rules={[{ required: true }]}>
          <Select
            style={{ width: 100 }}
            options={['美团', '饿了么', '其他'].map(item => ({ value: item, label: item }))}
          />
        </Form.Item>
        <Form.Item name="date">
          <DatePicker placeholder="日期（默认今天）" style={{ width: 150 }} />
        </Form.Item>
        <Form.Item name="orders" rules={[{ required: true, message: '单量' }]}>
          <InputNumber min={0} placeholder="单量" style={{ width: 90 }} />
        </Form.Item>
        <Form.Item name="revenue" rules={[{ required: true, message: '营收' }]}>
          <InputNumber min={0} placeholder="营收¥" style={{ width: 110 }} />
        </Form.Item>
        <Form.Item name="rating">
          <InputNumber min={0} max={5} step={0.1} placeholder="评分" style={{ width: 90 }} />
        </Form.Item>
        <Form.Item name="avgPrepMinutes">
          <InputNumber min={0} placeholder="出餐分钟" style={{ width: 110 }} />
        </Form.Item>
        <Form.Item name="badReviews">
          <InputNumber min={0} placeholder="差评数" style={{ width: 90 }} />
        </Form.Item>
        <Button type="primary" loading={saving} onClick={() => void submit()}>
          记一笔
        </Button>
      </Form>

      {data.rows.length === 0 ? (
        <Empty description="还没有外卖日报；每天打烊后花 30 秒把平台数据抄进来，趋势就出来了" />
      ) : (
        <Table
          size="small"
          rowKey="id"
          pagination={{ pageSize: 14 }}
          dataSource={data.rows}
          columns={[
            { title: '日期', dataIndex: 'date', width: 110 },
            { title: '平台', dataIndex: 'platform', width: 80 },
            { title: '单量', dataIndex: 'orders', width: 70 },
            {
              title: '营收',
              dataIndex: 'revenue',
              width: 100,
              render: (value: number) => `¥${Number(value).toLocaleString()}`,
            },
            {
              title: '评分',
              dataIndex: 'rating',
              width: 80,
              render: (value: number | null) =>
                value == null ? '—' : <b style={{ color: value < 4.5 ? 'var(--warn)' : 'var(--ok)' }}>{value}</b>,
            },
            {
              title: '出餐(分)',
              dataIndex: 'avg_prep_minutes',
              width: 90,
              render: (value: number | null) => (value == null ? '—' : value),
            },
            {
              title: '差评',
              dataIndex: 'bad_reviews',
              width: 70,
              render: (value: number) => (value > 0 ? <b style={{ color: 'var(--danger)' }}>{value}</b> : 0),
            },
          ]}
        />
      )}
    </div>
  );
}

function MorningBrief() {
  const [brief, setBrief] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setLoading(true);
    setError('');
    try {
      const out = await api.post('/store-ops/morning-brief', {});
      setBrief(out.brief || '');
      if (out.billing?.chargedCredits != null) message.success(`晨会要点已生成（${out.billing.chargedCredits} 积分）`);
    } catch (err: any) {
      setError(err?.message || '晨会要点生成失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="sop-brief">
      <div className="sop-brief-head">
        <div>
          <strong>
            <SoundOutlined /> AI 晨会要点
          </strong>
          <span>按昨天的真实营收、日报、差评和今日排班生成，店长照着念就能开晨会</span>
        </div>
        <Button type="primary" icon={<AudioOutlined />} loading={loading} onClick={() => void run()}>
          {loading ? '正在读昨日数据…' : brief ? '重新生成' : '生成今日晨会要点'}
        </Button>
      </div>
      {error && <Alert type="error" showIcon message={error} />}
      {brief && <pre className="sop-brief-text">{brief}</pre>}
    </div>
  );
}

export default function StoreOps() {
  // 多门店：顶栏切换门店后各台账按新门店重拉（用 key 重挂子面板，保留当前页签）
  const storeVersion = useStoreVersion();
  const [activeTab, setActiveTab] = useState('checklists');
  return (
    <div className="sop-page" key={storeVersion}>
      <header className="sop-head">
        <div>
          <span className="sop-kicker">门店日常 · 每天开门要干的活</span>
          <h1>日清 · 沽清 · 排班考勤</h1>
          <p>勾一项留一条痕：谁做的、几点做的都有记录；完成率和漏检直接进老板驾驶舱。</p>
        </div>
      </header>
      <MorningBrief />
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'checklists',
            label: (
              <span>
                <CheckCircleFilled /> 今日日清
              </span>
            ),
            children: <DailyChecklists />,
          },
          {
            key: 'soldout',
            label: (
              <span>
                <CoffeeOutlined /> 沽清板
              </span>
            ),
            children: <SoldoutBoard />,
          },
          {
            key: 'shifts',
            label: (
              <span>
                <ScheduleOutlined /> 排班考勤
              </span>
            ),
            children: <ShiftAttendance />,
          },
          {
            key: 'inventory',
            label: (
              <span>
                <InboxOutlined /> 库存订货
              </span>
            ),
            children: <InventoryBoard />,
          },
          {
            key: 'delivery',
            label: (
              <span>
                <RocketOutlined /> 外卖日报
              </span>
            ),
            children: <DeliveryDaily />,
          },
        ]}
      />
    </div>
  );
}
