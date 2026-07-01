'use client';

import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader, SectionHeader } from '@/components/ui/PageHeader';
import { Textarea } from '@/components/ui/Textarea';
import {
  triggerConsolidationNow,
  triggerRevalidationNow,
  useConsolidationConfig,
  useRevalidationConfig,
  useUpdateConsolidationConfig,
  useUpdateRevalidationConfig,
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

  // Re-validation state
  const { data: revalidation, isLoading: revalidationLoading } = useRevalidationConfig();
  const updateRevalidation = useUpdateRevalidationConfig();
  const [revalidationEnabled, setRevalidationEnabled] = useState(false);
  const [revalidationCron, setRevalidationCron] = useState('0 5 * * 0');
  const [revalidationDatasetSlug, setRevalidationDatasetSlug] = useState('');
  const [revalidationSaved, setRevalidationSaved] = useState(false);
  const [revalidationError, setRevalidationError] = useState<string | null>(null);
  const [triggeringRevalidation, setTriggeringRevalidation] = useState(false);

  useEffect(() => {
    if (!revalidation) {
      return;
    }
    setRevalidationEnabled(revalidation.enabled);
    setRevalidationCron(revalidation.cronExpression);
    setRevalidationDatasetSlug(revalidation.datasetSlug ?? '');
  }, [revalidation]);

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

  const handleRevalidationSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRevalidationError(null);
    setRevalidationSaved(false);
    try {
      await updateRevalidation.mutateAsync({
        cronExpression: revalidationCron,
        datasetSlug: revalidationDatasetSlug || null,
        enabled: revalidationEnabled,
      });
      setRevalidationSaved(true);
    } catch (err) {
      setRevalidationError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const handleTriggerRevalidationNow = async () => {
    setTriggeringRevalidation(true);
    try {
      await triggerRevalidationNow();
    } finally {
      setTriggeringRevalidation(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        subtitle="System-wide defaults applied to every new work request. Per-team overrides take precedence when set."
        title="Admin — Workflow defaults"
      />

      {isLoading ? (
        <LoadingState message="Loading…" />
      ) : (
        <>
          <form className="space-y-6" onSubmit={handleSubmit}>
            <Card>
              <CardHeader>
                <CardTitle eyebrow="Git &amp; PR">Branch and pull request templates</CardTitle>
              </CardHeader>
              <div className="space-y-4">
                <FieldWrapper
                  hint={`Branches are created as ${branchPrefix || 'auto'}/<ticketId>.`}
                  id="branch-prefix"
                  label="Branch prefix"
                >
                  <Input
                    id="branch-prefix"
                    onChange={(e) => setBranchPrefix(e.target.value)}
                    placeholder="auto"
                    value={branchPrefix}
                  />
                </FieldWrapper>

                <FieldWrapper
                  hint="Available variables: {{ticketId}}, {{description}}."
                  id="pr-title-template"
                  label="PR title template"
                >
                  <Input
                    id="pr-title-template"
                    onChange={(e) => setPrTitleTemplate(e.target.value)}
                    placeholder="[auto-swe] {{ticketId}}"
                    value={prTitleTemplate}
                  />
                </FieldWrapper>

                <FieldWrapper
                  hint="Available variables: {{ticketId}}, {{description}}, {{prUrl}}. Leave blank to use system default."
                  id="pr-body-template"
                  label="PR body template"
                >
                  <Textarea
                    id="pr-body-template"
                    onChange={(e) => setPrBodyTemplate(e.target.value)}
                    placeholder={
                      'Resolves {{ticketId}}\n\n## Summary\n{{description}}\n\n---\n🤖 Implemented by auto-swe'
                    }
                    rows={6}
                    value={prBodyTemplate}
                  />
                </FieldWrapper>
              </div>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle eyebrow="Teams">Default team</CardTitle>
              </CardHeader>
              <FieldWrapper
                hint="Work requests without an explicit team are assigned to this team."
                id="default-team-slug"
                label="Default team slug"
              >
                <Input
                  id="default-team-slug"
                  onChange={(e) => setDefaultTeamSlug(e.target.value)}
                  placeholder="default"
                  value={defaultTeamSlug}
                />
              </FieldWrapper>
            </Card>

            {saved && <Alert variant="success">Settings saved.</Alert>}
            {error && <Alert variant="error">{error}</Alert>}

            <div className="flex justify-end">
              <Button disabled={update.isPending} type="submit" variant="primary">
                {update.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>

          {/* ── Lesson Consolidation Schedule ── */}
          <SectionHeader
            className="mt-8"
            hint="periodically merges similar agent lessons"
            title="Lesson consolidation"
          />

          {consolidationLoading ? (
            <LoadingState message="Loading…" />
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

                  <FieldWrapper
                    hint="Standard 5-field cron. Default 0 3 * * 0 = Sundays at 03:00 UTC."
                    id="consolidation-cron"
                    label="Cron expression"
                  >
                    <Input
                      id="consolidation-cron"
                      onChange={(e) => setConsolidationCron(e.target.value)}
                      placeholder="0 3 * * 0"
                      value={consolidationCron}
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
                        onChange={(e) => setConsolidationMinClusterSize(Number(e.target.value))}
                        type="number"
                        value={consolidationMinClusterSize}
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
                        onChange={(e) =>
                          setConsolidationSimilarityThreshold(Number(e.target.value))
                        }
                        step={0.05}
                        type="number"
                        value={consolidationSimilarityThreshold}
                      />
                    </FieldWrapper>
                  </div>
                </div>
              </Card>

              {consolidationSaved && (
                <Alert variant="success">Consolidation schedule saved and synced.</Alert>
              )}
              {consolidationError && <Alert variant="error">{consolidationError}</Alert>}

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

          {/* ── Eval Re-validation Schedule ── */}
          <div className="mt-8">
            <h3 className="text-lg font-semibold">Eval re-validation</h3>
            <p className="mt-1 text-sm text-paper-400">
              Periodically re-runs each EvalCase&apos;s reference against current repo state to
              detect stale golden tests. Quarantines cases that no longer pass (not the agent&apos;s
              fault) and restores them when they pass again.
            </p>
          </div>

          {revalidationLoading ? (
            <p className="text-sm text-paper-400">Loading…</p>
          ) : (
            <form className="space-y-6" onSubmit={handleRevalidationSubmit}>
              <Card>
                <CardHeader>
                  <CardTitle eyebrow="Schedule">Re-validation schedule</CardTitle>
                </CardHeader>
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <input
                      checked={revalidationEnabled}
                      className="h-4 w-4 accent-ember-400"
                      id="revalidation-enabled"
                      onChange={(e) => setRevalidationEnabled(e.target.checked)}
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
                      onChange={(e) => setRevalidationCron(e.target.value)}
                      placeholder="0 5 * * 0"
                      value={revalidationCron}
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
                      onChange={(e) => setRevalidationDatasetSlug(e.target.value)}
                      placeholder="swe-implementer-golden"
                      value={revalidationDatasetSlug}
                    />
                    <p className="mt-1 text-[11px] text-paper-500">
                      Optional substring match against dataset slug. Blank = all datasets.
                    </p>
                  </div>
                </div>
              </Card>

              {revalidationSaved && (
                <p className="text-sm text-emerald-400">Re-validation schedule saved and synced.</p>
              )}
              {revalidationError && <p className="text-sm text-brick-400">{revalidationError}</p>}

              <div className="flex items-center justify-end gap-3">
                <Button
                  disabled={triggeringRevalidation || !revalidation?.schedule.exists}
                  onClick={handleTriggerRevalidationNow}
                  type="button"
                  variant="secondary"
                >
                  {triggeringRevalidation ? 'Triggering…' : 'Run now'}
                </Button>
                <Button disabled={updateRevalidation.isPending} type="submit" variant="primary">
                  {updateRevalidation.isPending ? 'Saving…' : 'Save schedule'}
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}
