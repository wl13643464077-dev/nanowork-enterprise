import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import { Alert, Button, Spin, Tooltip } from 'antd';
import {
  AppstoreOutlined,
  BulbOutlined,
  EditOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  PictureOutlined,
  SearchOutlined,
  TeamOutlined,
  VideoCameraOutlined,
  HistoryOutlined,
  SendOutlined,
  BarChartOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, getUser } from '../api/client';
import EmployeeAvatar from '../components/EmployeeAvatar';
import EmployeeWorkbench from '../components/EmployeeWorkbench';
import ContentPipelineWorkbench from '../components/ContentPipelineWorkbench';
import ContentSampleLibrary, { sampleBriefFromSample } from '../components/ContentSampleLibrary';
import ContentPublishAssistant, { type PublishAssistantTab } from '../components/ContentPublishAssistant';
import { CONTENT_CREW_STATIONS, type ContentCrewKey, type ContentCrewStation } from '../components/contentCrewConfig';
import './ContentFactory.css';
const ContentAutomationManager = lazy(() => import('../components/ContentAutomationManager'));
const ContentResourceLibrary = lazy(() => import('../components/ContentResourceLibrary'));
const crewStationIcon = (key: ContentCrewKey): ReactNode =>
  ({
    trend: <BulbOutlined />,
    research: <SearchOutlined />,
    benchmark: <AppstoreOutlined />,
    draft: <EditOutlined />,
    style: <FileTextOutlined />,
    media: <VideoCameraOutlined />,
    cover: <PictureOutlined />,
    deck: <AppstoreOutlined />,
    publish: <SendOutlined />,
    retro: <BarChartOutlined />,
    commerce_video: <VideoCameraOutlined />,
    xhs_note: <PictureOutlined />,
  })[key];
export default function ContentFactory() {
  const nav = useNavigate();
  const location = useLocation();
  const canViewCrewInternals = ['boss', 'admin', 'platform_super'].includes(getUser()?.role || '');
  const [searchParams] = useSearchParams();
  const requestedTask = searchParams.get('task');
  const pipelineIdFromQuery = Number(searchParams.get('pipelineId'));
  const mediaJobIdFromQuery = Number(searchParams.get('mediaJobId'));
  const requestedPipelineId =
    Number.isSafeInteger(pipelineIdFromQuery) && pipelineIdFromQuery > 0 ? pipelineIdFromQuery : null;
  const requestedMediaJobId =
    Number.isSafeInteger(mediaJobIdFromQuery) && mediaJobIdFromQuery > 0 ? mediaJobIdFromQuery : null;
  const [pipelineOpen, setPipelineOpen] = useState(Boolean(requestedPipelineId));
  const [pipelineFocusId, setPipelineFocusId] = useState<number | null>(requestedPipelineId);
  const [sampleLibraryOpen, setSampleLibraryOpen] = useState(false);
  const [salesVideoPreset, setSalesVideoPreset] = useState<{ key: number; text: string } | null>(null);
  const [xhsNotePreset, setXhsNotePreset] = useState<{ key: number; text: string } | null>(null);
  const [resourceTab, setResourceTab] = useState<'素材库' | '模板库' | null>(() => {
    const tab = searchParams.get('tab');
    return tab === '素材库' || tab === '模板库' ? tab : null;
  });
  const [automationOpen, setAutomationOpen] = useState(searchParams.get('tab') === 'automations');
  const [publishAssistant, setPublishAssistant] = useState<{ id: number; tab: PublishAssistantTab } | null>(() => {
    const id = Number(searchParams.get('publishAssistant'));
    const tab = searchParams.get('assistantTab');
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return { id, tab: tab === 'pack' || tab === 'metrics' || tab === 'timeline' ? tab : 'schedule' };
  });
  const [contentCrew, setContentCrew] = useState<ContentCrewStation[]>(CONTENT_CREW_STATIONS);
  const [crewLoading, setCrewLoading] = useState(true);
  const [crewConnected, setCrewConnected] = useState(false);
  const [crewWorkbenchIdx, setCrewWorkbenchIdx] = useState<number | null>(
    requestedMediaJobId || requestedTask === 'ai-sales-video' ? 10 : requestedTask === 'ai-xhs-note' ? 11 : null,
  );
  const [crewMediaJobId, setCrewMediaJobId] = useState<number | null>(requestedMediaJobId);
  const [crewProfileTab, setCrewProfileTab] = useState<'skills' | undefined>();
  useEffect(() => {
    const employeeIdx =
      requestedMediaJobId || requestedTask === 'ai-sales-video' ? 10 : requestedTask === 'ai-xhs-note' ? 11 : null;
    if (employeeIdx === null) return;
    const stateBrief = (location.state as { brief?: string; q?: string } | null)?.brief;
    const queryBrief = searchParams.get('brief') || searchParams.get('q') || '';
    const brief = typeof stateBrief === 'string' && stateBrief.trim() ? stateBrief.trim() : queryBrief.trim();
    if (stateBrief) nav(location.pathname + location.search, { replace: true, state: null });
    const frame = requestAnimationFrame(() => {
      setCrewWorkbenchIdx(employeeIdx);
      setCrewMediaJobId(requestedMediaJobId);
      setCrewProfileTab(undefined);
      if (brief) {
        if (employeeIdx === 11) setXhsNotePreset({ key: Date.now(), text: brief });
        else setSalesVideoPreset({ key: Date.now(), text: brief });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [location.pathname, location.search, location.state, nav, requestedMediaJobId, requestedTask, searchParams]);
  const [crewWorkbenchRunId, setCrewWorkbenchRunId] = useState<number | null>(null);
  const [retroContentId, setRetroContentId] = useState<number | null>(null);
  const crewRequestSerial = useRef(0);
  const loadCrew = useCallback(() => {
    const serial = ++crewRequestSerial.current;
    return api
      .get('/content/crew')
      .then((data: any) => {
        if (serial !== crewRequestSerial.current) return;
        const rows = Array.isArray(data?.employees)
          ? data.employees
          : Array.isArray(data)
            ? data
            : data?.crew || data?.stations || [];
        if (!Array.isArray(rows) || !rows.length) return;
        setContentCrew(
          CONTENT_CREW_STATIONS.map(base => {
            const remote =
              rows.find((row: any) => Number(row?.idx) === base.order) ||
              rows.find((row: any) => row?.key === base.key) ||
              {};
            const rawIdx = remote.idx ?? remote.employeeIdx ?? remote.employee_idx;
            const employeeIdx = rawIdx == null || rawIdx === '' ? null : Number(rawIdx);
            return {
              ...base,
              key: remote.key || base.key,
              name: remote.name || base.name,
              group: remote.group || base.group,
              emoji: remote.emoji || base.emoji,
              person: null,
              optional: typeof remote.optional === 'boolean' ? remote.optional : base.optional,
              employeeIdx: Number.isInteger(employeeIdx) ? employeeIdx : null,
              moduleGroup: remote.moduleGroup,
              skill: remote.skill,
              color: remote.color,
              duty: remote.duty,
              intro: remote.intro,
              approval: remote.approval,
              capabilities: Array.isArray(remote.capabilities) ? remote.capabilities : [],
              capabilityCount: Number.isFinite(Number(remote.capabilityCount))
                ? Number(remote.capabilityCount)
                : undefined,
              capabilityNames: Array.isArray(remote.capabilityNames) ? remote.capabilityNames.map(String) : [],
              skillCount: Number.isFinite(Number(remote.skillCount)) ? Number(remote.skillCount) : undefined,
              outputKeys: Array.isArray(remote.outputKeys) ? remote.outputKeys : [],
              taskTypes:
                Array.isArray(remote.taskTypes) && remote.taskTypes.length
                  ? remote.taskTypes.map(String)
                  : base.taskTypes,
              runtime: remote.runtime && typeof remote.runtime === 'object' ? remote.runtime : undefined,
            };
          }),
        );
        setCrewConnected(true);
      })
      .catch(() => {
        if (serial === crewRequestSerial.current) setCrewConnected(false);
      })
      .finally(() => {
        if (serial === crewRequestSerial.current) setCrewLoading(false);
      });
  }, []);
  useEffect(() => {
    void loadCrew();
    return () => {
      crewRequestSerial.current += 1;
    };
  }, [loadCrew]);
  useEffect(() => {
    if (!requestedPipelineId) return;
    const frame = requestAnimationFrame(() => {
      setPipelineFocusId(requestedPipelineId);
      setPipelineOpen(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [requestedPipelineId]);
  const featuredKeys: ContentCrewKey[] = ['xhs_note', 'commerce_video'];
  const featuredCrew = featuredKeys
    .map(key => contentCrew.find(item => item.key === key))
    .filter((item): item is ContentCrewStation => Boolean(item));
  const pipelineCrew = contentCrew.filter(item => !featuredKeys.includes(item.key));
  const crewZones = [
    featuredCrew.length > 0
      ? {
          key: 'featured' as const,
          featured: true,
          title: '独立出片主推区',
          description: '单人直出成品，适合门店日常高频获客；建议日常测款与种草优先选小红书图文，视频先审脚本再渲染。',
          countLabel: `${featuredCrew.length} 位专岗`,
          items: featuredCrew,
        }
      : null,
    pipelineCrew.length > 0
      ? {
          key: 'pipeline' as const,
          featured: false,
          title: '10 工位标准内容流水线（环节 01–10）',
          description:
            '覆盖趋势选题、事实核验、爆款拆解、撰稿、视觉到复盘全链路，既可按工位单点派活，也可在底部启动完整团队流水线。',
          countLabel: `${pipelineCrew.length} 个工位`,
          items: pipelineCrew,
        }
      : null,
  ].filter((zone): zone is NonNullable<typeof zone> => zone !== null);

  return (
    <div className="content-factory-page">
      <header className="content-command-head">
        <div>
          <h1>内容生产仓</h1>
          <p>选择数字员工，说明目标并上传素材。所有任务的输入、结果与采纳记录，都在统一任务中心查看。</p>
        </div>
        <Button type="primary" size="large" icon={<HistoryOutlined />} onClick={() => nav('/tasks')}>
          全部历史 · 任务中心
        </Button>
      </header>
      {!crewLoading && !crewConnected && (
        <Alert
          type="error"
          showIcon
          message="员工信息暂未加载"
          description="请重新加载后再派活。"
          action={<Button onClick={() => void loadCrew()}>重新加载</Button>}
        />
      )}
      <section className="content-crew-command" aria-labelledby="content-crew-title">
        <header className="content-crew-head">
          <div>
            <span>岗位目录 · 每位员工都可以单独派活</span>
            <h2 id="content-crew-title">内容数字员工</h2>
          </div>
          <span className={`content-crew-connection ${crewConnected ? 'connected' : ''}`}>
            <i aria-hidden="true" />
            {crewLoading ? '连接中' : crewConnected ? `${contentCrew.length} 位在岗` : '等待接口'}
          </span>
        </header>
        <div className="content-crew-zones" aria-label="内容数字员工">
          {crewZones.map(zone => (
            <div
              key={zone.key}
              className={`content-crew-zone ${zone.featured ? 'content-crew-zone--featured' : 'content-crew-zone--pipeline'}`}
              aria-label={zone.title}
            >
              <div className="content-crew-zone-head">
                <div>
                  <h3>{zone.title}</h3>
                  <p>{zone.description}</p>
                </div>
                <span className="content-crew-zone-count">{zone.countLabel}</span>
              </div>
              <div className="content-crew-grid">
                {zone.items.map(station => {
                  const outputs = Number(station.runtime?.outputs || 0) + Number(station.runtime?.mediaJobs || 0);
                  const isXhs = station.key === 'xhs_note';
                  const isVideo = station.key === 'commerce_video';
                  const subLabel = isXhs
                    ? '独立出片 · 图文种草'
                    : isVideo
                      ? '独立出片 · 短视频'
                      : `${station.employeeIdx != null ? `工位 ${String(station.order + 1).padStart(2, '0')}` : '岗位待绑定'} · ${station.optional ? '按需岗位' : '核心岗位'}`;
                  return (
                    <article
                      className={`content-crew-card${zone.featured ? ' content-crew-card--featured' : ''}${isXhs ? ' content-crew-card--recommended' : isVideo ? ' content-crew-card--video' : ''}`}
                      key={station.key}
                      style={station.color ? ({ '--dept': station.color } as CSSProperties) : undefined}
                    >
                      {(isXhs || isVideo) && (
                        <div className="content-crew-card-badge-row">
                          <span
                            className={`content-crew-priority-tag ${isXhs ? 'content-crew-priority-tag--recommended' : 'content-crew-priority-tag--cost'}`}
                          >
                            {isXhs ? '主推 · 低成本高频' : '视频成片 · 高成本先审脚本'}
                          </span>
                        </div>
                      )}
                      <header className="content-crew-card-head">
                        {station.employeeIdx != null ? (
                          <EmployeeAvatar
                            idx={station.employeeIdx}
                            name={station.person || station.name}
                            color={station.color || 'var(--ui-primary)'}
                            size={50}
                          />
                        ) : (
                          <span className="content-crew-icon" aria-hidden="true">
                            {crewStationIcon(station.key)}
                          </span>
                        )}
                        <div className="content-crew-card-identity">
                          <h3>{station.person || station.name}</h3>
                          <span>{station.name}</span>
                          <small>{subLabel}</small>
                        </div>
                        <span className={`content-crew-card-state${outputs > 0 ? ' has-output' : ''}`}>
                          {outputs > 0 ? `${outputs} 份产出` : '待命'}
                        </span>
                      </header>
                      <p className="content-crew-card-duty">{station.intro || station.duty || '岗位职责正在同步。'}</p>
                      {(station.capabilityCount || station.skillCount || null) && (
                        <button
                          type="button"
                          className="content-crew-card-powers"
                          title="点击打开工作台查看完整能力与技能"
                          aria-label={`查看${station.person || station.name}的完整能力与技能`}
                          disabled={station.employeeIdx == null}
                          onClick={() => {
                            setCrewWorkbenchRunId(null);
                            setCrewProfileTab(canViewCrewInternals ? 'skills' : undefined);
                            setCrewWorkbenchIdx(station.employeeIdx);
                          }}
                        >
                          <span>
                            能力 {station.capabilityCount || 0} · 技能 {station.skillCount || 0}
                          </span>
                          {(station.capabilityNames || []).slice(0, 2).map(name => (
                            <em key={name}>{name}</em>
                          ))}
                        </button>
                      )}
                      <div className="content-crew-card-deliverables" aria-label="常用交付">
                        {(station.taskTypes || []).slice(0, 3).map(taskType => (
                          <span key={taskType}>{taskType}</span>
                        ))}
                      </div>
                      <div className="content-crew-card-actions">
                        <Tooltip
                          title={station.employeeIdx == null ? '该岗位尚未同步数字员工编号，暂时不能打开工作台' : ''}
                        >
                          <Button
                            type="primary"
                            block
                            icon={<TeamOutlined />}
                            disabled={station.employeeIdx == null}
                            onClick={() => {
                              setCrewWorkbenchRunId(null);
                              setCrewProfileTab(undefined);
                              setCrewWorkbenchIdx(station.employeeIdx);
                            }}
                          >
                            打开工作台 · 派活
                          </Button>
                        </Tooltip>
                        {station.key === 'commerce_video' && (
                          <Button icon={<FolderOpenOutlined />} onClick={() => setSampleLibraryOpen(true)}>
                            样片库
                          </Button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <ContentSampleLibrary
        open={sampleLibraryOpen}
        onClose={() => setSampleLibraryOpen(false)}
        onUseSample={sample => {
          setSalesVideoPreset({ key: Date.now(), text: sampleBriefFromSample(sample) });
          setSampleLibraryOpen(false);
          setCrewMediaJobId(null);
          setCrewProfileTab(undefined);
          setCrewWorkbenchRunId(null);
          setCrewWorkbenchIdx(10);
        }}
      />

      <ContentPublishAssistant
        open={publishAssistant !== null}
        contentId={publishAssistant?.id ?? null}
        initialTab={publishAssistant?.tab}
        onClose={() => setPublishAssistant(null)}
        onOpenRetrospective={id => {
          setPublishAssistant(null);
          setRetroContentId(id);
          setCrewProfileTab(undefined);
          setCrewWorkbenchRunId(null);
          setCrewWorkbenchIdx(9);
        }}
      />

      <EmployeeWorkbench
        open={crewWorkbenchIdx !== null}
        domain="content"
        idx={crewWorkbenchIdx}
        initialRunId={crewWorkbenchRunId}
        initialProfileTab={crewProfileTab}
        onSkillsChanged={loadCrew}
        initialMediaJobId={crewWorkbenchIdx === 10 ? crewMediaJobId : null}
        initialSalesVideoBrief={crewWorkbenchIdx === 10 ? salesVideoPreset : null}
        initialXhsNoteBrief={crewWorkbenchIdx === 11 ? xhsNotePreset : null}
        onSpecialistTaskSubmitted={() => void loadCrew()}
        initialRetroContentId={crewWorkbenchIdx === 9 ? retroContentId : null}
        initialDirective={
          crewWorkbenchIdx === 9 && retroContentId
            ? '依据这篇内容的发布回填数据复盘，并提出有证据支持的下一稿改法。'
            : null
        }
        identityHint={(() => {
          const station = contentCrew.find(item => item.employeeIdx === crewWorkbenchIdx);
          return station
            ? {
                idx: station.employeeIdx ?? station.order,
                name: station.name,
                person: station.person,
                group: station.group,
                emoji: station.emoji,
                color: station.color,
                duty: station.duty,
                intro: station.intro,
              }
            : null;
        })()}
        onClose={() => {
          setCrewWorkbenchIdx(null);
          setCrewProfileTab(undefined);
          setCrewWorkbenchRunId(null);
          void loadCrew();
          setCrewMediaJobId(null);
          setSalesVideoPreset(null);
          setXhsNotePreset(null);
          setRetroContentId(null);
        }}
      />

      <details className="content-auxiliary">
        <summary>团队协作与资料</summary>
        <div className="content-auxiliary-actions">
          <Button
            icon={<TeamOutlined />}
            onClick={() => {
              setPipelineFocusId(null);
              setPipelineOpen(true);
            }}
          >
            完整团队流水线
          </Button>
          <Button icon={<FolderOpenOutlined />} onClick={() => setResourceTab('素材库')}>
            素材与模板
          </Button>
          {canViewCrewInternals && <Button onClick={() => setAutomationOpen(true)}>定时规则</Button>}
        </div>
      </details>
      {pipelineOpen && (
        <ContentPipelineWorkbench
          open={pipelineOpen}
          crew={contentCrew}
          initialPipelineId={pipelineFocusId}
          onClose={() => setPipelineOpen(false)}
        />
      )}
      <Suspense fallback={<Spin />}>
        {resourceTab && <ContentResourceLibrary initialTab={resourceTab} onClose={() => setResourceTab(null)} />}
        {automationOpen && canViewCrewInternals && (
          <ContentAutomationManager crew={contentCrew} onClose={() => setAutomationOpen(false)} />
        )}
      </Suspense>
    </div>
  );
}
