import { parseWorkflowSpec, validateSpec } from '@auto-swe/shared/workflow';
import { useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Select } from '@/components/ui/Select';
import { Slider } from '@/components/ui/Slider';
import { useUpdateWorkflowTemplate, useWorkflowTemplateVersion } from '@/hooks/useTemplates';
import { useTransientFlag } from '@/hooks/useTransientFlag';
import { errMsg } from '@/lib/errors';
import { RailCard } from './RailCard';

export function ExperimentCard({
  templateId,
  versions,
  activeVersion,
  experimentVersion,
  experimentSplit,
}: {
  templateId: string;
  versions: { id: string; version: number }[];
  activeVersion: number | null;
  experimentVersion: number | null;
  experimentSplit: number | null;
}) {
  const updateTemplate = useUpdateWorkflowTemplate(templateId);
  const [expVer, setExpVer] = useState<number | null>(experimentVersion);
  const [split, setSplit] = useState<number>(experimentSplit ?? 10);
  const [error, setError] = useState<string | null>(null);
  const [saved, markSaved] = useTransientFlag();

  const nonActive = versions.filter((v) => v.version !== activeVersion);

  // A version with lint errors can be saved as a draft but cannot serve traffic, so it cannot be
  // an experiment arm. Only the chosen version's spec is loaded, so the check runs on selection.
  const { data: armDetail } = useWorkflowTemplateVersion(templateId, expVer);
  const armErrorCount = useMemo(() => {
    if (!armDetail || expVer == null) {
      return 0;
    }
    try {
      return validateSpec(parseWorkflowSpec(armDetail.spec)).errors.length;
    } catch {
      return 1;
    }
  }, [armDetail, expVer]);

  const handleSave = async () => {
    setError(null);
    try {
      await updateTemplate.mutateAsync({
        experimentSplit: expVer ? split : null,
        experimentVersion: expVer,
      });
      markSaved();
    } catch (err) {
      setError(errMsg(err, 'save failed'));
    }
  };

  const handleClear = async () => {
    setError(null);
    setExpVer(null);
    setSplit(10);
    try {
      await updateTemplate.mutateAsync({ experimentSplit: null, experimentVersion: null });
    } catch (err) {
      setError(errMsg(err, 'clear failed'));
    }
  };

  if (nonActive.length === 0) {
    return null;
  }

  return (
    <RailCard hint="A/B test" title="Experiment">
      {error && <Alert className="mb-3 text-xs">{error}</Alert>}
      <div className="space-y-3">
        <Select
          compact
          hint="Send a share of new runs to another version"
          label="Experiment version"
          onChange={(v) => setExpVer(v ? Number(v) : null)}
          options={[
            { label: 'None', value: '' },
            ...nonActive.map((v) => ({ label: `v${v.version}`, value: String(v.version) })),
          ]}
          value={expVer == null ? '' : String(expVer)}
        />
        {expVer && armErrorCount > 0 && (
          <Alert className="text-xs">
            v{expVer} has {armErrorCount} error{armErrorCount === 1 ? '' : 's'}, so it cannot be
            used in an experiment until they are fixed.
          </Alert>
        )}
        {expVer && (
          <div className="space-y-1.5">
            <Slider
              formatValue={(v) => `${v}%`}
              id="exp-split"
              label="Traffic to the experiment"
              max={50}
              min={1}
              onChange={setSplit}
              value={split}
            />
            <p className="text-xs text-paper-500 tabular-nums">
              v{activeVersion} gets {100 - split}% · v{expVer} gets {split}%
            </p>
          </div>
        )}
        <div className="flex gap-2">
          <Button
            disabled={updateTemplate.isPending || armErrorCount > 0}
            onClick={handleSave}
            size="sm"
            variant="secondary"
          >
            {saved ? (
              <>
                <Icon name="check" size={13} />
                Saved
              </>
            ) : updateTemplate.isPending ? (
              'Saving…'
            ) : (
              'Save experiment'
            )}
          </Button>
          {(experimentVersion || expVer) && (
            <Button onClick={handleClear} size="sm" variant="ghost">
              Clear
            </Button>
          )}
        </div>
      </div>
    </RailCard>
  );
}
