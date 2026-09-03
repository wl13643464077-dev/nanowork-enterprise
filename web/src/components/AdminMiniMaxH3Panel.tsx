import { Alert, Badge, Col, Input, InputNumber, Row, Space, Switch, Tag } from 'antd';
import { Panel } from './Kit';
import './AdminMiniMaxH3Panel.css';

type MiniMaxH3Value = {
  pricePer15s768p: number;
  providerVerified: boolean;
  billingVerified: boolean;
  priceBasis: string;
};

type AdminMiniMaxH3PanelProps = {
  config: any;
  value: MiniMaxH3Value;
  onChange: (next: MiniMaxH3Value) => void;
};

export function AdminMiniMaxH3Panel({ config, value, onChange }: AdminMiniMaxH3PanelProps) {
  const readiness = config?.readiness || {};
  const capability = config?.capability || {};
  const estimated30s = Math.round(Number(value.pricePer15s768p || 0) * 2 * 10_000) / 10_000;
  const patchValue = (patch: Partial<MiniMaxH3Value>) => onChange({ ...value, ...patch });

  return (
    <Col xs={24}>
      <Panel
        title="C · MiniMax H3 上线核验"
        extra={
          <Badge
            status={readiness.ready ? 'success' : 'warning'}
            text={readiness.ready ? '四项条件全部通过，可用' : '尚未就绪'}
          />
        }
      >
        <Alert
          showIcon
          type={readiness.ready ? 'success' : 'warning'}
          className="admin-h3-alert"
          message={
            readiness.ready ? 'MiniMax H3 已通过真实供应商与计价闸门' : '这里只记录核验证据，不会伪造供应商可用状态'
          }
          description={
            readiness.ready
              ? 'AI带货员的30秒成片会真实调用2个15秒、768P片段，再进行合成和结算。'
              : (readiness.blockers || []).join('；')
          }
        />

        <Row gutter={[12, 12]}>
          <Col xs={24} lg={8}>
            <div className="admin-h3-readiness-card">
              <div className="admin-h3-readiness-title">① 服务端部署条件</div>
              <Space wrap size={[6, 6]}>
                <Tag color={readiness.deploymentEnabled ? 'green' : 'orange'}>
                  总开关{readiness.deploymentEnabled ? '已开启' : '未开启'}
                </Tag>
                <Tag color={readiness.apiKeyConfigured ? 'green' : 'red'}>
                  MINIMAX_API_KEY {readiness.apiKeyConfigured ? '已配置' : '未配置'}
                </Tag>
              </Space>
              <div className="admin-h3-readiness-hint">
                密钥只允许写入服务端环境变量；本页不会读取、展示或保存密钥原文。
              </div>
            </div>
          </Col>

          <Col xs={24} lg={8}>
            <div className="admin-h3-readiness-card">
              <div className="admin-h3-readiness-title">② 供应商能力核验</div>
              <Space wrap>
                <Switch
                  checked={value.providerVerified}
                  checkedChildren="已核验"
                  unCheckedChildren="未核验"
                  disabled={!readiness.apiKeyConfigured && !value.providerVerified}
                  onChange={checked => patchValue({ providerVerified: checked })}
                />
                <Tag color={capability.providerVerified ? 'green' : 'default'}>
                  {capability.providerVerified ? '已有审计记录' : '暂无审计记录'}
                </Tag>
              </Space>
              <div className="admin-h3-readiness-hint">
                只有独立 MiniMax 密钥存在时才能保存“已核验”；该开关本身不会发起付费视频。
              </div>
            </div>
          </Col>

          <Col xs={24} lg={8}>
            <div className="admin-h3-readiness-card">
              <div className="admin-h3-readiness-title">③ 计价核验</div>
              <Space wrap>
                <Switch
                  checked={value.billingVerified}
                  checkedChildren="已核验"
                  unCheckedChildren="未核验"
                  disabled={Number(value.pricePer15s768p) <= 0 && !value.billingVerified}
                  onChange={checked => patchValue({ billingVerified: checked })}
                />
                <Tag color={capability.billingVerified ? 'green' : 'default'}>
                  {capability.billingVerified ? '已有审计记录' : '暂无审计记录'}
                </Tag>
              </Space>
              <div className="admin-h3-readiness-hint">单段成本大于0并填写价格依据后，平台负责人才能确认计价。</div>
            </div>
          </Col>
        </Row>

        <Row gutter={[12, 12]} className="admin-h3-fields">
          <Col xs={24} md={8}>
            <div className="admin-h3-field-label">H3 768P 成本（¥ / 15秒单段）</div>
            <InputNumber
              min={0}
              max={1_000_000}
              precision={4}
              step={0.1}
              value={value.pricePer15s768p}
              className="admin-h3-field-control"
              onChange={next => patchValue({ pricePer15s768p: next ?? 0 })}
            />
          </Col>
          <Col xs={24} md={8}>
            <div className="admin-h3-field-label">30秒预计供应商成本（自动 × 2）</div>
            <Input value={`¥ ${estimated30s.toFixed(4)}`} readOnly />
          </Col>
          <Col xs={24} md={8}>
            <div className="admin-h3-field-label">最近完整核验</div>
            <Input
              value={
                capability.verifiedAt
                  ? `${capability.verifiedAt} · 管理员 #${capability.verifiedBy || '-'}`
                  : '尚未完成双核验'
              }
              readOnly
            />
          </Col>
          <Col xs={24}>
            <div className="admin-h3-field-label">价格依据（供应商价目、合同或账单）</div>
            <Input.TextArea
              rows={2}
              maxLength={500}
              value={value.priceBasis}
              placeholder="例如：MiniMax 官方 H3 768P 标价为 USD 0.08/秒；人民币单段成本按本期供应商账单与结算汇率录入"
              onChange={event => patchValue({ priceBasis: event.target.value })}
            />
          </Col>
        </Row>
      </Panel>
    </Col>
  );
}
