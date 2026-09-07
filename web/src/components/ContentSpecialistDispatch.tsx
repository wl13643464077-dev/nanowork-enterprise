import { Alert } from 'antd';
import AiSalesVideoPanel from './AiSalesVideoPanel';
import AiXhsNotePanel from './AiXhsNotePanel';
import { useReferenceImages } from './useReferenceImages';

const noRelatedList = () => {};

export default function ContentSpecialistDispatch({
  employeeIdx,
  active,
  available,
  onChanged,
  initialJobId,
  presetBrief,
  onTaskSubmitted,
}: {
  employeeIdx: 10 | 11;
  active: boolean;
  available: boolean;
  onChanged: () => void | Promise<unknown>;
  initialJobId?: number | null;
  presetBrief?: { key: number; text: string } | null;
  onTaskSubmitted?: () => void;
}) {
  const { refImgs, setRefImgs, onPickRef } = useReferenceImages();
  const xhs = employeeIdx === 11;
  return (
    <section className="ewb-section" aria-label={xhs ? '小红书图文派活' : 'AI带货视频派活'}>
      {!available && <Alert type="info" showIcon message="当前账号未开通此岗位派活权限" />}
      {xhs ? (
        <AiXhsNotePanel embedded open={active} canDispatch={available} onOpenChange={noRelatedList} />
      ) : (
        <AiSalesVideoPanel
          embedded
          open={active}
          canDispatch={available}
          onOpenChange={noRelatedList}
          initialJobId={initialJobId}
          presetBrief={presetBrief}
          refImgs={refImgs}
          setRefImgs={setRefImgs}
          onPickRef={onPickRef}
          loadMaterials={noRelatedList}
          loadMediaJobs={noRelatedList}
          loadSummary={onChanged}
          onTaskSubmitted={() => {
            void onChanged();
            onTaskSubmitted?.();
          }}
        />
      )}
    </section>
  );
}
