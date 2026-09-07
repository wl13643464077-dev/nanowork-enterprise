import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Spin,
  Switch,
  message,
} from 'antd';
import { api } from '../api/client';
import type { ContentCrewStation } from './contentCrewConfig';
const WEEKDAY_LABELS = ['-', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
type ContentAutomationRule = {
  id: number;
  name: string;
  enabled: boolean;
  employeeIdx: number;
  employee?: { contentEmployeeName?: string; contentEmployeeGroup?: string };
  topic: string;
  requirement: string;
  contentType: string;
  contentCount: number;
  frequency: 'daily' | 'weekly';
  runTime: string;
  weekday: number | null;
  approvalMode: 'auto' | 'risk' | 'always';
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastContentId: number | null;
  allowedTaskTypes?: string[];
  taskTypeValid?: boolean;
};

export default function ContentAutomationManager({
  crew: contentCrew,
  onClose,
}: {
  crew: ContentCrewStation[];
  onClose: () => void;
}) {
  const [automationRules, setAutomationRules] = useState<ContentAutomationRule[]>([]);
  const [automationLoading, setAutomationLoading] = useState(true);
  const [error, setError] = useState('');
  const [automationOpen, setAutomationOpen] = useState(false);
  const [editingAutomation, setEditingAutomation] = useState<ContentAutomationRule | null>(null);
  const [automationSaving, setAutomationSaving] = useState(false);
  const [automationRunningId, setAutomationRunningId] = useState<number | null>(null);
  const [automationForm] = Form.useForm();
  const automationFrequency = Form.useWatch('frequency', automationForm);
  const automationEmployeeIdx = Form.useWatch('employeeIdx', automationForm);
  const automationStation = contentCrew.find(station => station.employeeIdx === Number(automationEmployeeIdx));
  const automationTaskTypes = automationStation?.taskTypes?.length
    ? automationStation.taskTypes
    : editingAutomation?.employeeIdx === Number(automationEmployeeIdx)
      ? editingAutomation.allowedTaskTypes || []
      : [];
  const loadAutomations = useCallback(async () => {
    setAutomationLoading(true);
    setError('');
    try {
      const data = await api.get('/content/automations', { silent: true });
      setAutomationRules(data?.rules || []);
    } catch (error) {
      setError(error instanceof Error ? error.message : '定时规则加载失败');
    } finally {
      setAutomationLoading(false);
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadAutomations();
    });
    return () => {
      cancelled = true;
    };
  }, [loadAutomations]);
  const openAutomationEditor = (rule?: ContentAutomationRule) => {
    const target = rule || null;
    setEditingAutomation(target);
    automationForm.setFieldsValue(
      target
        ? {
            name: target.name,
            enabled: target.enabled,
            employeeIdx: target.employeeIdx,
            topic: target.topic,
            requirement: target.requirement,
            contentType: target.contentType,
            contentCount: target.contentCount,
            frequency: target.frequency,
            runTime: target.runTime,
            weekday: target.weekday,
            approvalMode: target.approvalMode,
          }
        : {
            name: '每日门店内容',
            enabled: true,
            employeeIdx: 3,
            topic: '',
            requirement: '仅使用门店已确认信息，未知价格、库存、活动权益与成效必须标记待确认。',
            contentType: '文案初稿',
            contentCount: 3,
            frequency: 'daily',
            runTime: '09:00',
            weekday: null,
            approvalMode: 'auto',
          },
    );
    setAutomationOpen(true);
  };

  const saveAutomation = () => {
    automationForm.validateFields().then(values => {
      const payload = {
        ...values,
        weekday: values.frequency === 'weekly' ? values.weekday : null,
      };
      setAutomationSaving(true);
      const request = editingAutomation
        ? api.put(`/content/automations/${editingAutomation.id}`, payload)
        : api.post('/content/automations', payload);
      request
        .then(() => {
          message.success(editingAutomation ? '定时规则已更新' : '内容自动化规则已创建');
          setAutomationOpen(false);
          setEditingAutomation(null);
          loadAutomations();
        })
        .finally(() => setAutomationSaving(false));
    });
  };

  const toggleAutomation = (rule: ContentAutomationRule, enabled: boolean) => {
    api.post(`/content/automations/${rule.id}/toggle`, { enabled }).then(() => {
      message.success(enabled ? '定时任务已启用' : '定时任务已停用，不会继续自动运行');
      loadAutomations();
    });
  };

  const runAutomationNow = async (rule: ContentAutomationRule) => {
    if (automationRunningId !== null) return;
    setAutomationRunningId(rule.id);
    try {
      const accepted = await api.post(`/content/automations/${rule.id}/run`, { idempotencyKey: crypto.randomUUID() });
      if (!Number.isSafeInteger(accepted.runId) || accepted.runId < 1) throw new Error('未返回有效运行编号');
      message.success('任务已提交，请到任务中心查看进度和结果');
      void loadAutomations();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '任务提交失败');
    } finally {
      setAutomationRunningId(null);
    }
  };
  const deleteAutomation = async (rule: ContentAutomationRule) => {
    await api.del(`/content/automations/${rule.id}`);
    message.success('规则已删除，已生成内容保留');
    void loadAutomations();
  };
  return (
    <>
      <Drawer title="定时规则" open onClose={onClose} width="min(760px, 100vw)">
        <Space style={{ marginBottom: 16 }} wrap>
          <Button type="primary" onClick={() => openAutomationEditor()}>
            新建规则
          </Button>
          <Button href="/tasks">查看全部任务</Button>
        </Space>
        <p>管理员工的定时安排。运行历史与结果统一在任务中心查看，系统不会自动发布。</p>
        {error ? (
          <Alert
            type="error"
            showIcon
            message={error}
            action={<Button onClick={() => void loadAutomations()}>重新加载</Button>}
          />
        ) : (
          <Spin spinning={automationLoading}>
            {!automationLoading && !automationRules.length && <Empty description="暂无定时规则" />}
            <Space direction="vertical" style={{ width: '100%' }}>
              {automationRules.map(rule => (
                <Card key={rule.id} size="small" title={rule.name}>
                  <p>
                    {rule.employee?.contentEmployeeName || `员工 #${rule.employeeIdx}`} · {rule.contentType} ·{' '}
                    {rule.frequency === 'daily' ? '每天' : WEEKDAY_LABELS[rule.weekday || 0]} {rule.runTime}（上海时区）
                  </p>
                  {rule.taskTypeValid === false && (
                    <Alert type="warning" message="任务类型与当前岗位不匹配，请编辑后启用。" />
                  )}
                  <Space wrap>
                    <Switch
                      checked={rule.enabled}
                      checkedChildren="启用"
                      unCheckedChildren="停用"
                      disabled={rule.taskTypeValid === false && !rule.enabled}
                      onChange={enabled => toggleAutomation(rule, enabled)}
                    />
                    <Button onClick={() => openAutomationEditor(rule)}>编辑</Button>
                    <Button
                      loading={automationRunningId === rule.id}
                      disabled={rule.taskTypeValid === false || automationRunningId !== null}
                      onClick={() => void runAutomationNow(rule)}
                    >
                      立即运行一次
                    </Button>
                    <Popconfirm
                      title="删除这条定时规则？"
                      description="规则及运行日志会删除，已生成内容会保留。"
                      onConfirm={() => deleteAutomation(rule)}
                    >
                      <Button danger>删除规则</Button>
                    </Popconfirm>
                  </Space>
                </Card>
              ))}
            </Space>
          </Spin>
        )}
      </Drawer>
      <Modal
        open={automationOpen}
        width={720}
        forceRender
        title={editingAutomation ? `编辑自动规则 · ${editingAutomation.name}` : '新建内容自动化规则'}
        okText={editingAutomation ? '保存规则' : '创建规则'}
        confirmLoading={automationSaving}
        onCancel={() => {
          setAutomationOpen(false);
          setEditingAutomation(null);
        }}
        onOk={saveAutomation}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message="自动生产不等于自动发布"
          description="新规则默认 auto：none / low / medium / high 普通内部结果通过质量和账务门后自动采用。risk / always 作为旧规则兼容选项保留。系统不会自动外发、操作账号、真实付费或执行不可逆动作。"
        />
        {editingAutomation?.taskTypeValid === false && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 14 }}
            message="这条旧规则的任务类型与当前员工岗位不匹配"
            description={`当前“${editingAutomation.contentType}”不能由 #${editingAutomation.employeeIdx} 执行；请选择下方岗位原生任务类型后再保存或启用。`}
          />
        )}
        <Form form={automationForm} layout="vertical">
          <Row gutter={12}>
            <Col xs={24} md={16}>
              <Form.Item
                name="name"
                label="规则名称"
                rules={[{ required: true, message: '请输入规则名称' }, { max: 60 }]}
              >
                <Input maxLength={60} placeholder="如：每天上午招牌菜朋友圈" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="enabled" label="定时状态" valuePropName="checked">
                <Switch checkedChildren="启用" unCheckedChildren="停用" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col xs={24} md={12}>
              <Form.Item
                name="employeeIdx"
                label="执行内容员工"
                rules={[{ required: true, message: '请选择内容员工' }]}
              >
                <Select
                  showSearch
                  optionFilterProp="label"
                  onChange={(value: number) => {
                    const station = contentCrew.find(item => (item.employeeIdx ?? item.order) === value);
                    const taskTypes = station?.taskTypes || [];
                    const current = automationForm.getFieldValue('contentType');
                    if (!taskTypes.includes(current)) {
                      automationForm.setFieldValue('contentType', taskTypes[0]);
                    }
                  }}
                  options={contentCrew.map(station => ({
                    value: station.employeeIdx ?? station.order,
                    label: `#${station.employeeIdx ?? station.order} · ${station.name} · ${station.group}`,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                name="contentType"
                label="岗位任务类型"
                extra={
                  automationStation
                    ? `只显示${automationStation.name}可完整执行的任务，不会跨岗套用通用文案类型。`
                    : '先选择执行员工。'
                }
                rules={[{ required: true, message: '请选择岗位任务类型' }]}
              >
                <Select
                  disabled={!automationTaskTypes.length}
                  options={automationTaskTypes.map(type => ({ value: type, label: type }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={4}>
              <Form.Item name="contentCount" label="交付份数" rules={[{ required: true, message: '请输入交付份数' }]}>
                <InputNumber min={1} max={10} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            name="topic"
            label="内容主题"
            rules={[{ required: true, message: '请输入内容主题' }, { max: 100 }]}
          >
            <Input maxLength={100} placeholder="如：夏季招牌菜、午市套餐或会员日" />
          </Form.Item>
          <Form.Item name="requirement" label="内容要求" rules={[{ max: 2000, message: '内容要求不能超过2000字' }]}>
            <Input.TextArea
              rows={3}
              maxLength={2000}
              showCount
              placeholder="只填写门店已经确认的事实；未知价格、库存、权益和经营效果标记待确认。"
            />
          </Form.Item>
          <Row gutter={12}>
            <Col xs={24} md={6}>
              <Form.Item name="frequency" label="频率" rules={[{ required: true, message: '请选择频率' }]}>
                <Select
                  options={[
                    { value: 'daily', label: '每天' },
                    { value: 'weekly', label: '每周' },
                  ]}
                />
              </Form.Item>
            </Col>
            {automationFrequency === 'weekly' && (
              <Col xs={24} md={6}>
                <Form.Item name="weekday" label="星期" rules={[{ required: true, message: '请选择星期' }]}>
                  <Select
                    options={WEEKDAY_LABELS.slice(1).map((label, index) => ({
                      value: index + 1,
                      label,
                    }))}
                  />
                </Form.Item>
              </Col>
            )}
            <Col xs={24} md={automationFrequency === 'weekly' ? 6 : 9}>
              <Form.Item
                name="runTime"
                label="运行时间（上海时区）"
                rules={[
                  { required: true, message: '请输入运行时间' },
                  { pattern: /^([01]\d|2[0-3]):[0-5]\d$/, message: '使用HH:mm格式，如09:00' },
                ]}
              >
                <Input maxLength={5} placeholder="09:00" />
              </Form.Item>
            </Col>
            <Col xs={24} md={automationFrequency === 'weekly' ? 6 : 9}>
              <Form.Item
                name="approvalMode"
                label="采用与确认策略"
                rules={[{ required: true, message: '请选择采用与确认策略' }]}
              >
                <Select
                  options={[
                    { value: 'auto', label: '默认：所有普通内部结果自动采用' },
                    { value: 'risk', label: '兼容旧规则：按风险分流' },
                    { value: 'always', label: '兼容旧规则：所有结果逐条确认' },
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </>
  );
}
