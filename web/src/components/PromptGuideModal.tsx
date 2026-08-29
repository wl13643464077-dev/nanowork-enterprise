import { Alert, Button, Modal, Space, Tag } from 'antd';

export type PromptGuide = {
  id?: number;
  tab: string;
  type: string;
  code: string;
  name: string;
  role_card: string;
  output_rule: string;
  style: string;
  canEditPrompt?: boolean;
  editablePath?: string;
  overridden?: boolean;
};

type Props = {
  open: boolean;
  guide: PromptGuide | null;
  onClose: () => void;
};

export default function PromptGuideModal({ open, guide, onClose }: Props) {
  return (
    <Modal
      open={open && !!guide}
      width={680}
      onCancel={onClose}
      title={
        guide ? (
          <>
            <Tag color="blue" style={{ fontFamily: 'Consolas,Menlo,monospace' }}>
              {guide.code}
            </Tag>
            {guide.name}
          </>
        ) : (
          ''
        )
      }
      footer={
        <Space>
          {guide?.canEditPrompt && (
            <Button
              type="primary"
              ghost
              onClick={() => {
                window.location.href = guide.editablePath || '/system?tab=prompts';
              }}
            >
              去系统管理修改
            </Button>
          )}
          <Button type="primary" onClick={onClose}>
            知道了
          </Button>
        </Space>
      }
    >
      {guide && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[
            ['角色卡', guide.role_card],
            ['输出规则', guide.output_rule],
            ['风格要求', guide.style],
          ].map(([label, value]) => (
            <div key={label}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ui-text-2)', marginBottom: 5 }}>{label}</div>
              <div
                style={{
                  background: 'var(--ui-surface-2)',
                  border: '1px solid var(--ui-border)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  fontSize: 12.5,
                  color: 'var(--ui-text-2)',
                  lineHeight: 1.8,
                  whiteSpace: 'pre-wrap',
                  maxHeight: 150,
                  overflow: 'auto',
                }}
              >
                {value || <span style={{ color: 'var(--ui-muted)' }}>暂未配置</span>}
              </div>
            </div>
          ))}
          {!guide.canEditPrompt && (
            <Alert
              type="info"
              showIcon
              message="当前账号可查看提示词逻辑，但不能修改；需要老板/管理员在系统管理的提示词中枢调整。"
            />
          )}
        </div>
      )}
    </Modal>
  );
}
