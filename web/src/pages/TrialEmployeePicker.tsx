import { useMemo, useState } from 'react';
import { Button, Empty, Input, Modal, Select, Tag } from 'antd';
import { ArrowRightOutlined, CheckOutlined, SearchOutlined, SwapOutlined } from '@ant-design/icons';
import type { TrialEmployee } from './TrialShared';

// Display profiles only: available employees and permissions still come from the server.
const FEATURED_PROFILES: Record<string, { person: string; role: string; summary: string; portrait: string }> = {
  'restaurant-104': {
    person: '李选址',
    role: '选址顾问',
    summary: '按正式选址岗位对比铺位、竞品与开店压力。',
    portrait: 'emp-04',
  },
  'restaurant-160': {
    person: '店小满',
    role: '超级店长',
    summary: '按正式店长岗位出活动方案，并生成配套物料图。',
    portrait: 'emp-60',
  },
  'restaurant-161': {
    person: '查巡巡',
    role: '巡店督导',
    summary: '按正式巡店岗位整理问题、评分与整改安排。',
    portrait: 'emp-61',
  },
  'content-11': {
    person: '小红书种草员',
    role: '小红书图文策划',
    summary: '按正式种草员写标题、正文、标签并组织配图。',
    portrait: 'crew-03',
  },
  'content-10': {
    person: 'AI带货员',
    role: '带货视频策划',
    summary: '按正式带货员写口播、分镜并组织成片方案。',
    portrait: 'crew-10',
  },
};

export function trialEmployeeProfile(employee: TrialEmployee) {
  const profile = FEATURED_PROFILES[employee.id];
  return {
    person: profile?.person || employee.name,
    role: profile?.role || trialEmployeeName(employee),
    summary: profile?.summary || trialEmployeeDescription(employee),
    portrait: profile ? `/avatars/employees/${profile.portrait}.jpg` : null,
  };
}

function TrialEmployeePortrait({ employee }: { employee: TrialEmployee }) {
  const [failed, setFailed] = useState(false);
  const profile = trialEmployeeProfile(employee);
  return (
    <span className="trial-featured-portrait">
      {profile.portrait && !failed ? (
        <img src={profile.portrait} alt={`${profile.person}的数字员工形象`} onError={() => setFailed(true)} />
      ) : (
        <span className="trial-featured-initial" aria-hidden="true">
          {profile.person.slice(0, 1)}
        </span>
      )}
    </span>
  );
}

export const FEATURED_TRIAL_EMPLOYEE_IDS = Object.keys(FEATURED_PROFILES);
export function featuredTrialEmployees(employees: TrialEmployee[]) {
  const order = new Map(FEATURED_TRIAL_EMPLOYEE_IDS.map((id, index) => [id, index]));
  return employees
    .filter(employee => order.has(employee.id))
    .sort((a, b) => (order.get(a.id) || 0) - (order.get(b.id) || 0));
}
export const trialEmployeeName = (employee: TrialEmployee) => employee.displayName || employee.name;
export const validTrialEmployeeId = (employees: TrialEmployee[], value?: string) =>
  employees.some(employee => employee.id === value) ? value : employees[0]?.id;
export const trialEmployeeGroup = (employee: TrialEmployee) =>
  employee.department || employee.group || (employee.domain === 'content' ? '内容生产部' : '餐饮数字员工');
export function trialEmployeeDescription(employee: TrialEmployee) {
  return employee.description;
}
export function trialEmployeeExample(employee: TrialEmployee) {
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
          employee.displayName,
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
  variant = 'directory',
}: {
  employees: TrialEmployee[];
  value?: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  variant?: 'directory' | 'featured';
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('all');
  const selected = employees.find(employee => employee.id === value);
  const groups = useMemo(() => [...new Set(employees.map(trialEmployeeGroup))], [employees]);
  const visible = filterTrialEmployees(employees, query, group);
  const choose = (id: string) => {
    if (disabled || !employees.some(employee => employee.id === id)) return;
    onChange(id);
    setOpen(false);
  };
  if (variant === 'featured')
    return (
      <div className="trial-featured-employees" role="group" aria-label="选择一位数字员工">
        {employees.map(employee => {
          const profile = trialEmployeeProfile(employee);
          const chosen = employee.id === value;
          return (
            <button
              key={employee.id}
              type="button"
              className={`trial-employee-option trial-featured-option${chosen ? ' is-selected' : ''}`}
              disabled={disabled}
              aria-pressed={chosen}
              aria-label={`${profile.person}，${profile.role}，${chosen ? '已选择' : '选择体验'}`}
              onClick={() => choose(employee.id)}
            >
              <TrialEmployeePortrait employee={employee} />
              <span className="trial-featured-content">
                <strong className="trial-featured-person">{profile.person}</strong>
                <span className="trial-featured-role">{profile.role}</span>
                <span className="trial-featured-summary">{profile.summary}</span>
              </span>
              <span className="trial-featured-action">
                {chosen ? <CheckOutlined aria-hidden /> : null}
                {chosen ? '已选择' : '选 TA 体验'}
                {!chosen ? <ArrowRightOutlined aria-hidden /> : null}
              </span>
            </button>
          );
        })}
      </div>
    );
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
          找到 {visible.length}{' '}
          位员工。体验与正式产品同一套满血数字员工；餐饮岗位含调研和报告，内容岗位按完整岗位能力交付。
        </p>
        <div className="trial-picker-results" role="group" aria-label="可选数字员工">
          {visible.length ? (
            visible.map(employee => (
              <button
                key={employee.id}
                type="button"
                className={`trial-employee-option${employee.id === value ? ' is-selected' : ''}`}
                disabled={disabled}
                aria-pressed={employee.id === value}
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
  compact = false,
}: {
  employee?: TrialEmployee;
  onExample: (text: string) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  if (!employee) return null;
  const mediaPlan = employee.id === 'content-10' || employee.id === 'content-11';
  const example = trialEmployeeExample(employee);
  return (
    <div className={`trial-employee-guide${compact ? ' is-compact' : ''}`}>
      {!compact && <p className="trial-muted">{trialEmployeeDescription(employee)}</p>}
      {mediaPlan && !compact && (
        <p className="trial-mode-note">
          <Tag>满血岗位</Tag>
          {employee.experienceNote ||
            '按正式岗位完整能力执行。没有照片或素材时，先交付完整文案与制作清单，不假装文件已经生成。'}
        </p>
      )}
      <button type="button" className="trial-example" disabled={disabled} onClick={() => onExample(example)}>
        <span>
          {compact ? `试试这样和${trialEmployeeProfile(employee).person}说 · 点击填入` : '一句话使用我 · 点击填入'}
        </span>
        {example}
      </button>
    </div>
  );
}
