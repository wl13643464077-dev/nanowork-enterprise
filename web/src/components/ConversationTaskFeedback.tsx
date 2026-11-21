import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Select, Space, Tag, message } from 'antd';
import { api } from '../api/client';

type Decision = 'adopt' | 'reject';

type BusinessReview = {
  required: boolean;
  canReview: boolean;
  blockedReason?: string | null;
  candidates?: Array<{ candidateIndex: number; label: string }>;
  onSubmit: (decision: Decision, note: string, selection?: { candidateIndex: number }) => Promise<void>;
};

type Props = {
  kind: 'content' | 'restaurant';
  taskId: number;
  businessReview?: BusinessReview;
};

const requestKey = (kind: string, taskId: number, decision: Decision) => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${kind}:${taskId}:${decision}:${Date.now().toString(36)}`;
};

/**
 * Workbench result feedback has two separate durable effects:
 * 1. a pending business result must first pass its canonical review route;
 * 2. the same choice is then stored in task_feedback for the employee's next run.
 *
 * Keeping the stages explicit prevents a feedback write from pretending that a
 * pending result has already been approved. If stage two fails, the confirmed
 * business decision remains visible and the user can retry only the learning write.
 */
export default function ConversationTaskFeedback({ kind, taskId, businessReview }: Props) {
  const [task, setTask] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState<Decision | null>(null);
  const [businessSaved, setBusinessSaved] = useState<Decision | null>(null);
  const [candidateIndex, setCandidateIndex] = useState<number | null>(null);
  const [partialError, setPartialError] = useState('');
  // PRD v2.2 FR-7.3：连续两次同类原因时，提示存为“我的版本”固定要求（老板确认才生效）
  const [preferenceSuggestion, setPreferenceSuggestion] = useState<{
    key: string;
    label: string;
    preference: string;
    message: string;
  } | null>(null);
  const [savingPreference, setSavingPreference] = useState(false);
  const requestSerial = useRef(0);
  const pending = useRef(false);
  const requestKeys = useRef<Partial<Record<Decision, string>>>({});

  useEffect(() => {
    const serial = ++requestSerial.current;
    pending.current = false;
    requestKeys.current = {};
    queueMicrotask(() => {
      if (serial !== requestSerial.current) return;
      setTask(null);
      setLoading(true);
      setLoadError('');
      setNote('');
      setSubmitting(null);
      setBusinessSaved(null);
      setCandidateIndex(null);
      setPartialError('');
      setPreferenceSuggestion(null);
    });
    void api
      .get(`/task-center/${kind}/${taskId}`, { silent: true })
      .then(value => {
        if (serial === requestSerial.current) setTask(value);
      })
      .catch(error => {
        if (serial === requestSerial.current) setLoadError(error instanceof Error ? error.message : '采纳状态暂未读取');
      })
      .finally(() => {
        if (serial === requestSerial.current) setLoading(false);
      });
    return () => {
      requestSerial.current += 1;
    };
  }, [kind, taskId]);

  const feedback = task?.feedback;
  const oldVersion = feedback?.currentVersion === false;
  const feedbackAvailable = task?.feedbackAvailability?.available === true && (!feedback || oldVersion);
  const reviewBlocked = businessReview?.required === true && businessReview.canReview !== true && !businessSaved;

  const decide = async (decision: Decision) => {
    if (!feedbackAvailable || pending.current || reviewBlocked) return;
    const cleanNote = note.trim();
    if (businessReview?.required && decision === 'reject' && !cleanNote) {
      message.info('请写一句不采纳的原因，方便这名员工下一次改进。');
      return;
    }
    if (
      businessReview?.required &&
      decision === 'adopt' &&
      businessReview.candidates?.length &&
      candidateIndex === null
    ) {
      message.info('请先选择要采纳的具体候选结果。');
      return;
    }
    if (businessSaved && businessSaved !== decision) {
      message.info('业务选择已经保存，请继续补记同一个选择的员工经验。');
      return;
    }
    pending.current = true;
    setSubmitting(decision);
    setPartialError('');
    let canonicalSaved = businessSaved === decision;
    try {
      let feedbackTask = task;
      if (businessReview?.required && !canonicalSaved) {
        await businessReview.onSubmit(
          decision,
          cleanNote,
          decision === 'adopt' && candidateIndex !== null ? { candidateIndex } : undefined,
        );
        canonicalSaved = true;
        setBusinessSaved(decision);
      }
      if (canonicalSaved) {
        feedbackTask = await api.get(`/task-center/${kind}/${taskId}`, { silent: true });
        if (!feedbackTask?.resultVersion) throw new Error('业务选择已保存，但最新结果版本暂未读取');
        setTask(feedbackTask);
      }
      requestKeys.current[decision] ||= requestKey(kind, taskId, decision);
      const response = await api.post(
        `/task-center/${kind}/${taskId}/feedback`,
        {
          decision,
          note: cleanNote,
          requestKey: requestKeys.current[decision],
          resultVersion: feedbackTask.resultVersion,
        },
        { silent: true },
      );
      if (!response?.ok || !response?.task) throw new Error('经验回执不完整，请刷新后重试');
      setTask(response.task);
      setBusinessSaved(null);
      if (kind === 'restaurant' && response.preferenceSuggestion?.preference) {
        setPreferenceSuggestion(response.preferenceSuggestion);
      }
      message.success(decision === 'adopt' ? '已采纳，并记住这次经验' : '已记录不采纳，原稿和改进意见已保留');
    } catch (error) {
      const reason = error instanceof Error ? error.message : '操作暂未完成，请重试';
      if (canonicalSaved) {
        setPartialError(`业务选择已经保存；员工经验暂未记入：${reason}`);
      } else {
        message.error(reason);
      }
    } finally {
      pending.current = false;
      setSubmitting(null);
    }
  };

  if (loading) return <p className="ewb-conversation-feedback-note">正在读取采纳状态…</p>;
  if (loadError) return <Alert type="warning" showIcon message="采纳状态暂未读取" description={loadError} />;
  if (!task?.feedbackAvailability && !feedback) return null;

  return (
    <section className="ewb-conversation-feedback" aria-label="结果采纳与员工学习">
      <div className="ewb-conversation-feedback-title">
        <strong>这份结果是否采纳？</strong>
        <span>选择和意见会留在本条聊天记录里，供这名员工下一次参考。</span>
      </div>
      {feedback && (
        <div className="ewb-conversation-feedback-record">
          <Tag color={!oldVersion && feedback.decision === 'adopt' ? 'green' : 'default'}>
            {oldVersion
              ? feedback.decision === 'adopt'
                ? '旧版本已采纳'
                : '旧版本未采纳'
              : feedback.decision === 'adopt'
                ? '已采纳'
                : '未采纳（原稿已保留）'}
          </Tag>
          {feedback.note && <p>{feedback.note}</p>}
          {feedback.learningLabel && <p>{feedback.learningLabel}</p>}
        </div>
      )}
      {preferenceSuggestion && (
        <Alert
          type="info"
          showIcon
          message={preferenceSuggestion.message}
          action={
            <Space direction="vertical" size={4}>
              <Button
                size="small"
                type="primary"
                loading={savingPreference}
                onClick={async () => {
                  setSavingPreference(true);
                  try {
                    await api.put('/employee-workbench/restaurant-preferences/slots', {
                      addOutputPref: preferenceSuggestion.preference,
                    });
                    message.success('已存为默认设置，以后派活会自动带上');
                    setPreferenceSuggestion(null);
                  } catch (error) {
                    message.error(error instanceof Error ? error.message : '保存失败');
                  } finally {
                    setSavingPreference(false);
                  }
                }}
              >
                存为默认设置
              </Button>
              <Button size="small" type="text" onClick={() => setPreferenceSuggestion(null)}>
                不用了
              </Button>
            </Space>
          }
        />
      )}
      {partialError && (
        <Alert
          type="warning"
          showIcon
          message={partialError}
          description="点击原选择即可只重试经验记录，不会重复执行业务采纳。"
        />
      )}
      {reviewBlocked ? (
        <Alert type="info" showIcon message={businessReview?.blockedReason || '请等待有审阅权限的负责人处理这份结果'} />
      ) : feedbackAvailable ? (
        <>
          {businessReview?.required && !!businessReview.candidates?.length && (
            <Select
              aria-label="选择要采纳的候选结果"
              placeholder="选择要采纳的具体结果"
              value={candidateIndex ?? undefined}
              options={businessReview.candidates.map(candidate => ({
                value: candidate.candidateIndex,
                label: `${candidate.candidateIndex + 1}. ${candidate.label}`,
              }))}
              onChange={setCandidateIndex}
              disabled={Boolean(submitting) || businessSaved !== null}
            />
          )}
          <Input.TextArea
            aria-label="给数字员工的采纳意见"
            placeholder={
              businessReview?.required ? '可写满意之处；不采纳时请写明修改意见' : '可选：哪里满意，或下次希望怎么改？'
            }
            maxLength={businessReview?.required ? 1000 : 2000}
            showCount
            autoSize={{ minRows: 2, maxRows: 5 }}
            value={note}
            onChange={event => setNote(event.target.value)}
            disabled={Boolean(submitting)}
          />
          <Space wrap>
            <Button
              type="primary"
              loading={submitting === 'adopt'}
              disabled={Boolean(submitting) || (businessSaved !== null && businessSaved !== 'adopt')}
              onClick={() => void decide('adopt')}
            >
              {businessSaved === 'adopt' ? '补记采纳经验' : '我采纳'}
            </Button>
            <Button
              loading={submitting === 'reject'}
              disabled={Boolean(submitting) || (businessSaved !== null && businessSaved !== 'reject')}
              onClick={() => void decide('reject')}
            >
              {businessSaved === 'reject' ? '补记不采纳经验' : '不采纳，保留原稿'}
            </Button>
          </Space>
        </>
      ) : !feedback && task.feedbackAvailability?.reason ? (
        <Alert type="info" showIcon message={task.feedbackAvailability.reason} />
      ) : null}
    </section>
  );
}
