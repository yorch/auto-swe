import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { SkeletonDetail } from '@/components/ui/LoadingState';
import { Modal } from '@/components/ui/Modal';
import { useExplainWorkflowTemplate } from '@/hooks/useTemplates';
import { errMsg } from '@/lib/errors';

export function ExplainModal({
  activeVersion,
  open,
  onClose,
  templateId,
}: {
  activeVersion: number | null;
  open: boolean;
  onClose: () => void;
  templateId: string;
}) {
  const { data, error, isFetching } = useExplainWorkflowTemplate(templateId, activeVersion, open);

  return (
    <Modal onClose={onClose} open={open} title="What this workflow does">
      <div className="space-y-4">
        {isFetching && !data && <SkeletonDetail label="the workflow explanation" />}
        {error && <Alert>{errMsg(error, 'Could not explain')}</Alert>}
        {data?.explanation && (
          <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-paper-200">
            {data.explanation}
          </div>
        )}
        <div className="flex justify-end">
          <Button onClick={onClose} variant="ghost">
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
