'use client';

import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import {
  type RevalidationConfig,
  type RevalidationConfigInput,
  triggerRevalidationNow,
  useRevalidationConfig,
  useUpdateRevalidationConfig,
} from '@/hooks/useAdminConfig';
import { useConfigForm } from '@/hooks/useConfigForm';
import { ScheduleFormFooter, ScheduleToggleRow, useRunNow } from './scheduleControls';

interface RevalidationFormState {
  enabled: boolean;
  cron: string;
  datasetSlug: string;
}

const INITIAL: RevalidationFormState = {
  cron: '0 5 * * 0',
  datasetSlug: '',
  enabled: false,
};

function toForm(data: RevalidationConfig): RevalidationFormState {
  return {
    cron: data.cronExpression,
    datasetSlug: data.datasetSlug ?? '',
    enabled: data.enabled,
  };
}

function toBody(form: RevalidationFormState): RevalidationConfigInput {
  return {
    cronExpression: form.cron,
    datasetSlug: form.datasetSlug || null,
    enabled: form.enabled,
  };
}

export function RevalidationForm() {
  const { data: revalidation, error: loadError, isError, isLoading } = useRevalidationConfig();
  const update = useUpdateRevalidationConfig();
  const { form, setField, submit, saved, error } = useConfigForm({
    data: revalidation,
    initial: INITIAL,
    mutateAsync: update.mutateAsync,
    toBody,
    toForm,
  });
  const runNow = useRunNow(triggerRevalidationNow, 'could not start re-validation');

  return (
    <>
      <SectionHeader
        className="mt-8"
        hint="re-runs eval references to catch stale golden tests"
        title="Eval re-validation"
      />
      <p className="mb-5 text-sm text-paper-400">
        Periodically re-runs each EvalCase&apos;s reference against current repo state to detect
        stale golden tests. Quarantines cases that no longer pass (not the agent&apos;s fault) and
        restores them when they pass again.
      </p>

      <QueryBoundary
        compact
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="the re-validation schedule"
      >
        <form className="space-y-6" onSubmit={submit}>
          <Card>
            <CardHeader>
              <CardTitle eyebrow="Schedule">Re-validation schedule</CardTitle>
            </CardHeader>

            <div className="space-y-4">
              <ScheduleToggleRow
                enabled={form.enabled}
                onToggle={() => setField('enabled', !form.enabled)}
                schedule={revalidation?.schedule}
              />

              <Input
                hint="Standard 5-field cron. Default 0 5 * * 0 = Sundays at 05:00 UTC."
                id="revalidation-cron"
                label="Cron expression"
                onChange={(e) => setField('cron', e.target.value)}
                placeholder="0 5 * * 0"
                value={form.cron}
              />

              <Input
                hint="Optional substring match against dataset slug. Blank = all datasets."
                id="revalidation-dataset-slug"
                label="Dataset slug filter"
                onChange={(e) => setField('datasetSlug', e.target.value)}
                placeholder="swe-implementer-golden"
                value={form.datasetSlug}
              />
            </div>
          </Card>

          <ScheduleFormFooter
            canRun={!!revalidation?.schedule.exists}
            error={error}
            isSaving={update.isPending}
            runNow={runNow}
            saved={saved}
            savedMessage="Re-validation schedule saved and synced."
            triggeredMessage="Re-validation run started."
          />
        </form>
      </QueryBoundary>
    </>
  );
}
