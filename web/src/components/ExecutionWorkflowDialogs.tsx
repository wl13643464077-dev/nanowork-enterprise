import { Alert, Col, DatePicker, Form, Input, Modal, Row, Select, message } from 'antd';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ExecutionTask, ExecutionUser } from './ExecutionTaskCard';

type AssignableMember = {
  id: number;
  name?: string;
  role?: string;
  dept?: string;
  status?: string;
};

type Props = {
  decomposeTask: ExecutionTask | null;
  reopenTask: ExecutionTask | null;
  tasks: ExecutionTask[];
  user: ExecutionUser;
  taskTypes: string[];
  onCloseDecompose: () => void;
  onCloseReopen: () => void;
  onChanged: (kind: 'decomposed' | 'reopened') => void;
};

function fallbackMembers(tasks: ExecutionTask[], user: ExecutionUser, excludedUserId: number) {
  const byId = new Map<number, AssignableMember>();
  const currentUserId = Number(user.id);
  if (Number.isSafeInteger(currentUserId) && currentUserId > 0 && currentUserId !== excludedUserId) {
    byId.set(currentUserId, {
      id: currentUserId,
      name: user.name || user.username || '我',
      role: user.role,
      dept: user.dept || '',
      status: '启用',
    });
  }
  tasks.forEach(task => {
    const id = Number(task.assignee_id);
    if (!Number.isSafeInteger(id) || id <= 0 || id === excludedUserId || byId.has(id)) return;
    byId.set(id, { id, name: task.assignee || `成员 #${id}`, status: '启用' });
  });
  return [...byId.values()];
}

function DecomposeDialog({
  task,
  tasks,
  user,
  taskTypes,
  onClose,
  onChanged,
}: {
  task: ExecutionTask;
  tasks: ExecutionTask[];
  user: ExecutionUser;
  taskTypes: string[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [form] = Form.useForm();
  const [members, setMembers] = useState<AssignableMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const excludedUserId = Number(task.assignee_id);

  useEffect(() => {
    let cancelled = false;
    void api
      .get('/execution/assignees', { silent: true })
      .then(payload => {
        if (cancelled) return;
        const rows: AssignableMember[] = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.users)
            ? payload.users
            : [];
        const unique = new Map<number, AssignableMember>();
        rows.forEach(member => {
          const id = Number(member?.id);
          if (!Number.isSafeInteger(id) || id <= 0 || id === excludedUserId || member?.status === '停用') return;
          unique.set(id, { ...member, id });
        });
        const visible = [...unique.values()];
        setMembers(visible.length ? visible : fallbackMembers(tasks, user, excludedUserId));
      })
      .catch(() => {
        if (!cancelled) setMembers(fallbackMembers(tasks, user, excludedUserId));
      })
      .finally(() => {
        if (!cancelled) setMembersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [excludedUserId, tasks, user]);

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await api.post('/execution/tasks', {
        title: values.title.trim(),
        detail: values.detail?.trim() || '',
        type: values.type,
        priority: values.priority,
        assignee_id: Number(values.assignee_id),
        parent_task_id: Number(task.id),
        due_at: values.due_at.format('YYYY-MM-DD HH:mm'),
      });
      message.success('子任务已派给执行人，并关联上级任务');
      onChanged();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const visibleMembers = members.filter(member => member.id !== excludedUserId);
  const helperText =
    membersLoading || visibleMembers.length
      ? '仅显示当前账号组织权限范围内的启用成员。'
      : '当前组织范围内没有可分配成员。';

  return (
    <Modal
      title="拆解给员工"
      open
      width={620}
      okText="确认派发"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={() => {
        if (!submitting) onClose();
      }}
    >
      <div className="execution-decompose-parent" role="note">
        <span>上级任务</span>
        <strong>{task.title}</strong>
        <small>
          负责人 {task.assignee || '未分配'} · 当前状态 {task.status} · 任务 #{task.id}
        </small>
      </div>
      <Alert
        type="info"
        showIcon
        className="execution-decompose-note"
        message="子任务将进入员工的“待执行”队列"
        description="员工完成并提交后，由有验收权限的管理层处理；上下级任务会保留在同一条业务流中。"
      />
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{
          title: '',
          detail: `上级任务：${task.title}\n请说明具体动作、交付物与验收标准。`,
          type: task.type || '其他',
          priority: task.priority || '中',
          due_at: task.due_at ? dayjs(task.due_at) : dayjs().add(1, 'day').hour(18).minute(0),
        }}
      >
        <Form.Item
          name="assignee_id"
          label="执行人"
          rules={[{ required: true, message: '请选择执行人' }]}
          extra={helperText}
        >
          <Select
            showSearch
            loading={membersLoading}
            disabled={membersLoading || !visibleMembers.length}
            placeholder={membersLoading ? '正在读取组织成员…' : '选择接收子任务的员工'}
            optionFilterProp="label"
            options={visibleMembers.map(member => ({
              value: member.id,
              label: `${member.name || `成员 #${member.id}`}${member.id === Number(user.id) ? '（我）' : ''}${member.dept ? ` · ${member.dept}` : ''}`,
            }))}
            notFoundContent={membersLoading ? '正在读取…' : '当前没有可分配成员'}
          />
        </Form.Item>
        <Form.Item
          name="title"
          label="子任务标题"
          rules={[
            { required: true, message: '请写明员工要完成的具体任务' },
            { min: 4, message: '标题至少4个字' },
            { max: 80, message: '标题最多80个字' },
          ]}
        >
          <Input maxLength={80} showCount placeholder="例如：整理本周门店损耗明细并标出前三项异常" />
        </Form.Item>
        <Form.Item
          name="detail"
          label="执行要求与验收标准"
          rules={[
            { required: true, message: '请填写执行要求与验收标准' },
            { min: 12, message: '至少写12个字，避免员工无法执行' },
            { max: 1000, message: '最多1000个字' },
          ]}
        >
          <Input.TextArea rows={4} maxLength={1000} showCount />
        </Form.Item>
        <Row gutter={12}>
          <Col span={8}>
            <Form.Item name="type" label="类型" rules={[{ required: true }]}>
              <Select options={taskTypes.map(type => ({ value: type, label: type }))} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="priority" label="优先级" rules={[{ required: true }]}>
              <Select options={['高', '中', '低'].map(priority => ({ value: priority, label: priority }))} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="due_at" label="截止时间" rules={[{ required: true, message: '请选择截止时间' }]}>
              <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
}

function ReopenDialog({
  task,
  onClose,
  onChanged,
}: {
  task: ExecutionTask;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await api.post(`/execution/tasks/${task.id}/reopen`, { reason: values.reason.trim() });
      message.success('任务已重新打开，并通知执行人');
      onChanged();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={`重新打开任务：${task.title}`}
      open
      okText="确认重新打开"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={() => {
        if (!submitting) onClose();
      }}
    >
      <Alert
        type="warning"
        showIcon
        className="execution-decompose-note"
        message="重新打开后，任务回到“进行中”"
        description="历史提交和验收记录会保留，执行人会收到重开原因。"
      />
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          name="reason"
          label="重开原因"
          rules={[
            { required: true, message: '必须填写重开原因' },
            { min: 4, message: '请具体说明需要补做或修正的内容' },
            { max: 1000, message: '重开原因最多1000字' },
          ]}
        >
          <Input.TextArea
            rows={4}
            maxLength={1000}
            showCount
            placeholder="例如：复核发现缺少周末两天数据，请补齐后重新提交。"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export default function ExecutionWorkflowDialogs({
  decomposeTask,
  reopenTask,
  tasks,
  user,
  taskTypes,
  onCloseDecompose,
  onCloseReopen,
  onChanged,
}: Props) {
  return (
    <>
      {decomposeTask && (
        <DecomposeDialog
          key={decomposeTask.id}
          task={decomposeTask}
          tasks={tasks}
          user={user}
          taskTypes={taskTypes}
          onClose={onCloseDecompose}
          onChanged={() => onChanged('decomposed')}
        />
      )}
      {reopenTask && (
        <ReopenDialog
          key={reopenTask.id}
          task={reopenTask}
          onClose={onCloseReopen}
          onChanged={() => onChanged('reopened')}
        />
      )}
    </>
  );
}
