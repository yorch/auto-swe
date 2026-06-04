'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  triggerConsolidationNow,
  useConsolidationConfig,
  useUpdateConsolidationConfig,
  useUpdateWorkflowDefaultsConfig,
  useWorkflowDefaultsConfig,
  type WorkflowDefaultsInput,
} from '@/hooks/useAdminConfig';

export default function AdminWorkflowPage() {
  const { data, isLoading } = useWorkflowDefaultsConfig();
  const update = useUpdateWorkflowDefaultsConfig();

  const [branchPrefix, setBranchPrefix] = useState('');
  const [prTitleTemplate, setPrTitleTemplate] = useState('');
  const [prBodyTemplate, setPrBodyTemplate] = useState('');
  const [defaultTeamSlug, setDefaultTeamSlug] = useState('');

  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Consolidation state
  const { data: consolidation, isLoading: consolidationLoading } = useConsolidationConfig();
  const updateConsolidation = useUpdateConsolidationConfig();
  const [consolidationEnabled, setConsolidationEnabled] = useState(true);
  const [consolidationCron, setConsolidationCron] = useState('0 3 * * 0');
  const [consolidationMinClusterSize, setConsolidationMinClusterSize] = useState(3);
  const [consolidationSimilarityThreshold, setConsolidationSimilarityThreshold] = useState(0.85);
  const [consolidationSaved, setConsolidationSaved] = useState(false);
  const [consolidationError, setConsolidationError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);

  useEffect(() => {
    if (!consolidation) {
      return;
    }
    setConsolidationEnabled(consolidation.enabled);
    setConsolidationCron(consolidation.cronExpression);
    setConsolidationMinClusterSize(consolidation.minClusterSize);
    setConsolidationSimilarityThreshold(consolidation.similarityThreshold);
  }, [consolidation]);

  // Seed form from loaded data (once)
  useEffect(() => {
    if (!data) {
      return;
    }
    setBranchPrefix(data.branchPrefix ?? '');
    setPrTitleTemplate(data.prTitleTemplate ?? '');
    setPrBodyTemplate(data.prBodyTemplate ?? '');
    setDefaultTeamSlug(data.defaultTeamSlug ?? '');
  }, [data]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);

    const body: WorkflowDefaultsInput = {};
    if (branchPrefix) {
      body.branchPrefix = branchPrefix;
    }
    if (prTitleTemplate) {
      body.prTitleTemplate = prTitleTemplate;
    }
    if (prBodyTemplate) {
      body.prBodyTemplate = prBodyTemplate;
    }
    if (defaultTeamSlug) {
      body.defaultTeamSlug = defaultTeamSlug;
    }

    try {
      await update.mutateAsync(body);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const handleConsolidationSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setConsolidationError(null);
    setConsolidationSaved(false);
    try {
      await updateConsolidation.mutateAsync({
        cronExpression: consolidationCron,
        enabled: consolidationEnabled,
        minClusterSize: consolidationMinClusterSize,
        similarityThreshold: consolidationSimilarityThreshold,
      });
      setConsolidationSaved(true);
    } catch (err) {
      setConsolidationError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const handleTriggerNow = async () => {
    setTriggering(true);
    try {
      await triggerConsolidationNow();
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Admin — Workflow defaults</h2>
        <p className="mt-1 text-sm text-paper-400">
          System-wide defaults applied to every new work request. Per-team overrides take precedence
          when set.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-paper-400">Loading…</p>
      ) : (
        <>
          <form className="space-y-6" onSubmit={handleSubmit}>
            <Card>
              <CardHeader>
                <CardTitle eyebrow="Git &amp; PR">Branch and pull request templates</CardTitle>
              </CardHeader>
              <div className="space-y-4">
                <div>
                  <label
                    className="mb-1 block text-xs uppercase text-paper-500"
                    htmlFor="branch-prefix"
                  >
                    Branch prefix
                  </label>
                  <input
                    className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                    id="branch-prefix"
                    onChange={(e) => setBranchPrefix(e.target.value)}
                    placeholder="auto"
                    value={branchPrefix}
                  />
                  <p className="mt-1 text-[11px] text-paper-500">
                    Branches are created as{' '}
                    <span className="font-mono">
                      {branchPrefix || 'auto'}/{'<ticketId>'}
                    </span>
                    .
                  </p>
                </div>

                <div>
                  <label
                    className="mb-1 block text-xs uppercase text-paper-500"
                    htmlFor="pr-title-template"
                  >
                    PR title template
                  </label>
                  <input
                    className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                    id="pr-title-template"
                    onChange={(e) => setPrTitleTemplate(e.target.value)}
                    placeholder="[auto-swe] {{ticketId}}"
                    value={prTitleTemplate}
                  />
                  <p className="mt-1 text-[11px] text-paper-500">
                    Available variables: <span className="font-mono">{'{{ticketId}}'}</span>,{' '}
                    <span className="font-mono">{'{{description}}'}</span>.
                  </p>
                </div>

                <div>
                  <label
                    className="mb-1 block text-xs uppercase text-paper-500"
                    htmlFor="pr-body-template"
                  >
                    PR body template
                    <span className="ml-2 font-mono text-[10px] normal-case tracking-normal text-paper-600">
                      (leave blank to use system default)
                    </span>
                  </label>
                  <textarea
                    className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                    id="pr-body-template"
                    onChange={(e) => setPrBodyTemplate(e.target.value)}
                    placeholder={
                      'Resolves {{ticketId}}\n\n## Summary\n{{description}}\n\n---\n🤖 Implemented by auto-swe'
                    }
                    rows={6}
                    value={prBodyTemplate}
                  />
                  <p className="mt-1 text-[11px] text-paper-500">
                    Available variables: <span className="font-mono">{'{{ticketId}}'}</span>,{' '}
                    <span className="font-mono">{'{{description}}'}</span>,{' '}
                    <span className="font-mono">{'{{prUrl}}'}</span>.
                  </p>
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle eyebrow="Teams">Default team</CardTitle>
              </CardHeader>
              <div>
                <label
                  className="mb-1 block text-xs uppercase text-paper-500"
                  htmlFor="default-team-slug"
                >
                  Default team slug
                </label>
                <input
                  className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                  id="default-team-slug"
                  onChange={(e) => setDefaultTeamSlug(e.target.value)}
                  placeholder="default"
                  value={defaultTeamSlug}
                />
                <p className="mt-1 text-[11px] text-paper-500">
                  Work requests without an explicit team are assigned to this team.
                </p>
              </div>
            </Card>

            {saved && <p className="text-sm text-emerald-400">Settings saved.</p>}
            {error && <p className="text-sm text-brick-400">{error}</p>}

            <div className="flex justify-end">
              <Button disabled={update.isPending} type="submit" variant="primary">
                {update.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>

          {/* ── Lesson Consolidation Schedule ── */}
          <div className="mt-8">
            <h3 className="text-lg font-semibold">Lesson consolidation</h3>
            <p className="mt-1 text-sm text-paper-400">
              Periodically merges similar agent lessons using a Temporal Schedule. Runs for every
              repository that has consolidation enabled.
            </p>
          </div>

          {consolidationLoading ? (
            <p className="text-sm text-paper-400">Loading…</p>
          ) : (
            <form className="space-y-6" onSubmit={handleConsolidationSubmit}>
              <Card>
                <CardHeader>
                  <CardTitle eyebrow="Schedule">Consolidation schedule</CardTitle>
                </CardHeader>
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <input
                      checked={consolidationEnabled}
                      className="h-4 w-4 accent-ember-400"
                      id="consolidation-enabled"
                      onChange={(e) => setConsolidationEnabled(e.target.checked)}
                      type="checkbox"
                    />
                    <label className="text-sm" htmlFor="consolidation-enabled">
                      Schedule enabled
                    </label>
                    {consolidation?.schedule.exists && (
                      <span
                        className={`ml-auto text-xs ${consolidation.schedule.paused ? 'text-paper-500' : 'text-emerald-400'}`}
                      >
                        {consolidation.schedule.paused
                          ? 'Paused in Temporal'
                          : consolidation.schedule.nextRunAt
                            ? `Next run: ${new Date(consolidation.schedule.nextRunAt).toLocaleString()}`
                            : 'Active in Temporal'}
                      </span>
                    )}
                  </div>

                  <div>
                    <label
                      className="mb-1 block text-xs uppercase text-paper-500"
                      htmlFor="consolidation-cron"
                    >
                      Cron expression
                    </label>
                    <input
                      className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                      id="consolidation-cron"
                      onChange={(e) => setConsolidationCron(e.target.value)}
                      placeholder="0 3 * * 0"
                      value={consolidationCron}
                    />
                    <p className="mt-1 text-[11px] text-paper-500">
                      Standard 5-field cron. Default <span className="font-mono">0 3 * * 0</span> =
                      Sundays at 03:00 UTC.
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label
                        className="mb-1 block text-xs uppercase text-paper-500"
                        htmlFor="consolidation-min-cluster"
                      >
                        Min cluster size
                      </label>
                      <input
                        className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                        id="consolidation-min-cluster"
                        max={20}
                        min={2}
                        onChange={(e) => setConsolidationMinClusterSize(Number(e.target.value))}
                        type="number"
                        value={consolidationMinClusterSize}
                      />
                      <p className="mt-1 text-[11px] text-paper-500">
                        Clusters smaller than this are skipped.
                      </p>
                    </div>

                    <div>
                      <label
                        className="mb-1 block text-xs uppercase text-paper-500"
                        htmlFor="consolidation-threshold"
                      >
                        Similarity threshold
                      </label>
                      <input
                        className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                        id="consolidation-threshold"
                        max={1}
                        min={0.5}
                        onChange={(e) =>
                          setConsolidationSimilarityThreshold(Number(e.target.value))
                        }
                        step={0.05}
                        type="number"
                        value={consolidationSimilarityThreshold}
                      />
                      <p className="mt-1 text-[11px] text-paper-500">
                        Cosine similarity (0.5–1.0). Higher = tighter clusters.
                      </p>
                    </div>
                  </div>
                </div>
              </Card>

              {consolidationSaved && (
                <p className="text-sm text-emerald-400">Consolidation schedule saved and synced.</p>
              )}
              {consolidationError && <p className="text-sm text-brick-400">{consolidationError}</p>}

              <div className="flex items-center justify-end gap-3">
                <Button
                  disabled={triggering || !consolidation?.schedule.exists}
                  onClick={handleTriggerNow}
                  type="button"
                  variant="secondary"
                >
                  {triggering ? 'Triggering…' : 'Run now'}
                </Button>
                <Button disabled={updateConsolidation.isPending} type="submit" variant="primary">
                  {updateConsolidation.isPending ? 'Saving…' : 'Save schedule'}
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}
