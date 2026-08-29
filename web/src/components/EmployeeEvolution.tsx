import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Empty, Popconfirm, Skeleton, Tag, message } from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  ExperimentOutlined,
  FallOutlined,
  HistoryOutlined,
  RiseOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { api } from '../api/client';
import './EmployeeEvolution.css';

// 数字员工自动进化面板（Warp 自我改进模式）。
// 闭环：验收反馈（采纳/驳回+理由）→ AI 改进器提炼「实战心得」提案 → 人审采纳 → 派活自动注入。
// 边界：提案永远人审后才生效；生成提案是真实计费调用。

type EvolutionNote = {
  id: number;
  note: string;
  rationale?: string;
  evidence?: string;
  status: string;
  created_at: string;
  retired_at?: string;
};

type EvolutionProposal = {
  id: number;
  summary: string;
  status: string;
  createdAt: string;
  decidedAt?: string;
  proposal: {
    verdict: string;
    additions: { note: string; rationale?: string; evidence?: string }[];
    retireNoteIds: number[];
  } | null;
};

type EvolutionData = {
  specialist: { id: number; name: string; person?: string };
  stats: { total: number; adopted: number; rejected: number; rejectReasons: string[]; windowDays: number };
  minSignals: number;
  notes: EvolutionNote[];
  proposals: EvolutionProposal[];
};

export default function EmployeeEvolution({ specialistId }: { specialistId: number }) {
  const [data, setData] = useState<EvolutionData | null>(null);
  const [error, setError] = useState('');
  const [proposing, setProposing] = useState(false);
  const [deciding, setDeciding] = useState<number | null>(null);

  const load = useCallback(
    () =>
      api
        .get(`/employees/evolution/${specialistId}`)
        .then((payload: EvolutionData) => {
          setData(payload);
          setError('');
        })
        .catch((err: any) => setError(err?.message || '进化数据读取失败')),
    [specialistId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Alert type="warning" showIcon message={error} />;
  if (!data) return <Skeleton active paragraph={{ rows: 5 }} />;

  const pending = data.proposals.find(item => item.status === '待审核') || null;
  const history = data.proposals.filter(item => item.status !== '待审核');
  const activeNotes = data.notes.filter(item => item.status === 'active');
  const canPropose = data.stats.total >= data.minSignals && !pending;

  const propose = async () => {
    setProposing(true);
    try {
      const out = await api.post(`/employees/evolution/${specialistId}/propose`, {});
      message.success(`进化提案已生成（${out.billing?.chargedCredits ?? '-'} 积分）；采纳后才会生效`);
      await load();
    } catch {
      /* client 已 toast */
    } finally {
      setProposing(false);
    }
  };

  const decide = async (proposalId: number, decision: 'adopt' | 'reject') => {
    setDeciding(proposalId);
    try {
      const out = await api.post(`/employees/evolution/proposals/${proposalId}/decide`, { decision });
      message.success(
        decision === 'adopt' ? `已采纳：${out.adoptedNotes} 条心得生效，下次派活自动运用` : '已驳回该提案',
      );
      await load();
    } catch {
      /* client 已 toast */
    } finally {
      setDeciding(null);
    }
  };

  const retireNote = async (noteId: number) => {
    try {
      await api.put(`/employees/evolution/notes/${noteId}/retire`, {});
      message.success('该心得已退役，不再注入派活');
      await load();
    } catch {
      /* client 已 toast */
    }
  };

  return (
    <div className="evo">
      <div className="evo-intro">
        <ExperimentOutlined />
        <p>
          每次你验收任务（采纳或驳回+理由），都是这名员工的养料。点「提炼进化提案」让 AI
          对比产出与你的反馈，总结出改进心得；<b>你采纳后</b>，员工下次干活会自动带上这些心得。
        </p>
      </div>

      <div className="evo-stats">
        <div className="evo-stat">
          <strong>{data.stats.total}</strong>
          <span>近 {data.stats.windowDays} 天验收</span>
        </div>
        <div className="evo-stat" data-tone="good">
          <strong>
            <RiseOutlined /> {data.stats.adopted}
          </strong>
          <span>被采纳</span>
        </div>
        <div className="evo-stat" data-tone={data.stats.rejected > 0 ? 'bad' : undefined}>
          <strong>
            <FallOutlined /> {data.stats.rejected}
          </strong>
          <span>被驳回</span>
        </div>
        <div className="evo-stat">
          <strong>{activeNotes.length}</strong>
          <span>生效心得</span>
        </div>
        <Button
          type="primary"
          icon={<RobotOutlined />}
          loading={proposing}
          disabled={!canPropose}
          onClick={() => void propose()}
        >
          {pending ? '有提案待审批' : '提炼进化提案'}
        </Button>
      </div>
      {data.stats.total < data.minSignals && (
        <Alert
          type="info"
          showIcon
          message={`近 ${data.stats.windowDays} 天验收记录 ${data.stats.total} 条，满 ${data.minSignals} 条才能提炼可靠心得——多派几单活并完成验收（驳回时写清理由效果最好）。`}
        />
      )}
      {data.stats.rejectReasons.length > 0 && (
        <div className="evo-reasons">
          <span className="evo-reasons-label">近期驳回理由（进化的核心养料）</span>
          {data.stats.rejectReasons.slice(0, 4).map((reason, index) => (
            <em key={index}>{reason}</em>
          ))}
        </div>
      )}

      {pending && pending.proposal && (
        <section className="evo-proposal" aria-label="待审批的进化提案">
          <header>
            <Tag color="processing">待你审批</Tag>
            <strong>{pending.summary}</strong>
            <span>{pending.createdAt?.slice(5, 16)}</span>
          </header>
          {pending.proposal.verdict === 'insufficient' ? (
            <p className="evo-insufficient">
              AI 判断当前反馈样本还不足以提炼可靠心得（这是诚实结论，不是失败）。继续验收几单再试。
            </p>
          ) : (
            <ul className="evo-additions">
              {pending.proposal.additions.map((item, index) => (
                <li key={index}>
                  <strong>{item.note}</strong>
                  {item.rationale && <span>为什么：{item.rationale}</span>}
                  {item.evidence && <small>依据：{item.evidence}</small>}
                </li>
              ))}
            </ul>
          )}
          <div className="evo-proposal-actions">
            <Button
              type="primary"
              icon={<CheckOutlined />}
              loading={deciding === pending.id}
              onClick={() => void decide(pending.id, 'adopt')}
            >
              采纳（立即生效）
            </Button>
            <Button
              icon={<CloseOutlined />}
              loading={deciding === pending.id}
              onClick={() => void decide(pending.id, 'reject')}
            >
              驳回
            </Button>
            <span className="evo-boundary">采纳后才会写入员工心得并影响后续派活</span>
          </div>
        </section>
      )}

      <section className="evo-notes" aria-label="已生效实战心得">
        <h4>已生效的实战心得（派活时自动注入）</h4>
        {activeNotes.length === 0 ? (
          <Empty description="还没有生效心得；完成几次验收后提炼第一份进化提案" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <ul>
            {activeNotes.map(note => (
              <li key={note.id}>
                <div className="evo-note-copy">
                  <strong>{note.note}</strong>
                  {note.rationale && <span>为什么：{note.rationale}</span>}
                  {note.evidence && <small>依据：{note.evidence}</small>}
                </div>
                <Popconfirm title="退役后不再注入派活，确定？" onConfirm={() => void retireNote(note.id)}>
                  <Button size="small" type="text" danger>
                    退役
                  </Button>
                </Popconfirm>
              </li>
            ))}
          </ul>
        )}
      </section>

      {history.length > 0 && (
        <section className="evo-history" aria-label="进化历史">
          <h4>
            <HistoryOutlined /> 进化历史
          </h4>
          <ul>
            {history.map(item => (
              <li key={item.id}>
                <Tag color={item.status === '已采纳' ? 'success' : 'default'}>{item.status}</Tag>
                <span>{item.summary}</span>
                <small>{(item.decidedAt || item.createdAt || '').slice(5, 16)}</small>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
