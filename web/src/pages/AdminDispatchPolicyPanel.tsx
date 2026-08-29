import { Button, Checkbox, Table, message } from 'antd';
import { api } from '../api/client';
import { Panel } from '../components/Kit';

/**
 * 数字员工派活权限矩阵（分部 × 角色）。
 * 勾选 = 该角色可给该分部数字员工派活；老板与系统管理员始终放行（服务端硬保证）。
 * 全勾分部不写规则（保持策略最小化），未改动分部默认全员放行。
 */
export default function AdminDispatchPolicyPanel({
  meta,
  dp,
  setDp,
  onSaved,
}: {
  meta: { roles?: { key: string; name: string }[]; employeeGroups?: string[] } | null;
  dp: Record<string, string[]>;
  setDp: (updater: (prev: Record<string, string[]>) => Record<string, string[]>) => void;
  onSaved: () => void;
}) {
  const roles = meta?.roles || [];
  const allRoles = roles.map(role => role.key);

  // 勾掉某分部的某角色 = 该角色不能给该分部员工派活；一列全勾与默认放行等价
  const onToggle = (group: string, role: string) =>
    setDp(prev => {
      const list = prev[group] ?? allRoles;
      return { ...prev, [group]: list.includes(role) ? list.filter(item => item !== role) : [...list, role] };
    });

  const save = () => {
    const groups: Record<string, { roles: string[] }> = {};
    for (const [name, list] of Object.entries(dp)) {
      if (list.length < allRoles.length) groups[name] = { roles: list };
    }
    api
      .put('/admin/permissions', { employeeDispatchPolicy: { defaultAllow: true, groups, employees: {} } })
      .then(() => {
        message.success('数字员工派活权限已保存，立即生效');
        onSaved();
      });
  };

  return (
    <Panel
      title="数字员工派活权限（按分部 × 角色）"
      extra={
        <Button type="primary" size="small" onClick={save}>
          保存派活权限
        </Button>
      }
    >
      <div className="admin-panel-hint">
        勾选 =
        该角色可以给该分部的数字员工派活（消耗企业积分）。老板与系统管理员始终可派活，不受此矩阵限制；未改动过的分部默认全员放行。
      </div>
      <Table
        size="small"
        rowKey="group"
        pagination={false}
        scroll={{ x: 760 }}
        dataSource={(meta?.employeeGroups || []).map(group => ({ group }))}
        columns={
          [
            {
              title: '员工分部',
              dataIndex: 'group',
              fixed: 'left',
              width: 170,
              render: (value: string) => <b className="admin-cell-strong">{value}</b>,
            },
            ...roles.map(role => ({
              title: <div className="admin-cell-center">{role.name}</div>,
              key: role.key,
              align: 'center' as const,
              render: (_: unknown, row: { group: string }) => {
                const locked = role.key === 'boss' || role.key === 'admin';
                const list = dp[row.group] ?? allRoles;
                return (
                  <Checkbox
                    checked={locked || list.includes(role.key)}
                    disabled={locked}
                    onChange={() => onToggle(row.group, role.key)}
                  />
                );
              },
            })),
          ] as never[]
        }
      />
    </Panel>
  );
}

/** 员工部门映射（三级权限·员工层）：员工可见 = 角色基础包 ∪ 部门追加模块 */
export function AdminDeptModulesPanel({
  meta,
  dm,
  setDm,
  onSaved,
}: {
  meta: { modules?: { key: string; name: string }[]; depts?: string[] } | null;
  dm: Record<string, string[]>;
  setDm: (updater: (prev: Record<string, string[]>) => Record<string, string[]>) => void;
  onSaved: () => void;
}) {
  const toggle = (dept: string, mod: string) =>
    setDm(prev => {
      const list = prev[dept] || [];
      return { ...prev, [dept]: list.includes(mod) ? list.filter(item => item !== mod) : [...list, mod] };
    });
  const save = () =>
    api.put('/admin/permissions', { deptModules: dm }).then(() => {
      message.success('部门映射已保存：员工 = 角色基础包 ∪ 部门追加');
      onSaved();
    });

  return (
    <Panel
      title="员工部门映射（三级权限·员工层）"
      extra={
        <Button type="primary" size="small" onClick={save}>
          保存部门映射
        </Button>
      }
    >
      <div className="admin-panel-hint">
        员工实际可见 = 员工角色基础包（总控台+经营执行） ∪ 所在部门追加模块。例：销售部员工自动追加「增长中心」。
      </div>
      <Table
        size="small"
        rowKey="dept"
        pagination={false}
        dataSource={Array.from(new Set([...(meta?.depts || []), ...Object.keys(dm)])).map(dept => ({ dept }))}
        columns={
          [
            {
              title: '部门',
              dataIndex: 'dept',
              width: 150,
              render: (value: string) => <b className="admin-cell-strong">{value}</b>,
            },
            ...(meta?.modules || [])
              .filter(mod => !['dashboard', 'system'].includes(mod.key))
              .map(mod => ({
                title: <div className="admin-cell-center">{mod.name}</div>,
                key: mod.key,
                align: 'center' as const,
                render: (_: unknown, row: { dept: string }) => (
                  <Checkbox
                    checked={(dm[row.dept] || []).includes(mod.key)}
                    onChange={() => toggle(row.dept, mod.key)}
                  />
                ),
              })),
          ] as never[]
        }
      />
    </Panel>
  );
}
