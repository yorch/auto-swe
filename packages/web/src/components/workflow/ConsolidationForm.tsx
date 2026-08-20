'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { SectionHeader } from '@/components/ui/PageHeader';
import {
  type ConsolidationConfig,
  type ConsolidationConfigInput,
  triggerConsolidationNow,
  useConsolidationConfig,
  useUpdateConsolidationConfig,
} from '@/hooks/useAdminConfig';
import { useConfigForm } from '@/hooks/useConfigForm';
import { formatDate } from '@/lib/utils';

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
  const { data: consolidation, isLoading } = useConsolidationConfig();
  const update = useUpdateConsolidationConfig();
  const { form, setField, submit, saved, error } = useConfigForm({
    data: consolidation,
    initial: INITIAL,
    mutateAsync: update.mutateAsync,
    toBody,
    toForm,
  });

  const [triggering, setTriggering] = useState(false);

  const handleTriggerNow = async () => {
    setTriggering(true);
    try {
      await triggerConsolidationNow();
    } finally {
      setTriggering(false);
    }
  };

  return (
    <>
      <SectionHeader
        className="mt-8"
        hint="periodically merges similar agent lessons"
        title="Lesson consolidation"
      />

      {isLoading ? (
        <LoadingState message="Loading…" />
      ) : (
        <form className="space-y-6" onSubmit={submit}>
          <Card>
            <CardHeader>
              <CardTitle eyebrow="Schedule">Consolidation schedule</CardTitle>
            </CardHeader>
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <input
                  checked={form.enabled}
                  className="h-4 w-4 accent-ember-400"
                  id="consolidation-enabled"
                  onChange={(e) => setField('enabled', e.target.checked)}
                  type="checkbox"
                />
                <label className="text-sm" htmlFor="consolidation-enabled">
                  Schedule enabled
                </label>
                {consolidation?.schedule.exists && (
                  <span
                    className={`ml-auto text-xs ${consolidation.schedule.paused ? 'text-paper-500' : 'text-moss-400'}`}
                  >
                    {consolidation.schedule.paused
                      ? 'Paused in Temporal'
                      : consolidation.schedule.nextRunAt
                        ? `Next run: ${formatDate(consolidation.schedule.nextRunAt)}`
                        : 'Active in Temporal'}
                  </span>
                )}
              </div>

              <FieldWrapper
                hint="Standard 5-field cron. Default 0 3 * * 0 = Sundays at 03:00 UTC."
                id="consolidation-cron"
                label="Cron expression"
              >
                <Input
                  id="consolidation-cron"
                  onChange={(e) => setField('cron', e.target.value)}
                  placeholder="0 3 * * 0"
                  value={form.cron}
                />
              </FieldWrapper>

              <div className="grid grid-cols-2 gap-4">
                <FieldWrapper
                  hint="Clusters smaller than this are skipped."
                  id="consolidation-min-cluster"
                  label="Min cluster size"
                >
                  <Input
                    id="consolidation-min-cluster"
                    max={20}
                    min={2}
                    onChange={(e) => setField('minClusterSize', Number(e.target.value))}
                    type="number"
                    value={form.minClusterSize}
                  />
                </FieldWrapper>

                <FieldWrapper
                  hint="Cosine similarity (0.5–1.0). Higher = tighter clusters."
                  id="consolidation-threshold"
                  label="Similarity threshold"
                >
                  <Input
                    id="consolidation-threshold"
                    max={1}
                    min={0.5}
                    onChange={(e) => setField('similarityThreshold', Number(e.target.value))}
                    step={0.05}
                    type="number"
                    value={form.similarityThreshold}
                  />
                </FieldWrapper>
              </div>
            </div>
          </Card>

          {saved && <Alert variant="success">Consolidation schedule saved and synced.</Alert>}
          {error && <Alert variant="error">{error}</Alert>}

          <div className="flex items-center justify-end gap-3">
            <Button
              disabled={triggering || !consolidation?.schedule.exists}
              onClick={handleTriggerNow}
              type="button"
              variant="secondary"
            >
              {triggering ? 'Triggering…' : 'Run now'}
            </Button>
            <Button disabled={update.isPending} type="submit" variant="primary">
              {update.isPending ? 'Saving…' : 'Save schedule'}
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
