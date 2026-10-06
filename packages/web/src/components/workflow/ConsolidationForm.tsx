'use client';

import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import {
  type ConsolidationConfig,
  type ConsolidationConfigInput,
  triggerConsolidationNow,
  useConsolidationConfig,
  useUpdateConsolidationConfig,
} from '@/hooks/useAdminConfig';
import { useConfigForm } from '@/hooks/useConfigForm';
import { ScheduleFormFooter, ScheduleToggleRow, useRunNow } from './scheduleControls';

interface ConsolidationFormState {
  enabled: boolean;
  cron: string;
  minClusterSize: number;
  similarityThreshold: number;
}

const INITIAL: ConsolidationFormState = {
  cron: '0 3 * * 0',
  enabled: true,
  minClusterSize: 3,
  similarityThreshold: 0.85,
};

function toForm(data: ConsolidationConfig): ConsolidationFormState {
  return {
    cron: data.cronExpression,
    enabled: data.enabled,
    minClusterSize: data.minClusterSize,
    similarityThreshold: data.similarityThreshold,
  };
}

function toBody(form: ConsolidationFormState): ConsolidationConfigInput {
  return {
    cronExpression: form.cron,
    enabled: form.enabled,
    minClusterSize: form.minClusterSize,
    similarityThreshold: form.similarityThreshold,
  };
}

export function ConsolidationForm() {
  const {
    data: consolidation,
    error: loadError,
    isError,
    isFetching,
    refetch,
    isLoading,
  } = useConsolidationConfig();
  const update = useUpdateConsolidationConfig();
  const { form, setField, submit, saved, error, dirtyCount, discard } = useConfigForm({
    data: consolidation,
    initial: INITIAL,
    mutateAsync: update.mutateAsync,
    toBody,
    toForm,
  });
  const runNow = useRunNow(triggerConsolidationNow, 'could not start consolidation');

  return (
    <>
      <SectionHeader
        className="mt-8"
        hint="Periodically merges similar agent lessons"
        title="Lesson consolidation"
      />

      <QueryBoundary
        compact
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="the consolidation schedule"
        onRetry={() => void refetch()}
      >
        <form className="space-y-6" onSubmit={submit}>
          <Card>
            <CardHeader>
              <CardTitle eyebrow="Schedule">Consolidation schedule</CardTitle>
            </CardHeader>
            <div className="space-y-4">
              <ScheduleToggleRow
                enabled={form.enabled}
                onToggle={() => setField('enabled', !form.enabled)}
                schedule={consolidation?.schedule}
              />

              <Input
                hint="Standard 5-field cron. Default 0 3 * * 0 = Sundays at 03:00 UTC."
                id="consolidation-cron"
                label="Cron expression"
                onChange={(e) => setField('cron', e.target.value)}
                placeholder="0 3 * * 0"
                value={form.cron}
              />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  hint="Clusters smaller than this are skipped."
                  id="consolidation-min-cluster"
                  label="Min cluster size"
                  max={20}
                  min={2}
                  onChange={(e) => setField('minClusterSize', Number(e.target.value))}
                  type="number"
                  value={form.minClusterSize}
                />

                <Input
                  hint="Cosine similarity (0.5–1.0). Higher = tighter clusters."
                  id="consolidation-threshold"
                  label="Similarity threshold"
                  max={1}
                  min={0.5}
                  onChange={(e) => setField('similarityThreshold', Number(e.target.value))}
                  step={0.05}
                  type="number"
                  value={form.similarityThreshold}
                />
              </div>
            </div>
          </Card>

          <ScheduleFormFooter
            canRun={!!consolidation?.schedule.exists}
            dirtyCount={dirtyCount}
            error={error}
            isSaving={update.isPending}
            onDiscard={discard}
            runNow={runNow}
            saved={saved}
            savedMessage="Consolidation schedule saved and synced."
            triggeredMessage="Consolidation run started."
          />
        </form>
      </QueryBoundary>
    </>
  );
}
