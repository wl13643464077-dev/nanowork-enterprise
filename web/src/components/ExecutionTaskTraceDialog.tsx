import { PaperClipOutlined } from '@ant-design/icons';
import { Empty, Modal, Tag, Timeline } from 'antd';
import { safeUrl } from '../api/client';
import { executionSubmissionStatusLabel, executionTaskStatusLabel, type ExecutionTask } from './ExecutionTaskCard';

type SubmissionAttachment = {
  name?: string;
  url?: string;
};

export type TaskTraceSubmission = {
  id?: number;
  content?: string;
  result?: string | null;
  display_result?: string | null;
  review_reason?: string | null;
  user_name?: string | null;
  created_at?: string | null;
};

type Props = {
  open: boolean;
  task: ExecutionTask | null;
  submissions: TaskTraceSubmission[];
  loading: boolean;
  onClose: () => void;
};

function parseSubmission(content?: string) {
  try {
    const parsed = JSON.parse(content || '{}');
    if (parsed && parsed.kind === 'task_submit_v2') {
      return {
        note: typeof parsed.note === 'string' ? parsed.note : '',
        attachments: Array.isArray(parsed.attachments) ? (parsed.attachments as SubmissionAttachment[]) : [],
      };
    }
  } catch {
    // 历史任务允许保存纯文本提交。
  }
  return { note: content || '', attachments: [] as SubmissionAttachment[] };
}

export default function ExecutionTaskTraceDialog({ open, task, submissions, loading, onClose }: Props) {
  return (
    <Modal
      open={open}
      width={560}
      footer={null}
      onCancel={onClose}
      title={
        task ? (
          <span>
            执行记录 · {task.title} <Tag color="blue">执行提交 › 人工验收</Tag>
          </span>
        ) : null
      }
    >
      {loading ? (
        <div className="execution-task-trace__loading">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="加载中…" />
        </div>
      ) : (
        <div className="execution-task-trace">
          {task && (
            <div className="execution-task-trace__summary">
              <div>{task.detail || task.title}</div>
              <small>
                负责人 {task.assignee || '-'} ｜ 截止 {(task.due_at || '').slice(5, 16)} ｜ 状态{' '}
                {task.display_status || executionTaskStatusLabel(task.status, task.last_submission_result)}
              </small>
            </div>
          )}
          {submissions.length === 0 ? (
            <Empty description="员工尚未提交执行结果" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <Timeline
              items={submissions.map(submission => {
                const body = parseSubmission(submission.content);
                return {
                  color: submission.result === '通过' ? 'green' : submission.result === '驳回' ? 'red' : 'blue',
                  children: (
                    <div className="execution-task-trace__entry">
                      <strong>{submission.user_name || '员工'}</strong>{' '}
                      <time>{(submission.created_at || '').slice(5, 16)}</time>
                      {submission.result && (
                        <Tag
                          color={submission.result === '通过' ? 'green' : submission.result === '驳回' ? 'red' : 'gold'}
                        >
                          {submission.display_result || executionSubmissionStatusLabel(submission.result)}
                        </Tag>
                      )}
                      <p>{body.note || '已上传执行资料'}</p>
                      {submission.review_reason && (
                        <div className="execution-review-reason">
                          <strong>验收意见</strong>
                          <span>{submission.review_reason}</span>
                        </div>
                      )}
                      {body.attachments.length > 0 && (
                        <div className="execution-task-trace__attachments">
                          {body.attachments.map((attachment, index) => (
                            <a
                              key={`${attachment.url || attachment.name}-${index}`}
                              href={safeUrl(attachment.url)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <Tag color="blue" icon={<PaperClipOutlined />}>
                                {attachment.name || `附件 ${index + 1}`}
                              </Tag>
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  ),
                };
              })}
            />
          )}
        </div>
      )}
    </Modal>
  );
}
