import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Select, Space, Table, message } from 'antd';
import { api, getUser, notifyCredits } from '../api/client';
import { Panel } from './Kit';
import { SystemBillingPanel } from './SystemBillingPanel';

type Tenant = { id: number; name: string };

export default function PlatformOperations({ tenants }: { tenants: Tenant[] }) {
  if (getUser()?.role !== 'platform_super') return null;
  return <Operations tenants={tenants} />;
}

function Operations({ tenants }: { tenants: Tenant[] }) {
  const [backups, setBackups] = useState<any[]>([]);
  const [backingUp, setBackingUp] = useState(false);
  const [backupError, setBackupError] = useState('');
  const [tenantId, setTenantId] = useState<number>(Number(getUser()?.tenant?.id || getUser()?.tenant_id || 1));
  const selectedTenant = useRef(tenantId);
  const billingRequest = useRef(0);
  const [billingReconciliation, setBillingReconciliation] = useState<any>(null);
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingError, setBillingError] = useState('');
  const loadBackups = useCallback(
    () =>
      api
        .get('/sys/backups')
        .then((rows: any[]) => {
          setBackups(rows);
          setBackupError('');
        })
        .catch((error: Error) => setBackupError(error.message)),
    [],
  );
  const loadBillingReconciliation = useCallback(() => {
    if (selectedTenant.current !== tenantId) return Promise.resolve();
    const requestId = ++billingRequest.current;
    const isCurrent = () => selectedTenant.current === tenantId && requestId === billingRequest.current;
    setBillingLoading(true);
    return api
      .get(`/sys/billing/reconciliation?tenantId=${tenantId}`)
      .then((result: any) => {
        if (!isCurrent()) return;
        setBillingReconciliation(result);
        setBillingError('');
      })
      .catch((error: Error) => {
        if (isCurrent()) {
          setBillingReconciliation(null);
          setBillingError(error.message);
        }
      })
      .finally(() => {
        if (isCurrent()) setBillingLoading(false);
      });
  }, [tenantId]);
  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadBillingReconciliation();
    });
    return () => {
      cancelled = true;
      billingRequest.current += 1;
    };
  }, [loadBillingReconciliation]);
  const backup = () => {
    setBackingUp(true);
    api
      .post('/sys/backup')
      .then(() => {
        message.success('平台备份已创建');
        return loadBackups();
      })
      .finally(() => setBackingUp(false));
  };
  const resolveBilling = (row: any, action: 'settle' | 'release') => {
    let reason = '';
    const settle = action === 'settle';
    Modal.confirm({
      title: settle ? '按真实用量完成积分结算？' : '确认任务没有合格产物并退回预留积分？',
      okText: settle ? '确认结算' : '确认退款',
      okButtonProps: settle ? {} : { danger: true },
      cancelText: '取消',
      width: 560,
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          <Alert
            type={settle ? 'info' : 'warning'}
            showIcon
            message={
              settle
                ? `系统将只按已落库的 ${row.business?.model || '-'} 与真实 token 用量结算，不采用页面自报金额。`
                : '系统会全额退回本任务临时预留的积分，并隔离无效产物及其下游素材/知识资产；隔离后不能用于业务。'
            }
          />
          <Input.TextArea
            rows={3}
            maxLength={300}
            showCount
            placeholder="填写对账依据（至少6字），例如：主产物通过共享语义契约且模型/token证据一致"
            onChange={event => {
              reason = event.target.value;
            }}
          />
        </div>
      ),
      onOk: () => {
        const finalReason = reason.trim();
        if (finalReason.length < 6) {
          message.warning('请填写至少6字的对账依据');
          return Promise.reject(new Error('billing reconciliation reason required'));
        }
        return api
          .post(`/sys/billing/reconciliation/${row.holdId}/resolve`, {
            tenantId,
            action,
            reason: finalReason,
            evidenceHash: row.evidenceHash,
          })
          .then((result: any) => {
            message.success(result.message || '对账完成');
            notifyCredits();
            return loadBillingReconciliation();
          });
      },
    });
  };

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <Panel
        title="平台数据备份"
        extra={
          <Button loading={backingUp} onClick={backup}>
            创建备份
          </Button>
        }
      >
        {backupError && <Alert type="error" message={backupError} />}
        <Table
          rowKey="file"
          size="small"
          dataSource={backups}
          pagination={{ pageSize: 5 }}
          columns={[
            { title: '备份文件', dataIndex: 'file' },
            { title: '大小（KB）', dataIndex: 'sizeKB' },
            { title: '创建时间', dataIndex: 'at' },
          ]}
        />
      </Panel>
      <Space wrap>
        <span>核对企业积分</span>
        <Select
          aria-label="核对企业积分"
          style={{ minWidth: 240 }}
          value={tenantId}
          options={tenants.map(tenant => ({ value: tenant.id, label: tenant.name }))}
          onChange={(value: number) => {
            selectedTenant.current = value;
            setBillingReconciliation(null);
            setTenantId(value);
          }}
        />
      </Space>
      {billingError && <Alert type="error" message={billingError} />}
      <SystemBillingPanel
        billingLoading={billingLoading}
        billingReconciliation={billingReconciliation}
        canResolveBilling={true}
        loadBillingReconciliation={loadBillingReconciliation}
        resolveBilling={resolveBilling}
      />
    </div>
  );
}
