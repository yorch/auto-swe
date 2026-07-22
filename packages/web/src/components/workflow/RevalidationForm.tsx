'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  triggerRevalidationNow,
  useRevalidationConfig,
  useUpdateRevalidationConfig,
} from '@/hooks/useAdminConfig';

export function RevalidationForm() {
  const { data: revalidation, isLoading } = useRevalidationConfig();
  const update = useUpdateRevalidationConfig();

  const [enabled, setEnabled] = useState(false);
  const [cron, setCron] = useState('0 5 * * 0');
  const [datasetSlug, setDatasetSlug] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);

  useEffect(() => {
    if (!revalidation) {
      return;
    }
    setEnabled(revalidation.enabled);
    setCron(revalidation.cronExpression);
    setDatasetSlug(revalidation.datasetSlug ?? '');
  }, [revalidation]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await update.mutateAsync({
        cronExpression: cron,
        datasetSlug: datasetSlug || null,
        enabled,
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

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
        <p className="text-sm text-paper-400">Loading…</p>
      ) : (
        <form className="space-y-6" onSubmit={handleSubmit}>
          <Card>
            <CardHeader>
              <CardTitle eyebrow="Schedule">Re-validation schedule</CardTitle>
            </CardHeader>

            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <input
                  checked={enabled}
                  className="h-4 w-4 accent-ember-400"
                  id="revalidation-enabled"
                  onChange={(e) => setEnabled(e.target.checked)}
                  type="checkbox"
                />
                <label className="text-sm" htmlFor="revalidation-enabled">
                  Schedule enabled
                </label>
                {revalidation?.schedule.exists && (
                  <span
                    className={`ml-auto text-xs ${revalidation.schedule.paused ? 'text-paper-500' : 'text-emerald-400'}`}
                  >
                    {revalidation.schedule.paused
                      ? 'Paused in Temporal'
                      : revalidation.schedule.nextRunAt
                        ? `Next run: ${new Date(revalidation.schedule.nextRunAt).toLocaleString()}`
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
                  onChange={(e) => setCron(e.target.value)}
                  placeholder="0 5 * * 0"
                  value={cron}
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
                  onChange={(e) => setDatasetSlug(e.target.value)}
                  placeholder="swe-implementer-golden"
                  value={datasetSlug}
                />
                <p className="mt-1 text-[11px] text-paper-500">
                  Optional substring match against dataset slug. Blank = all datasets.
                </p>
              </div>
            </div>
          </Card>

          {saved && (
            <p className="text-sm text-emerald-400">Re-validation schedule saved and synced.</p>
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
