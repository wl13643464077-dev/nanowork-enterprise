import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Alert, Button, Drawer, Empty, Form, Input, List, message, Select, Skeleton, Tag,
} from 'antd';
import {
  CalendarOutlined, CameraOutlined, EyeOutlined, FireOutlined, PlayCircleOutlined, RadarChartOutlined,
  RocketOutlined, SoundOutlined, ThunderboltOutlined, ToolOutlined,
} from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { Markdown } from '../components/Markdown';

type ToolDefinition = {
  key: string;
  title: string;
  short: string;
  description: string;
  icon: ReactNode;
  accent: string;
  employee: string;
  employeeIdx: number;
  cost: string;
  inputs: string[];
  output: string;
};

type ToolRun = {
  id: number;
  toolKey: string;
  toolTitle?: string;
  title: string;
  status: string;
  employeeIdx?: number;
  employeeName?: string;
  inputSummary?: string;
  resultMd?: string;
  assumptions?: string[];
  evidence?: { label?: string; source?: string; url?: string }[];
  provenance?: { mode?: string; sourceSystem?: string; promptVersion?: string; generatedAt?: string; confidence?: string };
  createdAt?: string;
  updatedAt?: string;
};

const TOOLS: ToolDefinition[] = [
  { key: 'hot', title: '今日必发', short: '今天发什么', description: '根据门店品类、客群和今天的经营重点，给出 3 个可立即发布的内容选题与承接动作。', icon: <FireOutlined />, accent: '#ef6d43', employee: '云营销', employeeIdx: 141, cost: '免费 · 模板整理', inputs: ['门店品类', '发布渠道', '今天主推'], output: '3个选题 + 文案角度 + 到店承接动作' },
  { key: 'remix', title: '视频混剪', short: '手机素材成片', description: '把门店手机视频整理为一条有开头、有卖点、有行动指令的竖屏短视频方案。', icon: <PlayCircleOutlined />, accent: '#4f77dd', employee: '章文案', employeeIdx: 140, cost: '免费 · 模板整理', inputs: ['素材说明', '目标平台', '成片目的'], output: '分镜 + 口播 + 字幕 + 配乐与剪辑指令' },
  { key: 'pcal', title: '私域日历', short: '整月不愁发', description: '按月编排朋友圈与社群内容，让促销、口碑、会员维护和老板人设形成节奏。', icon: <CalendarOutlined />, accent: '#258f78', employee: '云营销', employeeIdx: 141, cost: '免费 · 模板整理', inputs: ['月份', '经营重点', '渠道'], output: '月度日历 + 每日主题 + 推荐发布时间' },
  { key: 'bench', title: '竞品盯梢', short: '看懂对手动作', description: '记录最多 8 个对标门店，整理价格、产品、口碑和活动变化，标出可行动的空白。', icon: <EyeOutlined />, accent: '#755db9', employee: '钱商圈', employeeIdx: 102, cost: '免费 · 模板整理', inputs: ['对标门店', '观察周期', '关注主题'], output: '变化清单 + 机会空白 + 不建议跟随项' },
  { key: 'warm', title: '起号军师', short: '30天冷启动', description: '把门店定位、老板人设和平台机制转成 30 天账号冷启动路线，而不是堆选题。', icon: <RocketOutlined />, accent: '#d98b2b', employee: '苏种草', employeeIdx: 142, cost: '免费 · 模板整理', inputs: ['平台', '门店定位', '老板人设'], output: '30天节奏 + 内容支柱 + 每周验收指标' },
  { key: 'leads', title: '线索雷达', short: '发现本地需求', description: '从求推荐、吐槽、攻略和比价等公开信号中，整理值得人工核验的本地需求与承接话术。', icon: <RadarChartOutlined />, accent: '#cb4e72', employee: '潘口碑', employeeIdx: 143, cost: '免费 · 模板整理', inputs: ['城市/商圈', '产品', '目标客群'], output: '信号清单 + 核验提示 + 评论/私信承接话术' },
  { key: 'shot', title: '产品图文', short: '一份产品多端用', description: '围绕一道菜或一款套餐，形成外卖、小红书、朋友圈和到店物料共用的卖点系统。', icon: <CameraOutlined />, accent: '#2784c7', employee: '章文案', employeeIdx: 140, cost: '免费 · 模板整理', inputs: ['产品信息', '真实卖点', '使用渠道'], output: '卖点结构 + 多平台文案 + 拍摄与海报指引' },
  { key: 'vars', title: '口播矩阵', short: '一稿裂变多版', description: '把一条老板口播改成不同开头、节奏和行动指令，保持事实一致但不机械换词。', icon: <SoundOutlined />, accent: '#247b9b', employee: '章文案', employeeIdx: 140, cost: '免费 · 模板整理', inputs: ['原始口播', '裂变数量', '目标平台'], output: '2-6版口播 + 镜头建议 + 风险检查' },
];

const toolByKey = (key: string | null) => TOOLS.find(tool => tool.key === key) || TOOLS[0];

export default function Toolbox() {
  const [params, setParams] = useSearchParams();
  const [activeKey, setActiveKey] = useState(() => toolByKey(params.get('tool')).key);
  const [runs, setRuns] = useState<ToolRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [running, setRunning] = useState(false);
  const [viewRun, setViewRun] = useState<ToolRun | null>(null);
  const [form] = Form.useForm();
  const active = useMemo(() => toolByKey(activeKey), [activeKey]);
  const requestedTool = params.get('tool');

  const loadRuns = useCallback(() => {
    setLoadingRuns(true);
    api.get('/toolbox/runs?limit=20')
      .then((data: any) => setRuns(Array.isArray(data) ? data : data.runs || []))
      .catch(() => setRuns([]))
      .finally(() => setLoadingRuns(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadRuns();
    });
    return () => { cancelled = true; };
  }, [loadRuns]);

  useEffect(() => {
    const nextKey = toolByKey(requestedTool).key;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setActiveKey(current => current === nextKey ? current : nextKey);
    });
    return () => { cancelled = true; };
  }, [requestedTool]);

  useEffect(() => {
    form.resetFields();
    form.setFieldsValue({ channels: ['朋友圈'], platform: '视频号', variants: 3 });
  }, [activeKey, form]);

  const chooseTool = (key: string) => {
    setActiveKey(key);
    const next = new URLSearchParams(params);
    next.set('tool', key);
    setParams(next, { replace: true });
  };

  const runTool = async () => {
    const values = await form.validateFields();
    setRunning(true);
    try {
      const response = await api.post('/toolbox/runs', {
        toolKey: active.key,
        employeeIdx: active.employeeIdx,
        title: values.title || `${active.title} · ${new Date().toLocaleDateString('zh-CN')}`,
        inputs: values,
      });
      const run = response.run || response;
      setRuns(current => [run, ...current.filter(item => item.id !== run.id)]);
      setViewRun(run);
      message.success(response.message || `${active.title}已完成，结果已保存到工具运行记录`);
    } finally {
      setRunning(false);
    }
  };

  const fields = (() => {
    if (active.key === 'hot') return <>
      <Form.Item name="store" label="门店 / 品类" rules={[{ required: true, message: '请填写门店或品类' }]}><Input placeholder="例：某商圈川味小馆" /></Form.Item>
      <Form.Item name="channels" label="发布渠道" rules={[{ required: true }]}><Select mode="multiple" options={['朋友圈', '小红书', '抖音', '视频号', '社群'].map(value => ({ value, label: value }))} /></Form.Item>
      <Form.Item name="focus" label="今天最想推动什么" rules={[{ required: true, message: '请说明今天的经营重点' }]}><Input.TextArea rows={4} placeholder="例：晚市工作日上座不足，想推两人套餐，但不能做虚假限量" /></Form.Item>
    </>;
    if (active.key === 'remix') return <>
      <Form.Item name="materials" label="手机素材说明" rules={[{ required: true, message: '请说明现有素材' }]}><Input.TextArea rows={4} placeholder="例：后厨出锅3段、顾客夹菜2段、门头夜景1段；每段约5秒" /></Form.Item>
      <Form.Item name="platform" label="目标平台"><Select options={['抖音', '视频号', '小红书', '快手'].map(value => ({ value, label: value }))} /></Form.Item>
      <Form.Item name="goal" label="成片目的" rules={[{ required: true }]}><Input placeholder="例：让附近3公里顾客周末来吃招牌菜" /></Form.Item>
    </>;
    if (active.key === 'pcal') return <>
      <Form.Item name="month" label="计划月份" rules={[{ required: true }]}><Input placeholder="例：2026-08" /></Form.Item>
      <Form.Item name="channels" label="经营渠道"><Select mode="multiple" options={['朋友圈', '社群', '视频号', '小红书'].map(value => ({ value, label: value }))} /></Form.Item>
      <Form.Item name="focus" label="本月经营重点" rules={[{ required: true }]}><Input.TextArea rows={4} placeholder="例：新菜单上线、老会员回店、工作日午市提升" /></Form.Item>
    </>;
    if (active.key === 'bench') return <>
      <Form.Item name="targets" label="对标门店（每行一个）" rules={[{ required: true }]}><Input.TextArea rows={5} placeholder={'门店A / 账号链接\n门店B / 地址\n最多8个'} /></Form.Item>
      <Form.Item name="period" label="观察周期"><Select options={['近7天', '近30天', '本季度'].map(value => ({ value, label: value }))} /></Form.Item>
      <Form.Item name="focus" label="最关心什么"><Input placeholder="例：套餐价格、差评变化、夜宵活动" /></Form.Item>
    </>;
    if (active.key === 'warm') return <>
      <Form.Item name="platform" label="主阵地平台"><Select options={['视频号', '抖音', '小红书', '快手'].map(value => ({ value, label: value }))} /></Form.Item>
      <Form.Item name="positioning" label="门店定位" rules={[{ required: true }]}><Input placeholder="例：社区型云南米线，客单28元，午餐为主" /></Form.Item>
      <Form.Item name="persona" label="老板人设"><Input placeholder="例：认真研究汤底的80后店主，说话朴实" /></Form.Item>
      <Form.Item name="goal" label="30天目标"><Input placeholder="例：验证3个稳定选题方向，带来20个到店核销" /></Form.Item>
    </>;
    if (active.key === 'leads') return <>
      <Form.Item name="city" label="城市 / 商圈" rules={[{ required: true }]}><Input placeholder="例：门店周边3公里" /></Form.Item>
      <Form.Item name="product" label="门店产品" rules={[{ required: true }]}><Input placeholder="例：粤菜家庭聚餐、客单120元" /></Form.Item>
      <Form.Item name="audience" label="目标客群"><Input placeholder="例：周末家庭聚餐、公司小型宴请" /></Form.Item>
      <Form.Item name="constraints" label="核验与合规约束"><Input.TextArea rows={3} placeholder="只使用公开信号；不抓取个人联系方式；最终由人工核验" /></Form.Item>
    </>;
    if (active.key === 'shot') return <>
      <Form.Item name="product" label="产品 / 套餐" rules={[{ required: true }]}><Input placeholder="例：双人酸汤鱼套餐 168元" /></Form.Item>
      <Form.Item name="facts" label="可核验的真实卖点" rules={[{ required: true }]}><Input.TextArea rows={4} placeholder="食材、份量、工艺、适合场景；不要写未经证实的第一、最好、零添加" /></Form.Item>
      <Form.Item name="channels" label="使用渠道"><Select mode="multiple" options={['外卖平台', '朋友圈', '小红书', '门店桌卡'].map(value => ({ value, label: value }))} /></Form.Item>
    </>;
    return <>
      <Form.Item name="script" label="原始口播" rules={[{ required: true, min: 20, message: '请粘贴至少20个字的原稿' }]}><Input.TextArea rows={7} placeholder="粘贴老板原话，系统只在事实不变的前提下改开头、节奏与行动指令" /></Form.Item>
      <Form.Item name="variants" label="裂变数量"><Select options={[2, 3, 4, 5, 6].map(value => ({ value, label: `${value} 版` }))} /></Form.Item>
      <Form.Item name="platform" label="目标平台"><Select options={['视频号', '抖音', '小红书', '快手'].map(value => ({ value, label: value }))} /></Form.Item>
    </>;
  })();

  return (
    <div className="toolbox-page">
      <style>{STYLES}</style>
      <header className="toolbox-hero">
        <div>
          <div className="toolbox-kicker"><ToolOutlined /> 经营工具箱</div>
          <h1>老板常用的活，不必每次从空白开始</h1>
          <p>8 个高频模板助手，把老板的输入整理成可执行的结构化草案；全部免费，不消耗积分。真 AI 生成能力将在后续版本接入。</p>
        </div>
        <div className="toolbox-flow" aria-label="工具闭环">
          <span>经营问题</span><b>→</b><span>选择工具</span><b>→</b><span>员工执行</span><b>→</b><span>结果回流</span>
        </div>
      </header>

      <div className="toolbox-layout">
        <nav className="toolbox-nav" aria-label="工具列表">
          <div className="toolbox-nav-title">全部工具 <span>{TOOLS.length}</span></div>
          {TOOLS.map(tool => (
            <button key={tool.key} className={active.key === tool.key ? 'active' : ''} onClick={() => chooseTool(tool.key)}>
              <i style={{ '--tool-color': tool.accent } as CSSProperties}>{tool.icon}</i>
              <span><strong>{tool.title}</strong><small>{tool.short}</small></span>
              <em>›</em>
            </button>
          ))}
        </nav>

        <main className="toolbox-workbench">
          <div className="toolbox-active-head">
            <div className="toolbox-active-icon" style={{ '--tool-color': active.accent } as CSSProperties}>{active.icon}</div>
            <div><div className="toolbox-active-kicker">{active.short}</div><h2>{active.title}</h2><p>{active.description}</p></div>
          </div>
          <div className="toolbox-contract">
            <div><span>执行员工</span><strong>{active.employee}</strong><small>餐饮数字员工 #{active.employeeIdx}</small></div>
            <div><span>你需要准备</span><strong>{active.inputs.join(' · ')}</strong><small>缺失信息会在结果中标记为假设</small></div>
            <div><span>最终交付</span><strong>{active.output}</strong><small>自动保存到工具运行记录</small></div>
          </div>
          <Form form={form} layout="vertical" requiredMark={false} className="toolbox-form">
            {fields}
            <Alert type="warning" showIcon message="工具结果是经营建议，不会自动发布、改价、采购、排班或处罚员工；关键动作需要老板确认。" />
            <div className="toolbox-submit-row">
              <span>{active.cost} · 基于你的输入做结构化整理，当前不调用外部 AI 模型</span>
              <Button type="primary" size="large" icon={<ThunderboltOutlined />} loading={running} onClick={runTool}>开始运行</Button>
            </div>
          </Form>
        </main>

        <aside className="toolbox-runs">
          <div className="toolbox-runs-head"><div><strong>最近运行</strong><span>关页不丢，结果可回看</span></div><Button type="link" size="small" onClick={loadRuns}>刷新</Button></div>
          {loadingRuns ? <Skeleton active paragraph={{ rows: 8 }} /> : runs.length ? (
            <List dataSource={runs} renderItem={run => {
              const tool = toolByKey(run.toolKey);
              return <List.Item onClick={() => setViewRun(run)}>
                <div className="tool-run-icon" style={{ '--tool-color': tool.accent } as CSSProperties}>{tool.icon}</div>
                <div className="tool-run-main"><strong>{run.title || tool.title}</strong><span>{run.employeeName || tool.employee} · {String(run.createdAt || '').replace('T', ' ').slice(0, 16)}</span></div>
                <Tag color={run.status === 'done' || run.status === '已完成' ? 'green' : run.status === 'failed' ? 'red' : 'processing'}>
                  {run.status === 'done' ? '已完成' : run.status || '执行中'}
                </Tag>
              </List.Item>;
            }} />
          ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有运行记录" />}
        </aside>
      </div>

      <Drawer width={720} open={!!viewRun} onClose={() => setViewRun(null)}
        title={viewRun ? <div className="tool-result-title"><span>{toolByKey(viewRun.toolKey).icon}</span><div><strong>{viewRun.title}</strong><small>{viewRun.employeeName || toolByKey(viewRun.toolKey).employee} · 运行 #{viewRun.id}</small></div></div> : null}>
        {viewRun && <div className="tool-result">
          <div className="tool-result-provenance">
            <div><span>执行模式</span><strong>{viewRun.provenance?.mode || '本地模板'}</strong></div>
            <div><span>提示词快照</span><strong>{viewRun.provenance?.promptVersion ? '已保存' : '系统默认'}</strong></div>
            <div><span>置信度</span><strong>{viewRun.provenance?.confidence || '待老板核验'}</strong></div>
            <div><span>生成时间</span><strong>{String(viewRun.provenance?.generatedAt || viewRun.updatedAt || viewRun.createdAt || '').replace('T', ' ').slice(0, 16) || '-'}</strong></div>
          </div>
          {viewRun.inputSummary && <Alert type="info" showIcon message="本次输入摘要" description={viewRun.inputSummary} />}
          {!!viewRun.assumptions?.length && <section><h3>假设与数据缺口</h3><ul>{viewRun.assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
          <section><h3>工具交付</h3><div className="tool-result-body"><Markdown content={viewRun.resultMd || '结果正在生成，请稍后刷新。'} /></div></section>
          <section><h3>来源与证据</h3>{viewRun.evidence?.length ? <List size="small" dataSource={viewRun.evidence} renderItem={item => <List.Item><span>{item.label || item.source}</span>{item.url ? <a href={item.url} target="_blank" rel="noreferrer">查看来源</a> : <Tag>内部输入</Tag>}</List.Item>} /> : <Alert type="warning" showIcon message="本次没有联网来源，只能作为待核验的执行草案。" />}</section>
        </div>}
      </Drawer>
    </div>
  );
}

const STYLES = `
.toolbox-page{display:flex;flex-direction:column;gap:15px;color:var(--ui-text)}.toolbox-hero{display:flex;align-items:end;justify-content:space-between;gap:28px;padding:26px 30px;border:1px solid var(--ui-border);border-radius:17px;background:radial-gradient(circle at 82% 14%,rgba(44,118,220,.14),transparent 32%),var(--ui-surface);box-shadow:0 12px 30px rgba(20,53,90,.05)}.toolbox-kicker{display:flex;align-items:center;gap:7px;color:var(--ui-primary);font-size:11px;font-weight:650;letter-spacing:1.2px}.toolbox-hero h1{margin:12px 0 7px;font-size:29px;line-height:1.2;letter-spacing:-1.1px}.toolbox-hero p{max-width:740px;margin:0;color:var(--ui-text-2);font-size:12.5px;line-height:1.8}.toolbox-flow{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:10px 13px;border:1px solid var(--ui-border);border-radius:10px;background:var(--ui-surface-2);color:var(--ui-text-2);font-size:10px}.toolbox-flow b{color:var(--ui-primary);font-weight:500}
.toolbox-layout{display:grid;grid-template-columns:190px minmax(480px,1fr) 300px;gap:13px;min-height:620px}.toolbox-nav,.toolbox-workbench,.toolbox-runs{border:1px solid var(--ui-border);border-radius:14px;background:var(--ui-surface);box-shadow:0 9px 24px rgba(20,53,90,.04)}.toolbox-nav{padding:10px}.toolbox-nav-title{display:flex;justify-content:space-between;padding:8px 8px 11px;color:var(--ui-muted);font-size:10px;letter-spacing:1px}.toolbox-nav-title span{font:600 10px ui-monospace,SFMono-Regular,Menlo,monospace}.toolbox-nav button{width:100%;display:flex;align-items:center;gap:9px;margin-bottom:3px;padding:10px 8px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--ui-text-2);cursor:pointer;text-align:left;transition:background .18s,border-color .18s,transform .18s}.toolbox-nav button:hover{transform:translateX(2px);background:var(--ui-surface-2)}.toolbox-nav button.active{border-color:color-mix(in srgb,var(--ui-primary) 18%,transparent);background:var(--ui-primary-soft);color:var(--ui-primary)}.toolbox-nav button i{width:30px;height:30px;display:grid;place-items:center;flex:0 0 auto;border-radius:8px;background:color-mix(in srgb,var(--tool-color) 13%,transparent);color:var(--tool-color);font-style:normal}.toolbox-nav button>span{min-width:0;flex:1}.toolbox-nav strong,.toolbox-nav small{display:block}.toolbox-nav strong{font-size:11.5px}.toolbox-nav small{margin-top:2px;color:var(--ui-muted);font-size:9.5px;font-weight:400}.toolbox-nav em{color:var(--ui-muted);font-style:normal}
.toolbox-workbench{padding:23px 26px}.toolbox-active-head{display:flex;align-items:flex-start;gap:14px}.toolbox-active-icon{width:48px;height:48px;display:grid;place-items:center;flex:0 0 auto;border-radius:13px;background:color-mix(in srgb,var(--tool-color) 13%,var(--ui-surface));border:1px solid color-mix(in srgb,var(--tool-color) 22%,transparent);color:var(--tool-color);font-size:21px}.toolbox-active-kicker{color:var(--ui-primary);font-size:10px;letter-spacing:.8px}.toolbox-active-head h2{margin:3px 0 4px;font-size:21px}.toolbox-active-head p{max-width:700px;margin:0;color:var(--ui-text-2);font-size:11.5px;line-height:1.7}.toolbox-contract{display:grid;grid-template-columns:.75fr 1.2fr 1.2fr;gap:1px;overflow:hidden;margin:20px 0;border:1px solid var(--ui-border);border-radius:11px;background:var(--ui-border)}.toolbox-contract>div{padding:12px 13px;background:var(--ui-surface-2)}.toolbox-contract span,.toolbox-contract strong,.toolbox-contract small{display:block}.toolbox-contract span{color:var(--ui-muted);font-size:9.5px}.toolbox-contract strong{margin-top:4px;color:var(--ui-text);font-size:11.5px;line-height:1.5}.toolbox-contract small{margin-top:3px;color:var(--ui-muted);font-size:9px;line-height:1.4}.toolbox-form{max-width:760px}.toolbox-form .ant-form-item{margin-bottom:16px}.toolbox-form .ant-form-item-label>label{font-size:11.5px;font-weight:600}.toolbox-submit-row{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:19px}.toolbox-submit-row>span{color:var(--ui-muted);font-size:10px}.toolbox-submit-row .ant-btn{min-width:132px;border-radius:9px;background:linear-gradient(135deg,#2c76dc,#0751a3);box-shadow:0 9px 20px rgba(23,105,210,.18)}
.toolbox-runs{overflow:hidden}.toolbox-runs-head{display:flex;align-items:center;justify-content:space-between;padding:15px 15px 11px;border-bottom:1px solid var(--ui-border)}.toolbox-runs-head strong,.toolbox-runs-head span{display:block}.toolbox-runs-head strong{font-size:12.5px}.toolbox-runs-head span{margin-top:2px;color:var(--ui-muted);font-size:9.5px}.toolbox-runs .ant-list-item{display:flex;gap:8px;padding:11px 12px!important;cursor:pointer;transition:background .18s}.toolbox-runs .ant-list-item:hover{background:var(--ui-surface-2)}.tool-run-icon{width:30px;height:30px;display:grid;place-items:center;flex:0 0 auto;border-radius:8px;background:color-mix(in srgb,var(--tool-color) 13%,transparent);color:var(--tool-color)}.tool-run-main{min-width:0;flex:1}.tool-run-main strong,.tool-run-main span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tool-run-main strong{color:var(--ui-text);font-size:10.5px}.tool-run-main span{margin-top:3px;color:var(--ui-muted);font-size:8.8px}.toolbox-runs .ant-tag{align-self:center;margin:0;font-size:8.5px}
.tool-result-title{display:flex;align-items:center;gap:9px}.tool-result-title>span{width:36px;height:36px;display:grid;place-items:center;border-radius:9px;background:var(--ui-primary-soft);color:var(--ui-primary)}.tool-result-title strong,.tool-result-title small{display:block}.tool-result-title strong{font-size:14px}.tool-result-title small{margin-top:2px;color:var(--ui-muted);font-size:10px;font-weight:400}.tool-result{display:flex;flex-direction:column;gap:18px}.tool-result-provenance{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;overflow:hidden;border:1px solid var(--ui-border);border-radius:10px;background:var(--ui-border)}.tool-result-provenance>div{padding:10px;background:var(--ui-surface-2)}.tool-result-provenance span,.tool-result-provenance strong{display:block}.tool-result-provenance span{color:var(--ui-muted);font-size:9px}.tool-result-provenance strong{margin-top:4px;color:var(--ui-text);font-size:10.5px}.tool-result section h3{margin:0 0 9px;font-size:13px}.tool-result section ul{margin:0;padding-left:20px;color:var(--ui-text-2);font-size:11.5px;line-height:1.8}.tool-result-body{padding:16px;border:1px solid var(--ui-border);border-radius:11px;background:var(--ui-surface-2);font-size:12px;line-height:1.8}
@media(max-width:1380px){.toolbox-layout{grid-template-columns:180px minmax(460px,1fr)}.toolbox-runs{grid-column:1/-1}.toolbox-runs .ant-list-items{display:grid;grid-template-columns:repeat(3,1fr)}}@media(max-width:900px){.toolbox-hero{align-items:flex-start;flex-direction:column}.toolbox-flow{display:none}.toolbox-layout{grid-template-columns:1fr}.toolbox-nav{display:flex;gap:6px;overflow-x:auto}.toolbox-nav-title{display:none}.toolbox-nav button{width:150px;flex:0 0 auto}.toolbox-runs{grid-column:auto}.toolbox-runs .ant-list-items{grid-template-columns:repeat(2,1fr)}}@media(max-width:620px){.toolbox-hero{padding:21px 18px}.toolbox-hero h1{font-size:24px}.toolbox-workbench{padding:18px 15px}.toolbox-contract{grid-template-columns:1fr}.toolbox-submit-row{align-items:stretch;flex-direction:column}.toolbox-submit-row .ant-btn{width:100%}.toolbox-runs .ant-list-items{grid-template-columns:1fr}.tool-result-provenance{grid-template-columns:repeat(2,1fr)}}
`;
