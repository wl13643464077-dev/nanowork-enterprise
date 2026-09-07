import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Empty,
  Form,
  InputNumber,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  message,
} from 'antd';
import { CopyOutlined, LinkOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import './InvitationManager.css';

type InvitationScope = 'platform' | 'tenant';
type Invitation = {
  id: number;
  type: 'new_tenant' | 'existing_tenant';
  tenantName?: string;
  roleLabel: string;
  codeMasked: string;
  maxUses: number;
  usedCount: number;
  expiresAt: string;
  status: 'active' | 'expired' | 'exhausted' | 'revoked' | 'unavailable';
};
type RoleOption = { role: string; label: string };
type CreateValues = { type?: string; tenantId?: number; role?: string; maxUses?: number; daysValid?: number };
const MEMBER_ROLES = new Set(['boss', 'ops_director', 'manager', 'sales', 'admin', 'partner']);
const STATUS = {
  active: { label: '可使用', color: 'success' },
  expired: { label: '已过期', color: 'default' },
  exhausted: { label: '已用完', color: 'default' },
  revoked: { label: '已停用', color: 'default' },
  unavailable: { label: '暂不可用', color: 'warning' },
};

export function invitationLink(code: string, origin: string) {
  return `${new URL('/register', origin).href}#invite=${encodeURIComponent(code)}`;
}

export function invitationCreatePayload(scope: InvitationScope, values: CreateValues, now = Date.now()) {
  const type = scope === 'platform' && values.type === 'new_tenant' ? 'new_tenant' : 'existing_tenant';
  return {
    type,
    ...(type === 'existing_tenant' ? { role: values.role || 'sales' } : {}),
    ...(scope === 'platform' && type === 'existing_tenant' ? { tenantId: values.tenantId } : {}),
    maxUses: values.maxUses ?? 1,
    expiresAt: new Date(now + (values.daysValid ?? 7) * 86_400_000).toISOString(),
  };
}

function dateLabel(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('zh-CN', { hour12: false }) : '有效期未返回';
}

export default function InvitationManager({ scope }: { scope: InvitationScope }) {
  const base = scope === 'platform' ? '/platform/invitations' : '/admin/invitations';
  const [form] = Form.useForm<CreateValues>();
  const selectedType = Form.useWatch('type', form) || (scope === 'platform' ? 'new_tenant' : 'existing_tenant');
  const [items, setItems] = useState<Invitation[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [tenants, setTenants] = useState<{ id: number; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [tenantError, setTenantError] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [revoking, setRevoking] = useState<number | null>(null);
  const [created, setCreated] = useState<{ code: string; invitation: Invitation } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setListError('');
    try {
      const data = await api.get(base, { silent: true });
      if (!Array.isArray(data?.items) || !Array.isArray(data?.roles)) throw new Error('邀请码列表返回不完整，请重试');
      setItems(data.items);
      setRoles(data.roles.filter((item: RoleOption) => MEMBER_ROLES.has(item.role)));
    } catch (error) {
      setListError(error instanceof Error ? error.message : '邀请码列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [base]);

  const loadTenants = useCallback(async () => {
    if (scope !== 'platform') return;
    setTenantError('');
    try {
      const data = await api.get('/platform/tenants', { silent: true });
      if (!Array.isArray(data)) throw new Error('企业列表返回不完整');
      setTenants(data.filter(item => item.status === '已开通'));
    } catch (error) {
      setTenantError(error instanceof Error ? error.message : '企业列表加载失败');
    }
  }, [scope]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void load();
      void loadTenants();
    });
    return () => cancelAnimationFrame(frame);
  }, [load, loadTenants]);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      message.success('已复制');
    } catch {
      message.error('复制失败，请选择文本手动复制');
    }
  };

  const create = async (values: CreateValues) => {
    setCreating(true);
    setCreateError('');
    try {
      const data = await api.post(base, invitationCreatePayload(scope, values), { silent: true });
      if (!data?.ok || !data?.code || !data?.invitation?.id) throw new Error('创建回执不完整，请刷新列表核对后再操作');
      setCreated({ code: data.code, invitation: data.invitation });
      await load();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : '创建邀请码失败');
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: number) => {
    setRevoking(id);
    try {
      await api.post(`${base}/${id}/revoke`, {}, { silent: true });
      if (created?.invitation.id === id) setCreated(null);
      message.success('邀请码已停用');
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '停用失败，请重试');
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section className="invitation-manager" aria-label="邀请码管理">
      <header>
        <div>
          <h2>邀请码</h2>
          <p>
            {scope === 'platform'
              ? '开通新企业，或邀请成员加入已开通的企业。'
              : '邀请成员加入本企业，注册后按指定角色使用。'}
          </p>
        </div>
        <Button
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={() => {
            void load();
            void loadTenants();
          }}
        >
          刷新
        </Button>
      </header>
      {scope === 'tenant' && <Button href="/admin?tab=users&seatRequest=1">查看账号额度 / 申请扩容</Button>}
      <Form
        form={form}
        layout="vertical"
        onFinish={create}
        initialValues={{
          type: scope === 'platform' ? 'new_tenant' : 'existing_tenant',
          role: 'sales',
          maxUses: 1,
          daysValid: 7,
        }}
        className="invitation-create"
      >
        {scope === 'platform' && (
          <Form.Item name="type" label="邀请用途">
            <Segmented
              options={[
                { label: '开通新企业', value: 'new_tenant' },
                { label: '邀请企业成员', value: 'existing_tenant' },
              ]}
            />
          </Form.Item>
        )}
        {selectedType === 'new_tenant' && scope === 'platform' ? (
          <p className="invitation-hint">
            注册人成为企业主账号，拥有老板权限。基础含 1 个主账号 + 4 个副账号，初始积分为 0。
          </p>
        ) : (
          <div className="invitation-fields">
            {scope === 'platform' && (
              <Form.Item name="tenantId" label="加入企业" rules={[{ required: true, message: '请选择已开通的企业' }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  placeholder="选择已开通的企业"
                  options={tenants.map(item => ({ value: item.id, label: item.name }))}
                />
              </Form.Item>
            )}
            <Form.Item name="role" label="成员角色" rules={[{ required: true, message: '请选择角色' }]}>
              <Select options={roles.map(item => ({ value: item.role, label: item.label }))} placeholder="选择角色" />
            </Form.Item>
          </div>
        )}
        {selectedType === 'existing_tenant' && (
          <p className="invitation-hint">加入企业的成员均为副账号；即使选择老板或管理员权限，也不会成为主账号。</p>
        )}
        {scope === 'platform' && selectedType === 'existing_tenant' && tenantError && (
          <Alert type="error" showIcon message="企业列表加载失败" description={tenantError} />
        )}
        <p className="invitation-hint">默认可使用 1 次，7 天内有效。</p>
        <details className="invitation-options">
          <summary>更多选项</summary>
          <div className="invitation-fields">
            <Form.Item
              name="maxUses"
              label="可使用次数"
              rules={[{ required: true, type: 'number', min: 1, max: 50, message: '可使用次数为1到50次' }]}
            >
              <InputNumber min={1} max={50} precision={0} />
            </Form.Item>
            <Form.Item
              name="daysValid"
              label="有效天数"
              rules={[{ required: true, type: 'number', min: 1, max: 90, message: '有效天数为1到90天' }]}
            >
              <InputNumber min={1} max={90} precision={0} />
            </Form.Item>
          </div>
        </details>
        {createError && <Alert type="error" showIcon message="未完成创建" description={createError} />}
        <Button
          type="primary"
          htmlType="submit"
          loading={creating}
          disabled={
            loading ||
            !!listError ||
            (selectedType === 'existing_tenant' && (!roles.length || (scope === 'platform' && !!tenantError)))
          }
        >
          生成邀请码
        </Button>
      </Form>
      {created && (
        <section className="invitation-created" aria-label="新邀请码">
          <Alert
            type="success"
            showIcon
            message="邀请码已生成"
            description="完整邀请码只在本次显示，请复制保存后再关闭。"
          />
          <code>{created.code}</code>
          <p>
            {created.invitation.type === 'new_tenant' ? '开通新企业' : created.invitation.tenantName} ·{' '}
            {created.invitation.roleLabel} · {dateLabel(created.invitation.expiresAt)} 到期
          </p>
          <Space wrap>
            <Button icon={<CopyOutlined />} onClick={() => void copy(created.code)}>
              复制邀请码
            </Button>
            <Button
              icon={<LinkOutlined />}
              onClick={() => void copy(invitationLink(created.code, window.location.origin))}
            >
              复制邀请链接
            </Button>
            <Button type="text" onClick={() => setCreated(null)}>
              关闭原码
            </Button>
          </Space>
        </section>
      )}
      <section className="invitation-list" aria-label="邀请码记录">
        <h3>邀请码记录</h3>
        {listError ? (
          <Alert
            type="error"
            showIcon
            message="邀请码列表加载失败"
            description={listError}
            action={<Button onClick={() => void load()}>重试</Button>}
          />
        ) : loading ? (
          <Spin aria-label="加载邀请码列表" />
        ) : !items.length ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有邀请码" />
        ) : (
          items.map(item => {
            const status = STATUS[item.status] || { label: '状态待确认', color: 'default' };
            return (
              <article key={item.id}>
                <div>
                  <strong>{item.type === 'new_tenant' ? '开通新企业' : item.tenantName || '本企业成员'}</strong>
                  <Tag color={status.color}>{status.label}</Tag>
                </div>
                <p>
                  {item.roleLabel} · <code>{item.codeMasked}</code>
                </p>
                <p>
                  已用 {item.usedCount} / {item.maxUses} 次 · {dateLabel(item.expiresAt)} 到期
                </p>
                {item.status === 'active' && (
                  <Popconfirm
                    title="停用这个邀请码？"
                    description="停用后，尚未注册的人将无法再使用。"
                    okText="停用"
                    cancelText="保留"
                    onConfirm={() => revoke(item.id)}
                  >
                    <Button size="small" danger loading={revoking === item.id}>
                      停用
                    </Button>
                  </Popconfirm>
                )}
              </article>
            );
          })
        )}
      </section>
    </section>
  );
}
