'use client';

import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import {
  type EvalScheduleConfig,
  type EvalScheduleConfigInput,
  triggerEvalScheduleNow,
  useEvalScheduleConfig,
  useUpdateEvalScheduleConfig,
} from '@/hooks/useAdminConfig';
import { useConfigForm } from '@/hooks/useConfigForm';
import { ScheduleFormFooter, ScheduleToggleRow, useRunNow } from './scheduleControls';

interface EvalScheduleFormState {
  enabled: boolean;
  cron: string;
  datasetSlug: string;
  candidateRef: string;
  baselineRef: string;
}

const INITIAL: EvalScheduleFormState = {
  baselineRef: 'last-release',
  candidateRef: 'main',
  cron: '0 7 * * *',
  datasetSlug: 'swe-implementer-golden',
  enabled: false,
};

function toForm(data: EvalScheduleConfig): EvalScheduleFormState {
  return {
    baselineRef: data.baselineRef,
    candidateRef: data.candidateRef,
    cron: data.cronExpression,
    datasetSlug: data.datasetSlug,
    enabled: data.enabled,
  };
}

function toBody(form: EvalScheduleFormState): EvalScheduleConfigInput {
  return {
    baselineRef: form.baselineRef.trim(),
    candidateRef: form.candidateRef.trim(),
    cronExpression: form.cron,
    datasetSlug: form.datasetSlug.trim(),
    enabled: form.enabled,
  };
}

export function EvalScheduleForm() {
  const {
    data: evalSchedule,
    error: loadError,
    isError,
    isFetching,
    refetch,
    isLoading,
  } = useEvalScheduleConfig();
  const update = useUpdateEvalScheduleConfig();
  const { form, setField, submit, saved, error, dirtyCount, discard } = useConfigForm({
    data: evalSchedule,
    initial: INITIAL,
    mutateAsync: update.mutateAsync,
    toBody,
    toForm,
  });
  const runNow = useRunNow(triggerEvalScheduleNow, 'could not start the eval run');

  return (
    <>
      <SectionHeader className="mt-8" title="Scheduled eval runs" />
      <p className="mb-5 text-sm text-paper-400">
        Periodically runs one eval dataset with a candidate ref against a baseline ref, to catch
        regressions in agent configuration before they reach every run. Scheduled runs keep lesson
        memory off on both sides.
      </p>

      <QueryBoundary
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="the eval schedule"
        onRetry={() => void refetch()}
        rows={2}
        shape="form"
      >
        <form className="space-y-6" onSubmit={submit}>
          <Card>
            <CardHeader>
              <CardTitle>Eval schedule</CardTitle>
            </CardHeader>

            <div className="space-y-4">
              <ScheduleToggleRow
                enabled={form.enabled}
                onToggle={() => setField('enabled', !form.enabled)}
                schedule={evalSchedule?.schedule}
              />

              <Input
                hint="Standard 5-field cron. Default 0 7 * * * = every day at 07:00 UTC."
                id="eval-schedule-cron"
                label="Cron expression"
                onChange={(e) => setField('cron', e.target.value)}
                placeholder="0 7 * * *"
                value={form.cron}
              />

              <Input
                hint="Slug of the dataset to run: lowercase letters, digits, - and _."
                id="eval-schedule-dataset-slug"
                label="Dataset slug"
                onChange={(e) => setField('datasetSlug', e.target.value)}
                placeholder="swe-implementer-golden"
                value={form.datasetSlug}
              />

              <Input
                hint="The ref under test. Default main."
                id="eval-schedule-candidate-ref"
                label="Candidate ref"
                onChange={(e) => setField('candidateRef', e.target.value)}
                placeholder="main"
                value={form.candidateRef}
              />

              <Input
                hint="The ref the candidate is compared against. Default last-release."
                id="eval-schedule-baseline-ref"
                label="Baseline ref"
                onChange={(e) => setField('baselineRef', e.target.value)}
                placeholder="last-release"
                value={form.baselineRef}
              />
            </div>
          </Card>

          <ScheduleFormFooter
            canRun={!!evalSchedule?.schedule.exists}
            dirtyCount={dirtyCount}
            error={error}
            isSaving={update.isPending}
            onDiscard={discard}
            runNow={runNow}
            saved={saved}
            savedMessage="Eval schedule saved and synced."
            triggeredMessage="Eval run started."
          />
        </form>
      </QueryBoundary>
    </>
  );
}
