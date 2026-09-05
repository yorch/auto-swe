'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import {
  type RevalidationConfig,
  type RevalidationConfigInput,
  triggerRevalidationNow,
  useRevalidationConfig,
  useUpdateRevalidationConfig,
} from '@/hooks/useAdminConfig';
import { useConfigForm } from '@/hooks/useConfigForm';
import { formatDate } from '@/lib/utils';

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
  const { data: revalidation, isLoading } = useRevalidationConfig();
  const update = useUpdateRevalidationConfig();
  const { form, setField, submit, saved, error } = useConfigForm({
    data: revalidation,
    initial: INITIAL,
    mutateAsync: update.mutateAsync,
    toBody,
    toForm,
  });

  const [triggering, setTriggering] = useState(false);

  const handleTriggerNow = async () => {
    setTriggering(true);
    try {
      await triggerRevalidationNow();
    } finally {
      setTriggering(false);
    }
  };

  return (
    <>
      <div className="mt-8">
        <h3 className="text-lg font-semibold">Eval re-validation</h3>
        <p className="mt-1 text-sm text-paper-400">
          Periodically re-runs each EvalCase&apos;s reference against current repo state to detect
          stale golden tests. Quarantines cases that no longer pass (not the agent&apos;s fault) and
          restores them when they pass again.
        </p>
      </div>

      {isLoading ? (
        <LoadingState compact />
      ) : (
        <form className="space-y-6" onSubmit={submit}>
          <Card>
            <CardHeader>
              <CardTitle eyebrow="Schedule">Re-validation schedule</CardTitle>
            </CardHeader>

            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <input
                  checked={form.enabled}
                  className="h-4 w-4 accent-ember-400"
                  id="revalidation-enabled"
                  onChange={(e) => setField('enabled', e.target.checked)}
                  type="checkbox"
                />
                <label className="text-sm" htmlFor="revalidation-enabled">
                  Schedule enabled
                </label>
                {revalidation?.schedule.exists && (
                  <span
                    className={`ml-auto text-xs ${revalidation.schedule.paused ? 'text-paper-500' : 'text-moss-400'}`}
                  >
                    {revalidation.schedule.paused
                      ? 'Paused in Temporal'
                      : revalidation.schedule.nextRunAt
                        ? `Next run: ${formatDate(revalidation.schedule.nextRunAt)}`
                        : 'Active in Temporal'}
                  </span>
                )}
              </div>

              <div>
                <label
                  className="mb-1 block text-xs uppercase text-paper-500"
                  htmlFor="revalidation-cron"
                >
                  Cron expression
                </label>
                <input
                  className="w-full rounded-[9px] border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                  id="revalidation-cron"
                  onChange={(e) => setField('cron', e.target.value)}
                  placeholder="0 5 * * 0"
                  value={form.cron}
                />
                <p className="mt-1 text-[11px] text-paper-500">
                  Standard 5-field cron. Default <span className="font-mono">0 5 * * 0</span> =
                  Sundays at 05:00 UTC.
                </p>
              </div>

              <div>
                <label
                  className="mb-1 block text-xs uppercase text-paper-500"
                  htmlFor="revalidation-dataset-slug"
                >
                  Dataset slug filter
                  <span className="ml-2 font-mono text-[10px] normal-case tracking-normal text-paper-600">
                    (leave blank to re-validate all datasets)
                  </span>
                </label>
                <input
                  className="w-full rounded-[9px] border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                  id="revalidation-dataset-slug"
                  onChange={(e) => setField('datasetSlug', e.target.value)}
                  placeholder="swe-implementer-golden"
                  value={form.datasetSlug}
                />
                <p className="mt-1 text-[11px] text-paper-500">
                  Optional substring match against dataset slug. Blank = all datasets.
                </p>
              </div>
            </div>
          </Card>

          {saved && (
            <p className="text-sm text-moss-400">Re-validation schedule saved and synced.</p>
          )}
          {error && <p className="text-sm text-brick-400">{error}</p>}

          <div className="flex items-center justify-end gap-3">
            <Button
              disabled={triggering || !revalidation?.schedule.exists}
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
