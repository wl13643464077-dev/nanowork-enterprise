import { useMemo, useState } from 'react';
import { Button, Empty, Input, Modal, Select, Tag } from 'antd';
import { SearchOutlined, SwapOutlined } from '@ant-design/icons';
import type { TrialEmployee } from './TrialShared';

export const trialEmployeeGroup = (employee: TrialEmployee) =>
  employee.department || employee.group || (employee.domain === 'content' ? '内容生产部' : '餐饮数字员工');
export function trialEmployeeDescription(employee: TrialEmployee) {
  if (employee.id === 'content-10') return '根据主题和门店信息，写带货视频口播、分镜与字幕方案。';
  if (employee.id === 'content-11') return '根据品牌和菜品信息，写小红书标题、正文、标签、首评与配图方案。';
  return employee.description;
}
export function trialEmployeeExample(employee: TrialEmployee) {
  if (employee.id === 'content-10') return '给我的火锅店写一条15秒带货视频脚本，突出招牌鲜切牛肉，语气自然、有食欲。';
  if (employee.id === 'content-11')
    return '为我的火锅店写一篇朋友推荐风格的小红书，突出鲜切牛肉，附上6张图的配图方案。';
  return employee.example;
}
export function filterTrialEmployees(employees: TrialEmployee[], query: string, group = 'all') {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return employees.filter(
    employee =>
      (group === 'all' || trialEmployeeGroup(employee) === group) &&
      terms.every(term =>
        [
          employee.name,
          employee.description,
          employee.example,
          employee.group,
          employee.department,
          ...(employee.capabilities || []),
        ]
          .join(' ')
          .toLocaleLowerCase()
          .includes(term),
      ),
  );
}

export default function TrialEmployeePicker({
  employees,
  value,
  onChange,
  disabled = false,
}: {
  employees: TrialEmployee[];
  value?: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('all');
  const selected = employees.find(employee => employee.id === value);
  const groups = useMemo(() => [...new Set(employees.map(trialEmployeeGroup))], [employees]);
  const visible = filterTrialEmployees(employees, query, group);
  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
  };
  return (
    <div className="trial-employee-picker">
      <div className="trial-picker-caption">
        <span>全部 {employees.length} 位数字员工</span>
        <span>可按部门或需求搜索</span>
      </div>
      <Button
        block
        size="large"
        className="trial-picker-trigger"
        disabled={disabled || !employees.length}
        onClick={() => setOpen(true)}
        icon={<SwapOutlined />}
      >
        {selected ? `${selected.name} · ${trialEmployeeGroup(selected)}` : '选择数字员工'}
      </Button>
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        title="这次想让谁帮忙？"
        width={720}
        className="trial-picker-modal"
      >
        <div className="trial-picker-filters">
          <Input
            aria-label="搜索数字员工"
            placeholder="搜岗位或需求，例如：菜单、差评、带货"
            prefix={<SearchOutlined />}
            value={query}
            onChange={event => setQuery(event.target.value)}
            allowClear
          />
          <Select
            aria-label="按部门筛选数字员工"
            value={group}
            onChange={setGroup}
            options={[{ value: 'all', label: '全部部门' }, ...groups.map(name => ({ value: name, label: name }))]}
          />
        </div>
        <p className="trial-muted trial-small">
          找到 {visible.length} 位员工。轻量体验提供文字建议、脚本和方案，实际生成图片或视频需使用企业版对应功能。
        </p>
        <div className="trial-picker-results" role="group" aria-label="可选数字员工">
          {visible.length ? (
            visible.map(employee => (
              <button
                key={employee.id}
                type="button"
                className={`trial-employee-option${employee.id === value ? ' is-selected' : ''}`}
                onClick={() => choose(employee.id)}
              >
                <span className="trial-employee-option-title">
                  <strong>{employee.name}</strong>
                  <span>{trialEmployeeGroup(employee)}</span>
                </span>
                <span className="trial-employee-option-description">{trialEmployeeDescription(employee)}</span>
              </button>
            ))
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配岗位，换个关键词或部门试试" />
          )}
        </div>
      </Modal>
    </div>
  );
}

export function TrialEmployeeGuide({
  employee,
  onExample,
  disabled = false,
}: {
  employee?: TrialEmployee;
  onExample: (text: string) => void;
  disabled?: boolean;
}) {
  if (!employee) return null;
  const mediaPlan = employee.id === 'content-10' || employee.id === 'content-11';
  const example = trialEmployeeExample(employee);
  return (
    <div className="trial-employee-guide">
      <p className="trial-muted">{trialEmployeeDescription(employee)}</p>
      {mediaPlan && (
        <p className="trial-mode-note">
          <Tag>文字方案体验</Tag>
          {employee.experienceNote ||
            (employee.id === 'content-10'
              ? '本体验交付带货视频脚本与分镜，不生成视频文件。'
              : '本体验交付小红书标题、正文与配图方案，不生成图片文件。')}
        </p>
      )}
      <button type="button" className="trial-example" disabled={disabled} onClick={() => onExample(example)}>
        <span>一句话使用我 · 点击填入</span>
        {example}
      </button>
    </div>
  );
}
