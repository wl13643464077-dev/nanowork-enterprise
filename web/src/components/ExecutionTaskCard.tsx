import {
  ApartmentOutlined,
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  HistoryOutlined,
  LockOutlined,
  PaperClipOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import { Button, Popconfirm, Tag, Tooltip } from 'antd';

export type ExecutionTask = {
  id: number;
  title: string;
  detail?: string | null;
  type?: string;
  status?: string;
  priority?: string;
  assignee_id?: number | null;
  assignee?: string | null;
  due_at?: string | null;
  source?: string | null;
  parent_task_id?: number | null;
  risk?: boolean | number;
  last_submission_result?: string | null;
  last_review_reason?: string | null;
  last_reviewed_at?: string | null;
  workflow_state?: string | null;
  display_status?: string | null;
  can_review?: boolean;
  next_action?: { code?: string; label?: string } | null;
};

export type ExecutionSubmission = {
  task_id?: number | null;
  result?: string | null;
};

export type ExecutionUser = {
  id?: number | string;
  name?: string;
  username?: string;
  role?: string;
  dept?: string;
};

type Props = {
  task: ExecutionTask;
  tasks: ExecutionTask[];
  submissions: ExecutionSubmission[];
  user: ExecutionUser;
  isManager: boolean;
  canApprove: boolean;
  onOpenTrace: (task: ExecutionTask) => void;
  onOpenBusinessFlow: (taskId: number) => void;
  onStart: (task: ExecutionTask) => void;
  onOpenWork: (task: ExecutionTask) => void;
  onApprove: (task: ExecutionTask) => void;
  onReject: (task: ExecutionTask) => void;
  onDecompose: (task: ExecutionTask) => void;
  onReopen: (task: ExecutionTask) => void;
  onDelete: (task: ExecutionTask) => void;
};

const PRIORITY_COLOR: Record<string, string> = {
  高: 'var(--danger)',
  中: 'var(--warn)',
  低: 'var(--ok)',
};

const TYPE_COLOR: Record<string, string> = {
  跟进: 'blue',
  邀约: 'purple',
  内容: 'cyan',
  活动: 'orange',
  培训: 'green',
  督导: 'red',
  回访: 'magenta',
};

function typeColor(type?: string) {
  return TYPE_COLOR[type || ''] || 'geekblue';
}

export function isExecutionTaskRework(
  task?: Pick<ExecutionTask, 'status' | 'workflow_state' | 'last_submission_result'>,
) {
  return task?.workflow_state === 'rework' || (task?.status === '进行中' && task?.last_submission_result === '驳回');
}

export function executionTaskBoardStatus(task: ExecutionTask) {
  return isExecutionTaskRework(task) ? '返工中' : task.status || '状态未知';
}

export function executionTaskStatusLabel(status?: string, lastSubmissionResult?: string | null) {
  if (status === '返工中' || (status === '进行中' && lastSubmissionResult === '驳回')) {
    return '返工中（人工验收退回）';
  }
  return status === '待审核' ? '待人工验收' : status || '状态未知';
}

export function executionSubmissionStatusLabel(status?: string | null) {
  if (status === '待审核') return '待人工验收';
  if (status === '通过') return '已人工验收';
  if (status === '驳回') return '人工验收退回';
  return status || '状态未知';
}

export default function ExecutionTaskCard({
  task,
  tasks,
  submissions,
  user,
  isManager,
  canApprove,
  onOpenTrace,
  onOpenBusinessFlow,
  onStart,
  onOpenWork,
  onApprove,
  onReject,
  onDecompose,
  onReopen,
  onDelete,
}: Props) {
  const operable = Number(task.assignee_id) === Number(user.id);
  const isRework = isExecutionTaskRework(task);
  const canDecompose =
    !isRework && isManager && task.status === '进行中' && (['boss', 'admin'].includes(user.role || '') || operable);
  const canApproveTask =
    typeof task.can_review === 'boolean'
      ? task.can_review
      : canApprove && (['boss', 'admin'].includes(user.role || '') || Number(task.assignee_id) !== Number(user.id));
  const hasPassedSubmission = submissions.some(
    submission => Number(submission.task_id) === Number(task.id) && submission.result === '通过',
  );
  const canDelete =
    ['boss', 'admin'].includes(user.role || '') ||
    (!hasPassedSubmission &&
      task.status !== '已完成' &&
      task.source !== '作战计划' &&
      (isManager || (operable && task.status === '待执行')));
  const parentTask = task.parent_task_id
    ? tasks.find(candidate => Number(candidate.id) === Number(task.parent_task_id))
    : null;
  const lockedTip = operable ? '' : '只有任务负责人本人可以开始并提交；管理层负责拆解与人工验收';

  return (
    <article className="execution-task-card">
      <div className="execution-task-card__title">
        <Tooltip title={task.detail}>
          <strong>{task.title}</strong>
        </Tooltip>
        <Tooltip title={`优先级：${task.priority || '未设置'}`}>
          <span
            className="execution-task-card__priority"
            style={{ background: PRIORITY_COLOR[task.priority || ''] || 'var(--ui-muted)' }}
          />
        </Tooltip>
      </div>

      <div className="execution-task-card__tags">
        <Tag color={typeColor(task.type)}>{task.type || '其他'}</Tag>
        {task.source && <Tag color={task.source === '活动策划' ? 'purple' : 'default'}>{task.source}</Tag>}
        {task.parent_task_id && <Tag color="blue">上级：{parentTask?.title || `任务 #${task.parent_task_id}`}</Tag>}
        {Boolean(task.risk) && <Tag color="red">风险</Tag>}
        {isRework && <Tag color="volcano">返工中（人工验收退回）</Tag>}
        {!operable && (
          <Tag icon={<LockOutlined />} color="default">
            只读
          </Tag>
        )}
      </div>

      <div className="execution-task-card__meta">
        <span>{task.assignee || '未分配'}</span>
        <span>{task.due_at ? `截止 ${task.due_at.slice(5, 16)}` : '未设置截止时间'}</span>
      </div>

      {isRework && (
        <div className="execution-task-card__rework" role="status">
          <strong>退回原因</strong>
          <span>{task.last_review_reason || '请打开执行记录查看人工验收意见'}</span>
          <small>下一步：{task.next_action?.label || '按验收意见修改后重新提交人工验收'}</small>
        </div>
      )}

      <div className="execution-task-links">
        <Button size="small" icon={<PaperClipOutlined />} onClick={() => onOpenTrace(task)}>
          执行记录
        </Button>
        <Button size="small" icon={<ApartmentOutlined />} onClick={() => onOpenBusinessFlow(Number(task.id))}>
          业务流
        </Button>
      </div>

      {task.status === '待执行' && (
        <Tooltip title={lockedTip}>
          <Button
            size="small"
            type="primary"
            ghost
            block
            icon={<PlayCircleOutlined />}
            className="execution-task-card__single-action"
            disabled={!operable}
            onClick={() => onStart(task)}
          >
            开始执行
          </Button>
        </Tooltip>
      )}

      {task.status === '进行中' && (
        <div className="execution-task-primary-actions">
          <Tooltip title={lockedTip}>
            <Button
              size="small"
              type="primary"
              block
              icon={<EditOutlined />}
              disabled={!operable}
              onClick={() => onOpenWork(task)}
            >
              {isRework ? '修改结果并重新提交' : '填写结果/上传证据'}
            </Button>
          </Tooltip>
          {canDecompose && (
            <Button size="small" block icon={<ApartmentOutlined />} onClick={() => onDecompose(task)}>
              拆解给员工
            </Button>
          )}
        </div>
      )}

      {task.status === '待审核' &&
        (canApproveTask ? (
          <div className="execution-task-card__review-actions">
            <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => onApprove(task)}>
              验收通过
            </Button>
            <Button size="small" danger icon={<CloseOutlined />} onClick={() => onReject(task)}>
              退回返工
            </Button>
          </div>
        ) : (
          <div className="execution-task-card__waiting">
            {canApprove && operable
              ? '职责分离：提交人不能自审，请由老板在本任务卡完成人工验收'
              : '已提交人工验收，等待有权限的管理层在本任务卡处理'}
          </div>
        ))}

      {isManager && task.status === '已完成' && (
        <Button
          size="small"
          block
          icon={<HistoryOutlined />}
          className="execution-reopen-button"
          onClick={() => onReopen(task)}
        >
          重新打开
        </Button>
      )}

      {canDelete && (
        <Popconfirm
          title={`删除任务「${task.title}」？`}
          description="删除后进入回收站，老板/管理员可恢复。"
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => onDelete(task)}
        >
          <Button size="small" danger ghost block icon={<DeleteOutlined />} className="execution-delete-button">
            删除任务
          </Button>
        </Popconfirm>
      )}
    </article>
  );
}
