import { Button, Modal, Space, Tag, message } from 'antd';
import { CheckOutlined, ExclamationCircleOutlined, RedoOutlined } from '@ant-design/icons';
import { useState, type ReactNode } from 'react';
import { api } from '../api/client';
import { Markdown } from './Markdown';
import './EmployeeDraftCard.css';

// P0-1「失败不交白卷」：老板等了很久时，看到的不是白卷，而是这份没过质量门的草稿。
// 卡片只说人话：未通过的检查、正文、两条出路（带原要求重新派活 / 就用这份草稿）。
// 不出现契约 ID、指纹、字段路径等技术词——那些留在执行证据里给审计看。

export type EmployeeDraftCheck = {
  category?: string;
  label: string;
  count?: number;
  details?: string[];
};

export type EmployeeDraftInfo = {
  state: 'pending' | 'accepted';
  failReason?: string;
  failReasonLabel?: string;
  attempts?: number;
  failedChecks?: EmployeeDraftCheck[];
  failedCheckCount?: number;
  acceptable?: boolean;
  canAccept?: boolean;
  acceptBlockedReason?: string | null;
  acceptedAt?: string | null;
  acceptedByName?: string | null;
  requiresReview?: boolean;
  employeeIdx?: number | null;
};

export type EmployeeDraftAcceptResult = {
  ok?: boolean;
  status?: string;
  displayStatus?: string;
  requiresReview?: boolean;
  approvalId?: number | null;
};

type Props = {
  taskId: number | string;
  draft: EmployeeDraftInfo;
  /** 草稿正文（Markdown）。不传则只显示检查项与动作，正文由外层自行展示。 */
  body?: string | null;
  /** 正文默认是否展开（TaskCenter 详情里默认展开，工作台里正文另有报告区）。 */
  bodyOpen?: boolean;
  onRedispatch?: () => void;
  onAccepted?: (result: EmployeeDraftAcceptResult) => void;
  extra?: ReactNode;
};

function acceptedTime(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false });
}

export default function EmployeeDraftCard({
  taskId,
  draft,
  body,
  bodyOpen = false,
  onRedispatch,
  onAccepted,
  extra,
}: Props) {
  const [accepting, setAccepting] = useState(false);
  const checks = Array.isArray(draft.failedChecks) ? draft.failedChecks : [];
  const checkCount = Number(draft.failedCheckCount ?? checks.reduce((sum, item) => sum + Number(item.count || 1), 0));
  const pending = draft.state === 'pending';
  const reasonLabel =
    draft.failReasonLabel ||
    (draft.failReason === 'timeout' ? '执行超时，已保留最后一轮完整正文' : '质量门未通过，已保留最后一轮完整正文');

  const confirmAccept = () => {
    Modal.confirm({
      title: '就用这份草稿？',
      icon: <ExclamationCircleOutlined />,
      content: (
        <div className="employee-draft-confirm">
          <p>这份草稿没有通过岗位质量门，接受后只能作为内部参考稿：</p>
          <ul>
            <li>不会自动变成“可用于业务”，也不会沉淀进知识库；</li>
            <li>不会生成正式导出文件；</li>
            <li>按任务锁定的审批策略，可能仍需人工审阅一次。</li>
          </ul>
          <p>需要正式可用的版本，请选择“带原要求重新派活”。</p>
        </div>
      ),
      okText: '接受为内部参考稿',
      cancelText: '再想想',
      async onOk() {
        setAccepting(true);
        try {
          const result = (await api.post(`/marshals/tasks/${taskId}/accept-draft`, {})) as EmployeeDraftAcceptResult;
          message.success(
            result?.requiresReview
              ? '已接受草稿，并按审批策略送人工审阅'
              : '已接受为内部参考稿（未通过质量门，不可用于正式业务）',
          );
          onAccepted?.(result);
        } catch {
          // api 客户端已提示服务端错误（例如草稿含未核验来源不可接受）
        } finally {
          setAccepting(false);
        }
      },
    });
  };

  return (
    <section
      className={`employee-draft-card ${pending ? 'is-pending' : 'is-accepted'}`}
      aria-label={pending ? '未达标草稿，待处理' : '已接受的未达标草稿'}
    >
      <header className="employee-draft-card__head">
        <div>
          <Space size={6} wrap>
            <Tag color="orange">{pending ? '未达标草稿' : '已接受草稿（内部参考）'}</Tag>
            {draft.attempts ? <Tag>已尝试 {draft.attempts} 轮</Tag> : null}
          </Space>
          <h4>{pending ? '这份结果没有通过质量门，但已为你保留' : '这份草稿已被接受为内部参考稿'}</h4>
          <p>{reasonLabel}。</p>
          {!pending && (
            <p className="employee-draft-card__accepted">
              {draft.acceptedByName ? `${draft.acceptedByName} ` : ''}
              {acceptedTime(draft.acceptedAt) ? `于 ${acceptedTime(draft.acceptedAt)} ` : ''}
              接受{draft.requiresReview ? '，并已送人工审阅' : '为内部参考稿'}；未通过质量门，不可作为正式业务依据。
            </p>
          )}
        </div>
        {extra}
      </header>

      <details className="employee-draft-card__checks">
        <summary>
          <strong>未通过检查 {checkCount} 条</strong>
          <small>{checks.length ? '展开查看具体是哪几类没过' : '本次没有记录到具体检查项'}</small>
        </summary>
        {checks.length > 0 && (
          <ul>
            {checks.map((check, index) => (
              <li key={`${check.category || 'check'}-${index}`}>
                <span className="employee-draft-card__check-label">
                  {check.label}
                  {Number(check.count || 1) > 1 ? `（${check.count} 处）` : ''}
                </span>
                {Array.isArray(check.details) && check.details.length > 0 && (
                  <ul className="employee-draft-card__check-details">
                    {check.details.map((detail, detailIndex) => (
                      <li key={detailIndex}>{detail}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </details>

      {body ? (
        <details className="employee-draft-card__body" open={bodyOpen}>
          <summary>
            <strong>草稿正文</strong>
            <small>原样保留数字员工最后一轮完整输出</small>
          </summary>
          <div className="employee-draft-card__markdown">
            <Markdown content={body} />
          </div>
        </details>
      ) : null}

      {pending && (
        <footer className="employee-draft-card__actions">
          <Space size={8} wrap>
            {onRedispatch && (
              <Button type="primary" icon={<RedoOutlined />} onClick={onRedispatch}>
                带原要求重新派活
              </Button>
            )}
            <Button
              icon={<CheckOutlined />}
              loading={accepting}
              disabled={draft.canAccept !== true}
              title={draft.canAccept === true ? undefined : draft.acceptBlockedReason || '当前不能接受这份草稿'}
              onClick={confirmAccept}
            >
              就用这份草稿
            </Button>
          </Space>
          <p className="employee-draft-card__hint">
            {draft.canAccept === true
              ? '接受后只作内部参考，不会自动进入业务可用状态，也不会导出正式文件。'
              : draft.acceptBlockedReason || '当前不能接受这份草稿，请带原要求重新派活。'}
          </p>
        </footer>
      )}
    </section>
  );
}
