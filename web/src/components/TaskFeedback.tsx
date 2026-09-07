import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Space, Tag, message } from 'antd';
import { api } from '../api/client';

export default function TaskFeedback({ task, onUpdated }: { task: any; onUpdated: (task: any) => void }) {
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState<'adopt' | 'reject' | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const requestKeys = useRef<Partial<Record<'adopt' | 'reject', string>>>({});
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const feedback = task.feedback;
  const oldVersion = feedback?.currentVersion === false;
  const available = task.feedbackAvailability?.available === true && (!feedback || oldVersion);
  const decide = async (decision: 'adopt' | 'reject') => {
    if (!available || pending.current || !task.kind || !task.id) return;
    pending.current = true;
    setSubmitting(decision);
    requestKeys.current[decision] ||= crypto.randomUUID();
    try {
      const response = await api.post(`/task-center/${task.kind}/${task.id}/feedback`, {
        decision,
        note: note.trim(),
        requestKey: requestKeys.current[decision],
        resultVersion: task.resultVersion,
      });
      if (!response?.ok || !response?.task) throw new Error('反馈回执不完整，请刷新任务核对');
      if (mounted.current) {
        onUpdated(response.task);
        message.success(decision === 'adopt' ? '已记录采纳' : '已记录不采纳，原稿已保留');
      }
    } catch (error) {
      if (mounted.current) message.error(error instanceof Error ? error.message : '反馈未保存，请重试');
    } finally {
      pending.current = false;
      if (mounted.current) setSubmitting(null);
    }
  };
  if (!task.feedbackAvailability && !feedback) return null;
  return (
    <section className="task-center-feedback" aria-label="结果采纳">
      <h3>这份结果是否采用？</h3>
      <p>记录你的选择和改进意见，供这位员工今后参考。原任务的执行、费用和发布状态会保留。</p>
      {feedback && (
        <div className="task-center-feedback-record">
          <Tag color={!oldVersion && feedback.decision === 'adopt' ? 'green' : 'default'}>
            {oldVersion
              ? feedback.decision === 'adopt'
                ? '旧版本采纳'
                : '旧版本不采纳'
              : feedback.decision === 'adopt'
                ? '已记录采纳'
                : '已记录不采纳（原稿已保留）'}
          </Tag>
          {oldVersion && (
            <p>
              {feedback.versionLabel || task.feedbackAvailability?.reason || '当前结果已变化，原选择仅属于旧版本。'}
            </p>
          )}
          {feedback.note && <p>{feedback.note}</p>}
          {feedback.learningLabel && <p>{feedback.learningLabel}</p>}
        </div>
      )}
      {available ? (
        <>
          <Input.TextArea
            aria-label="给数字员工的反馈"
            placeholder="可选：哪里满意，或下次希望怎么改？"
            maxLength={2000}
            showCount
            autoSize={{ minRows: 2, maxRows: 5 }}
            value={note}
            onChange={event => setNote(event.target.value)}
            disabled={Boolean(submitting)}
          />
          <Space wrap className="task-center-feedback-actions">
            <Button
              type="primary"
              loading={submitting === 'adopt'}
              disabled={Boolean(submitting)}
              onClick={() => void decide('adopt')}
            >
              采纳这份结果
            </Button>
            <Button
              loading={submitting === 'reject'}
              disabled={Boolean(submitting)}
              onClick={() => void decide('reject')}
            >
              不采纳，保留原稿
            </Button>
          </Space>
        </>
      ) : !feedback && task.feedbackAvailability?.reason ? (
        <Alert type="info" showIcon message={task.feedbackAvailability.reason} />
      ) : null}
    </section>
  );
}
