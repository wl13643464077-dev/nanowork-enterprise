import { useCallback, useEffect, useState } from 'react';
import {
  Tabs,
  Table,
  Tag,
  Badge,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  DatePicker,
  Space,
  Popconfirm,
  message,
  Empty,
  Alert,
} from 'antd';
import {
  PlusOutlined,
  ReloadOutlined,
  ShopOutlined,
  CoffeeOutlined,
  PayCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  BarChartOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { api, fmtMoney, getUser } from '../api/client';
import { useStoreVersion } from '../api/store-context';
import { Panel } from '../components/Kit';
import StoreCompare from '../components/StoreCompare';
import './StoreData.css';

const BIZ_TYPES = ['快餐', '正餐', '茶饮', '火锅', '其他'];
const STORE_STATUSES = ['营业中', '筹备中', '已关店'];
const DISH_STATUSES = ['在售', '下架'];
const COST_CATEGORIES = ['食材', '人力', '房租', '水电', '营销', '其他'];
const storeStatusColor: Record<string, string> = {
  营业中: 'var(--chart-2)',
  筹备中: 'var(--warn)',
  已关店: 'var(--ui-muted)',
};
const costCatColor: Record<string, string> = {
  食材: 'green',
  人力: 'blue',
  房租: 'purple',
  水电: 'cyan',
  营销: 'orange',
  其他: 'default',
};

// 加载失败可重试的统一空态/错误态
function LoadState({ error, onRetry, emptyText }: { error: boolean; onRetry: () => void; emptyText: string }) {
  if (error) {
    return (
      <div style={{ textAlign: 'center', padding: '28px 0' }}>
        <div style={{ color: 'var(--ui-text-2)', fontSize: 13, marginBottom: 10 }}>数据加载失败，请检查网络后重试</div>
        <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>
          重新加载
        </Button>
      </div>
    );
  }
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={<span style={{ color: 'var(--ui-muted)', fontSize: 12.5 }}>{emptyText}</span>}
    />
  );
}

const ROLE_LABEL: Record<string, string> = {
  boss: '老板',
  admin: '管理员',
  ops_director: '门店运营',
  manager: '店长',
  sales: '员工',
};

export default function StoreData() {
  // 多门店：顶栏切换门店后（store-changed）三张表按新门店上下文重拉
  const storeVersion = useStoreVersion();
  const canCompare = ['boss', 'admin', 'ops_director'].includes(String(getUser()?.role || ''));
  // ===== 门店 =====
  const [activeTab, setActiveTab] = useState('stores');
  const [stores, setStores] = useState<any[]>([]);
  const [storesLoading, setStoresLoading] = useState(false);
  const [storesError, setStoresError] = useState(false);
  const [storeModal, setStoreModal] = useState<{ open: boolean; editing: any }>({ open: false, editing: null });
  const [storeForm] = Form.useForm();
  const [staff, setStaff] = useState<any[]>([]);

  // ===== 菜品 =====
  const [dishes, setDishes] = useState<any[]>([]);
  const [dishesLoading, setDishesLoading] = useState(false);
  const [dishesError, setDishesError] = useState(false);
  const [dishStore, setDishStore] = useState<number | undefined>();
  const [dishStatus, setDishStatus] = useState<string | undefined>();
  const [dishModal, setDishModal] = useState<{ open: boolean; editing: any }>({ open: false, editing: null });
  const [dishForm] = Form.useForm();

  // ===== 成本 =====
  const [costs, setCosts] = useState<{ rows: any[]; sum: number }>({ rows: [], sum: 0 });
  const [costsLoading, setCostsLoading] = useState(false);
  const [costsError, setCostsError] = useState(false);
  const [costMonth, setCostMonth] = useState(dayjs());
  const [costStore, setCostStore] = useState<number | undefined>();
  const [costModal, setCostModal] = useState(false);
  const [costForm] = Form.useForm();

  const loadStores = useCallback(() => {
    setStoresLoading(true);
    setStoresError(false);
    api
      .get('/store-data/stores')
      .then(d => setStores(d.rows || []))
      .catch(() => setStoresError(true))
      .finally(() => setStoresLoading(false));
  }, []);
  const loadDishes = useCallback(() => {
    setDishesLoading(true);
    setDishesError(false);
    const qs = new URLSearchParams();
    if (dishStore) qs.set('store_id', String(dishStore));
    if (dishStatus) qs.set('status', dishStatus);
    api
      .get(`/store-data/dishes${qs.toString() ? `?${qs}` : ''}`)
      .then(d => setDishes(d.rows || []))
      .catch(() => setDishesError(true))
      .finally(() => setDishesLoading(false));
  }, [dishStatus, dishStore]);
  const loadCosts = useCallback(() => {
    setCostsLoading(true);
    setCostsError(false);
    const qs = new URLSearchParams({ month: costMonth.format('YYYY-MM') });
    if (costStore) qs.set('store_id', String(costStore));
    api
      .get(`/store-data/costs?${qs}`)
      .then(d => setCosts({ rows: d.rows || [], sum: d.sum || 0 }))
      .catch(() => setCostsError(true))
      .finally(() => setCostsLoading(false));
  }, [costMonth, costStore]);

  useEffect(() => {
    const frame = requestAnimationFrame(loadStores);
    return () => cancelAnimationFrame(frame);
  }, [loadStores, storeVersion]);
  useEffect(() => {
    const frame = requestAnimationFrame(loadDishes);
    return () => cancelAnimationFrame(frame);
  }, [loadDishes, storeVersion]);
  useEffect(() => {
    const frame = requestAnimationFrame(loadCosts);
    return () => cancelAnimationFrame(frame);
  }, [loadCosts, storeVersion]);
  useEffect(() => {
    api
      .get('/store-data/staff', { silent: true })
      .then(d => setStaff(d.rows || []))
      .catch(() => setStaff([]));
  }, []);

  const storeOptions = stores.map(s => ({ value: s.id, label: s.name }));
  const staffOptions = staff.map(u => ({
    value: u.id,
    label: `${u.name}（${ROLE_LABEL[u.role] || u.role}）`,
  }));

  // ===== 门店提交/删除 =====
  const openStoreModal = (editing: any = null) => {
    setStoreModal({ open: true, editing });
    storeForm.setFieldsValue(
      editing
        ? {
            ...editing,
            opened_at: editing.opened_at ? dayjs(editing.opened_at) : undefined,
            is_default: Number(editing.is_default) === 1,
            manager_user_id: editing.manager_user_id ?? undefined,
          }
        : { biz_type: '快餐', status: '营业中', is_default: stores.length === 0 },
    );
  };
  const submitStore = async () => {
    const v = await storeForm.validateFields();
    const payload = {
      ...v,
      opened_at: v.opened_at ? v.opened_at.format('YYYY-MM-DD') : undefined,
      manager_user_id: v.manager_user_id ?? null,
      // 默认店只能「设为默认」，不能直接取消（服务端同样拒绝）；未勾选则不传
      is_default: v.is_default ? 1 : undefined,
    };
    if (storeModal.editing) {
      await api.put(`/store-data/stores/${storeModal.editing.id}`, payload);
      message.success('门店已更新');
    } else {
      await api.post('/store-data/stores', payload);
      message.success('门店已创建');
    }
    setStoreModal({ open: false, editing: null });
    storeForm.resetFields();
    loadStores();
  };
  const deleteStore = (row: any) => {
    api
      .del(`/store-data/stores/${row.id}`)
      .then(() => {
        message.success('门店已删除');
        loadStores();
      })
      .catch(() => {});
  };

  // ===== 菜品提交/上下架 =====
  const openDishModal = (editing: any = null) => {
    setDishModal({ open: true, editing });
    dishForm.setFieldsValue(editing || { store_id: dishStore, status: '在售', price: 0, cost: 0 });
  };
  const submitDish = async () => {
    const v = await dishForm.validateFields();
    if (dishModal.editing) {
      await api.put(`/store-data/dishes/${dishModal.editing.id}`, v);
      message.success('菜品已更新');
    } else {
      await api.post('/store-data/dishes', v);
      message.success('菜品已创建');
    }
    setDishModal({ open: false, editing: null });
    dishForm.resetFields();
    loadDishes();
    loadStores();
  };
  const toggleDishStatus = (row: any) => {
    const next = row.status === '在售' ? '下架' : '在售';
    api
      .post(`/store-data/dishes/${row.id}/status`, { status: next })
      .then(() => {
        message.success(`菜品已${next === '在售' ? '重新上架' : '下架'}`);
        loadDishes();
      })
      .catch(() => {});
  };

  // ===== 成本提交/删除 =====
  const submitCost = async () => {
    const v = await costForm.validateFields();
    await api.post('/store-data/costs', { ...v, date: v.date.format('YYYY-MM-DD') });
    message.success('成本已登记');
    setCostModal(false);
    costForm.resetFields();
    loadCosts();
    loadStores();
  };
  const deleteCost = (row: any) => {
    api
      .del(`/store-data/costs/${row.id}`)
      .then(() => {
        message.success('成本记录已删除');
        loadCosts();
        loadStores();
      })
      .catch(() => {});
  };

  const storesTab = (
    <Panel
      title={
        <>
          <ShopOutlined style={{ color: 'var(--ui-accent)' }} /> 门店档案
        </>
      }
      extra={
        <Space size={8}>
          <Button size="small" icon={<ReloadOutlined />} onClick={loadStores}>
            刷新
          </Button>
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openStoreModal()}>
            新建门店
          </Button>
        </Space>
      }
    >
      <Table
        size="small"
        rowKey="id"
        loading={storesLoading}
        dataSource={storesError ? [] : stores}
        pagination={{ pageSize: 10, size: 'small', showTotal: t => `共 ${t} 家门店` }}
        locale={{
          emptyText: (
            <LoadState
              error={storesError}
              onRetry={loadStores}
              emptyText="还没有门店档案。先录入门店，再登记菜品和成本，驾驶舱即可展示真实客单价、毛利率与经营利润率。"
            />
          ),
        }}
        columns={[
          {
            title: '门店',
            dataIndex: 'name',
            ellipsis: true,
            render: (v: string, r: any) => (
              <span className="sd-store-name">
                {v}
                {Number(r.is_default) === 1 && <Tag className="sd-default-tag">默认</Tag>}
              </span>
            ),
          },
          {
            title: '编码',
            dataIndex: 'code',
            width: 90,
            render: (v: string) => v || <span style={{ color: 'var(--ui-muted)' }}>-</span>,
          },
          {
            title: '业态',
            dataIndex: 'biz_type',
            width: 78,
            render: (v: string) => <Tag style={{ margin: 0 }}>{v}</Tag>,
          },
          {
            title: '区域',
            dataIndex: 'region',
            width: 90,
            ellipsis: true,
            render: (v: string) => v || <span className="sd-muted">-</span>,
          },
          {
            title: '城市/商圈',
            key: 'cityArea',
            width: 140,
            ellipsis: true,
            render: (_: any, r: any) =>
              [r.city, r.area].filter(Boolean).join(' · ') || <span style={{ color: 'var(--ui-muted)' }}>-</span>,
          },
          {
            title: '负责人',
            dataIndex: 'manager_name',
            width: 90,
            ellipsis: true,
            render: (v: string) => v || <span className="sd-muted">-</span>,
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 84,
            render: (v: string) => (
              <Badge
                color={storeStatusColor[v] || 'var(--ui-muted)'}
                text={<span style={{ fontSize: 12 }}>{v}</span>}
              />
            ),
          },
          { title: '菜品', dataIndex: 'dish_count', width: 64, align: 'right' as const },
          { title: '成本记录', dataIndex: 'cost_count', width: 78, align: 'right' as const },
          {
            title: '开业时间',
            dataIndex: 'opened_at',
            width: 100,
            render: (v: string) => <span style={{ color: 'var(--ui-muted)', fontSize: 12 }}>{v || '-'}</span>,
          },
          {
            title: '操作',
            key: 'op',
            width: 160,
            render: (_: any, r: any) => (
              <Space size={6}>
                <Button size="small" icon={<EditOutlined />} onClick={() => openStoreModal(r)}>
                  编辑
                </Button>
                <Popconfirm
                  title={`删除门店「${r.name}」？`}
                  description="有关联菜品或成本记录时会被拒绝。"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => deleteStore(r)}
                >
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
    </Panel>
  );

  const dishesTab = (
    <Panel
      title={
        <>
          <CoffeeOutlined style={{ color: 'var(--chart-2)' }} /> 菜品目录
        </>
      }
      extra={
        <Space size={8}>
          <Select
            size="small"
            placeholder="门店"
            allowClear
            style={{ width: 140 }}
            value={dishStore}
            options={storeOptions}
            onChange={v => setDishStore(v)}
          />
          <Select
            size="small"
            placeholder="状态"
            allowClear
            style={{ width: 90 }}
            value={dishStatus}
            options={DISH_STATUSES.map(s => ({ value: s, label: s }))}
            onChange={v => setDishStatus(v)}
          />
          <Button size="small" icon={<ReloadOutlined />} onClick={loadDishes}>
            刷新
          </Button>
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            disabled={!stores.length}
            onClick={() => openDishModal()}
          >
            新建菜品
          </Button>
        </Space>
      }
    >
      {!stores.length && !storesLoading && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="请先在「门店」页签创建门店，再登记菜品。录入菜品后，驾驶舱可显示真实客单与毛利。"
        />
      )}
      <Table
        size="small"
        rowKey="id"
        loading={dishesLoading}
        dataSource={dishesError ? [] : dishes}
        pagination={{ pageSize: 10, size: 'small', showTotal: t => `共 ${t} 个菜品` }}
        locale={{
          emptyText: (
            <LoadState
              error={dishesError}
              onRetry={loadDishes}
              emptyText="暂无菜品。录入菜品并在订单上登记明细后，驾驶舱可显示真实客单价与菜品销量TOP。"
            />
          ),
        }}
        columns={[
          {
            title: '菜品',
            dataIndex: 'name',
            ellipsis: true,
            render: (v: string) => <span style={{ fontWeight: 600, color: 'var(--ui-text)' }}>{v}</span>,
          },
          { title: '门店', dataIndex: 'store_name', width: 130, ellipsis: true },
          {
            title: '分类',
            dataIndex: 'category',
            width: 90,
            render: (v: string) =>
              v ? <Tag style={{ margin: 0 }}>{v}</Tag> : <span style={{ color: 'var(--ui-muted)' }}>-</span>,
          },
          {
            title: '售价',
            dataIndex: 'price',
            width: 90,
            align: 'right' as const,
            render: (v: number) => <span style={{ fontWeight: 600 }}>{fmtMoney(v)}</span>,
          },
          {
            title: '成本',
            dataIndex: 'cost',
            width: 90,
            align: 'right' as const,
            render: (v: number) => <span style={{ color: 'var(--ui-text-2)' }}>{fmtMoney(v)}</span>,
          },
          { title: '单位', dataIndex: 'unit', width: 60, render: (v: string) => v || '-' },
          {
            title: '状态',
            dataIndex: 'status',
            width: 72,
            render: (v: string) => (
              <Tag color={v === '在售' ? 'green' : 'default'} style={{ margin: 0 }}>
                {v}
              </Tag>
            ),
          },
          {
            title: '操作',
            key: 'op',
            width: 170,
            render: (_: any, r: any) => (
              <Space size={6}>
                <Button size="small" icon={<EditOutlined />} onClick={() => openDishModal(r)}>
                  编辑
                </Button>
                <Button size="small" onClick={() => toggleDishStatus(r)}>
                  {r.status === '在售' ? '下架' : '上架'}
                </Button>
              </Space>
            ),
          },
        ]}
      />
    </Panel>
  );

  const costsTab = (
    <Panel
      title={
        <>
          <PayCircleOutlined style={{ color: 'var(--warn)' }} /> 成本台账
        </>
      }
      extra={
        <Space size={8}>
          <DatePicker
            picker="month"
            size="small"
            allowClear={false}
            value={costMonth}
            onChange={v => v && setCostMonth(v)}
            style={{ width: 120 }}
          />
          <Select
            size="small"
            placeholder="门店"
            allowClear
            style={{ width: 140 }}
            value={costStore}
            options={storeOptions}
            onChange={v => setCostStore(v)}
          />
          <Tag color="gold" style={{ margin: 0 }}>
            本页合计 {fmtMoney(costs.sum)}
          </Tag>
          <Button size="small" icon={<ReloadOutlined />} onClick={loadCosts}>
            刷新
          </Button>
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            disabled={!stores.length}
            onClick={() => {
              costForm.setFieldsValue({ date: dayjs(), category: '食材', store_id: costStore });
              setCostModal(true);
            }}
          >
            登记成本
          </Button>
        </Space>
      }
    >
      {!stores.length && !storesLoading && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="请先在「门店」页签创建门店，再登记成本。食材成本用于毛利率，全部成本用于经营利润率与盈亏平衡进度。"
        />
      )}
      <Table
        size="small"
        rowKey="id"
        loading={costsLoading}
        dataSource={costsError ? [] : costs.rows}
        pagination={{ pageSize: 10, size: 'small', showTotal: t => `共 ${t} 条成本记录` }}
        locale={{
          emptyText: (
            <LoadState
              error={costsError}
              onRetry={loadCosts}
              emptyText="当月暂无成本记录。登记食材、人力、房租等成本后，驾驶舱才会按不同口径计算毛利率和经营利润率。"
            />
          ),
        }}
        columns={[
          { title: '日期', dataIndex: 'date', width: 100 },
          { title: '门店', dataIndex: 'store_name', width: 130, ellipsis: true },
          {
            title: '类别',
            dataIndex: 'category',
            width: 80,
            render: (v: string) => (
              <Tag color={costCatColor[v] || 'default'} style={{ margin: 0 }}>
                {v}
              </Tag>
            ),
          },
          {
            title: '金额',
            dataIndex: 'amount',
            width: 100,
            align: 'right' as const,
            render: (v: number) => <span style={{ fontWeight: 600 }}>{fmtMoney(v)}</span>,
          },
          {
            title: '备注',
            dataIndex: 'note',
            ellipsis: true,
            render: (v: string) => v || <span style={{ color: 'var(--ui-muted)' }}>-</span>,
          },
          {
            title: '操作',
            key: 'op',
            width: 70,
            render: (_: any, r: any) => (
              <Popconfirm
                title="删除这条成本记录？"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => deleteCost(r)}
              >
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            ),
          },
        ]}
      />
    </Panel>
  );

  const monthCostRows = costs.rows.filter(
    (row: any) => String(row.cost_date || row.date || '').slice(0, 7) === dayjs().format('YYYY-MM'),
  ).length;
  const completeness = [
    { key: 'stores', label: '门店', count: stores.length, unit: '家', lights: '门店 KPI 与分店对比' },
    { key: 'dishes', label: '菜品', count: dishes.length, unit: '个', lights: '菜品 TOP 与客单价' },
    { key: 'costs', label: '本月成本', count: monthCostRows, unit: '条', lights: '毛利率与经营利润率' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div
        style={{
          background: 'var(--ui-surface)',
          border: '1px solid var(--ui-border)',
          borderRadius: 14,
          padding: '14px 18px',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ui-text)' }}>门店经营数据</div>
        <div style={{ fontSize: 12.5, color: 'var(--ui-text-2)', marginTop: 4 }}>
          门店、订单明细与成本台账是驾驶舱客单价、毛利率和经营利润率的事实来源；没有录入的数据不会被估算或编造。
        </div>
        {/* 数据完成度：缺哪样、影响驾驶舱哪张卡、一键去补录 */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {completeness.map(item => (
            <button
              type="button"
              key={item.key}
              onClick={() => setActiveTab(item.key)}
              title={`${item.label}数据点亮驾驶舱的：${item.lights}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                border: `1px solid ${item.count > 0 ? 'var(--ui-border)' : 'color-mix(in srgb, var(--warn) 45%, var(--ui-border))'}`,
                borderRadius: 999,
                background:
                  item.count > 0 ? 'var(--ui-surface)' : 'color-mix(in srgb, var(--warn) 8%, var(--ui-surface))',
                color: item.count > 0 ? 'var(--ui-text-2)' : 'var(--ui-warning-text, var(--warn))',
                font: 'inherit',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {item.label}
              <b style={{ fontVariantNumeric: 'tabular-nums' }}>
                {item.count} {item.unit}
              </b>
              {item.count === 0 && <span>· 待补录，影响{item.lights}</span>}
            </button>
          ))}
        </div>
      </div>
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          { key: 'stores', label: '门店', children: storesTab },
          { key: 'dishes', label: '菜品', children: dishesTab },
          { key: 'costs', label: '成本', children: costsTab },
          ...(canCompare
            ? [
                {
                  key: 'compare',
                  label: (
                    <span>
                      <BarChartOutlined /> 门店对比
                    </span>
                  ),
                  children: <StoreCompare storeCount={stores.length} />,
                },
              ]
            : []),
        ]}
      />

      {/* 门店表单 */}
      <Modal
        open={storeModal.open}
        title={storeModal.editing ? `编辑门店「${storeModal.editing.name}」` : '新建门店'}
        okText="保存"
        onOk={submitStore}
        onCancel={() => {
          setStoreModal({ open: false, editing: null });
          storeForm.resetFields();
        }}
        destroyOnClose
      >
        <Form form={storeForm} layout="vertical">
          <Form.Item
            name="name"
            label="门店名称"
            rules={[
              { required: true, message: '请填写门店名称' },
              { max: 60, message: '不超过60个字符' },
            ]}
          >
            <Input placeholder="例如：长风街旗舰店" />
          </Form.Item>
          <Space size={10} style={{ display: 'flex' }} align="start">
            <Form.Item name="code" label="门店编码" style={{ flex: 1 }}>
              <Input placeholder="可选" />
            </Form.Item>
            <Form.Item name="biz_type" label="业态" style={{ width: 140 }}>
              <Select options={BIZ_TYPES.map(t => ({ value: t, label: t }))} />
            </Form.Item>
            <Form.Item name="status" label="状态" style={{ width: 140 }}>
              <Select options={STORE_STATUSES.map(s => ({ value: s, label: s }))} />
            </Form.Item>
          </Space>
          <Space size={10} style={{ display: 'flex' }} align="start">
            <Form.Item name="city" label="城市" style={{ flex: 1 }}>
              <Input placeholder="例如：太原" />
            </Form.Item>
            <Form.Item name="area" label="商圈/区域" style={{ flex: 1 }}>
              <Input placeholder="例如：小店区" />
            </Form.Item>
            <Form.Item name="opened_at" label="开业日期">
              <DatePicker style={{ width: 150 }} />
            </Form.Item>
          </Space>
          <Form.Item name="address" label="详细地址">
            <Input placeholder="可选" />
          </Form.Item>
          {/* 连锁字段：区域 / 门店负责人 / 默认门店（单店客户可全部留空，不影响使用） */}
          <Space size={10} className="sd-form-row" align="start">
            <Form.Item name="region" label="所属区域" className="sd-form-grow">
              <Input placeholder="例如：华东区 / 成都" maxLength={40} />
            </Form.Item>
            <Form.Item name="manager_user_id" label="门店负责人" className="sd-form-grow">
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="选择本企业账号"
                options={staffOptions}
              />
            </Form.Item>
            <Form.Item
              name="is_default"
              label="默认门店"
              valuePropName="checked"
              tooltip="未选门店时的数据归属；每家企业只有一家默认店，第一家门店自动成为默认"
            >
              <Switch disabled={Number(storeModal.editing?.is_default) === 1} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      {/* 菜品表单 */}
      <Modal
        open={dishModal.open}
        title={dishModal.editing ? `编辑菜品「${dishModal.editing.name}」` : '新建菜品'}
        okText="保存"
        onOk={submitDish}
        onCancel={() => {
          setDishModal({ open: false, editing: null });
          dishForm.resetFields();
        }}
        destroyOnClose
      >
        <Form form={dishForm} layout="vertical">
          <Form.Item name="store_id" label="所属门店" rules={[{ required: true, message: '请选择所属门店' }]}>
            <Select options={storeOptions} placeholder="选择门店" />
          </Form.Item>
          <Form.Item
            name="name"
            label="菜品名称"
            rules={[
              { required: true, message: '请填写菜品名称' },
              { max: 60, message: '不超过60个字符' },
            ]}
          >
            <Input placeholder="例如：酸汤鱼" />
          </Form.Item>
          <Space size={10} style={{ display: 'flex' }} align="start">
            <Form.Item name="category" label="分类" style={{ flex: 1 }}>
              <Input placeholder="例如：招牌菜" />
            </Form.Item>
            <Form.Item name="code" label="编码" style={{ flex: 1 }}>
              <Input placeholder="可选" />
            </Form.Item>
            <Form.Item name="unit" label="单位" style={{ width: 100 }}>
              <Input placeholder="份/杯" />
            </Form.Item>
          </Space>
          <Space size={10} style={{ display: 'flex' }} align="start">
            <Form.Item name="price" label="售价" rules={[{ required: true, message: '请填写售价' }]}>
              <InputNumber min={0} precision={2} prefix="¥" style={{ width: 150 }} />
            </Form.Item>
            <Form.Item name="cost" label="单份成本">
              <InputNumber min={0} precision={2} prefix="¥" style={{ width: 150 }} />
            </Form.Item>
            <Form.Item name="status" label="状态" style={{ width: 120 }}>
              <Select options={DISH_STATUSES.map(s => ({ value: s, label: s }))} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      {/* 成本表单 */}
      <Modal
        open={costModal}
        title="登记成本"
        okText="保存"
        onOk={submitCost}
        onCancel={() => {
          setCostModal(false);
          costForm.resetFields();
        }}
        destroyOnClose
      >
        <Form form={costForm} layout="vertical">
          <Form.Item name="store_id" label="所属门店" rules={[{ required: true, message: '请选择所属门店' }]}>
            <Select options={storeOptions} placeholder="选择门店" />
          </Form.Item>
          <Space size={10} style={{ display: 'flex' }} align="start">
            <Form.Item name="date" label="成本日期" rules={[{ required: true, message: '请选择日期' }]}>
              <DatePicker style={{ width: 150 }} />
            </Form.Item>
            <Form.Item
              name="category"
              label="类别"
              rules={[{ required: true, message: '请选择类别' }]}
              style={{ width: 130 }}
            >
              <Select options={COST_CATEGORIES.map(c => ({ value: c, label: c }))} />
            </Form.Item>
            <Form.Item name="amount" label="金额" rules={[{ required: true, message: '请填写金额' }]}>
              <InputNumber min={0.01} precision={2} prefix="¥" style={{ width: 150 }} />
            </Form.Item>
          </Space>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} maxLength={200} placeholder="说明这笔成本的来源，便于复盘核对" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
