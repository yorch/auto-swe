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
  useCanaryConfig,
  useConsolidationConfig,
  useRevalidationConfig,
  useUpdateCanaryConfig,
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

  // Tier-2 resource & tuning defaults (GLOBAL). Seeded from the resolved GET
  // payload; sent back as flat fields on the PUT body.
  const [budgetStandardInputTokens, setBudgetStandardInputTokens] = useState(2_000_000);
  const [budgetStandardOutputTokens, setBudgetStandardOutputTokens] = useState(500_000);
  const [budgetLargeInputTokens, setBudgetLargeInputTokens] = useState(8_000_000);
  const [budgetLargeOutputTokens, setBudgetLargeOutputTokens] = useState(2_000_000);
  const [budgetEpicInputTokens, setBudgetEpicInputTokens] = useState(20_000_000);
  const [budgetEpicOutputTokens, setBudgetEpicOutputTokens] = useState(5_000_000);
  const [maxTddIterations, setMaxTddIterations] = useState(5);
  const [maxEvalIterations, setMaxEvalIterations] = useState(3);
  const [workspaceMemory, setWorkspaceMemory] = useState('4g');
  const [workspaceCpus, setWorkspaceCpus] = useState(2);
  const [workspacePidsLimit, setWorkspacePidsLimit] = useState(512);
  const [workspaceImage, setWorkspaceImage] = useState('node:24-alpine');
  const [lessonRetrievalLimit, setLessonRetrievalLimit] = useState(5);
  const [lessonRetrievalThreshold, setLessonRetrievalThreshold] = useState(0.7);
  const [evalHealthMaxFlakeRate, setEvalHealthMaxFlakeRate] = useState(0.1);
  const [evalHealthMaxStaleRate, setEvalHealthMaxStaleRate] = useState(0.1);
  const [evalHealthMinKappa, setEvalHealthMinKappa] = useState(0.4);
  const [evalJudgeThreshold, setEvalJudgeThreshold] = useState(0.5);

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

  // Canary state
  const { data: canary, isLoading: canaryLoading } = useCanaryConfig();
  const updateCanary = useUpdateCanaryConfig();
  const [canaryEnabled, setCanaryEnabled] = useState(false);
  const [canaryAgentKey, setCanaryAgentKey] = useState('');
  const [canaryCandidateVersion, setCanaryCandidateVersion] = useState(2);
  const [canaryPercent, setCanaryPercent] = useState(0);
  const [canarySaved, setCanarySaved] = useState(false);
  const [canaryError, setCanaryError] = useState<string | null>(null);

  useEffect(() => {
    if (!canary) {
      return;
    }
    setCanaryEnabled(canary.enabled);
    setCanaryAgentKey(canary.agentKey ?? '');
    setCanaryCandidateVersion(canary.candidateVersion ?? 2);
    setCanaryPercent(canary.percent ?? 0);
  }, [canary]);

  // Seed form from loaded data (once)
  useEffect(() => {
    if (!data) {
      return;
    }
    setBranchPrefix(data.branchPrefix ?? '');
    setPrTitleTemplate(data.prTitleTemplate ?? '');
    setPrBodyTemplate(data.prBodyTemplate ?? '');
    setDefaultTeamSlug(data.defaultTeamSlug ?? '');

    const tiers = data.budgetTiers;
    if (tiers) {
      setBudgetStandardInputTokens(tiers.STANDARD.inputTokens);
      setBudgetStandardOutputTokens(tiers.STANDARD.outputTokens);
      setBudgetLargeInputTokens(tiers.LARGE.inputTokens);
      setBudgetLargeOutputTokens(tiers.LARGE.outputTokens);
      setBudgetEpicInputTokens(tiers.EPIC.inputTokens);
      setBudgetEpicOutputTokens(tiers.EPIC.outputTokens);
    }
    if (data.maxTddIterations !== undefined) {
      setMaxTddIterations(data.maxTddIterations);
    }
    if (data.maxEvalIterations !== undefined) {
      setMaxEvalIterations(data.maxEvalIterations);
    }
    if (data.workspaceMemory !== undefined) {
      setWorkspaceMemory(data.workspaceMemory);
    }
    if (data.workspaceCpus !== undefined) {
      setWorkspaceCpus(data.workspaceCpus);
    }
    if (data.workspacePidsLimit !== undefined) {
      setWorkspacePidsLimit(data.workspacePidsLimit);
    }
    if (data.workspaceImage !== undefined) {
      setWorkspaceImage(data.workspaceImage);
    }
    if (data.lessonRetrievalLimit !== undefined) {
      setLessonRetrievalLimit(data.lessonRetrievalLimit);
    }
    if (data.lessonRetrievalThreshold !== undefined) {
      setLessonRetrievalThreshold(data.lessonRetrievalThreshold);
    }
    if (data.evalHealthMaxFlakeRate !== undefined) {
      setEvalHealthMaxFlakeRate(data.evalHealthMaxFlakeRate);
    }
    if (data.evalHealthMaxStaleRate !== undefined) {
      setEvalHealthMaxStaleRate(data.evalHealthMaxStaleRate);
    }
    if (data.evalHealthMinKappa !== undefined) {
      setEvalHealthMinKappa(data.evalHealthMinKappa);
    }
    if (data.evalJudgeThreshold !== undefined) {
      setEvalJudgeThreshold(data.evalJudgeThreshold);
    }
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

    // Tier-2 knobs — always sent (number inputs are seeded from the server, so
    // they carry valid values). Budgets are flattened out of the nested read shape.
    body.budgetStandardInputTokens = budgetStandardInputTokens;
    body.budgetStandardOutputTokens = budgetStandardOutputTokens;
    body.budgetLargeInputTokens = budgetLargeInputTokens;
    body.budgetLargeOutputTokens = budgetLargeOutputTokens;
    body.budgetEpicInputTokens = budgetEpicInputTokens;
    body.budgetEpicOutputTokens = budgetEpicOutputTokens;
    body.maxTddIterations = maxTddIterations;
    body.maxEvalIterations = maxEvalIterations;
    if (workspaceMemory) {
      body.workspaceMemory = workspaceMemory;
    }
    body.workspaceCpus = workspaceCpus;
    body.workspacePidsLimit = workspacePidsLimit;
    if (workspaceImage) {
      body.workspaceImage = workspaceImage;
    }
    body.lessonRetrievalLimit = lessonRetrievalLimit;
    body.lessonRetrievalThreshold = lessonRetrievalThreshold;
    body.evalHealthMaxFlakeRate = evalHealthMaxFlakeRate;
    body.evalHealthMaxStaleRate = evalHealthMaxStaleRate;
    body.evalHealthMinKappa = evalHealthMinKappa;
    body.evalJudgeThreshold = evalJudgeThreshold;

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

  const handleCanarySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCanaryError(null);
    setCanarySaved(false);
    try {
      await updateCanary.mutateAsync({
        agentKey: canaryAgentKey || null,
        candidateVersion: canaryCandidateVersion || null,
        enabled: canaryEnabled,
        percent: canaryPercent,
      });
      setCanarySaved(true);
    } catch (err) {
      setCanaryError(err instanceof Error ? err.message : 'Failed to save');
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

            <Card>
              <CardHeader>
                <CardTitle eyebrow="Resources &amp; tuning">
                  Resource &amp; tuning defaults (Tier 2)
                </CardTitle>
              </CardHeader>
              <div className="space-y-6">
                <div>
                  <p className="mb-3 text-xs uppercase tracking-wide text-paper-500">
                    Per-tier token budgets
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <FieldWrapper
                      hint="STANDARD tier input-token cap."
                      id="budget-standard-input"
                      label="Standard · input tokens"
                    >
                      <Input
                        id="budget-standard-input"
                        min={1}
                        onChange={(e) => setBudgetStandardInputTokens(Number(e.target.value))}
                        type="number"
                        value={budgetStandardInputTokens}
                      />
                    </FieldWrapper>
                    <FieldWrapper
                      hint="STANDARD tier output-token cap."
                      id="budget-standard-output"
                      label="Standard · output tokens"
                    >
                      <Input
                        id="budget-standard-output"
                        min={1}
                        onChange={(e) => setBudgetStandardOutputTokens(Number(e.target.value))}
                        type="number"
                        value={budgetStandardOutputTokens}
                      />
                    </FieldWrapper>
                    <FieldWrapper
                      hint="LARGE tier input-token cap."
                      id="budget-large-input"
                      label="Large · input tokens"
                    >
                      <Input
                        id="budget-large-input"
                        min={1}
                        onChange={(e) => setBudgetLargeInputTokens(Number(e.target.value))}
                        type="number"
                        value={budgetLargeInputTokens}
                      />
                    </FieldWrapper>
                    <FieldWrapper
                      hint="LARGE tier output-token cap."
                      id="budget-large-output"
                      label="Large · output tokens"
                    >
                      <Input
                        id="budget-large-output"
                        min={1}
                        onChange={(e) => setBudgetLargeOutputTokens(Number(e.target.value))}
                        type="number"
                        value={budgetLargeOutputTokens}
                      />
                    </FieldWrapper>
                    <FieldWrapper
                      hint="EPIC tier input-token cap."
                      id="budget-epic-input"
                      label="Epic · input tokens"
                    >
                      <Input
                        id="budget-epic-input"
                        min={1}
                        onChange={(e) => setBudgetEpicInputTokens(Number(e.target.value))}
                        type="number"
                        value={budgetEpicInputTokens}
                      />
                    </FieldWrapper>
                    <FieldWrapper
                      hint="EPIC tier output-token cap."
                      id="budget-epic-output"
                      label="Epic · output tokens"
                    >
                      <Input
                        id="budget-epic-output"
                        min={1}
                        onChange={(e) => setBudgetEpicOutputTokens(Number(e.target.value))}
                        type="number"
                        value={budgetEpicOutputTokens}
                      />
                    </FieldWrapper>
                  </div>
                </div>

                <div>
                  <p className="mb-3 text-xs uppercase tracking-wide text-paper-500">
                    Agent refine-loop caps
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <FieldWrapper
                      hint="Implementer TDD refine-loop cap per run."
                      id="max-tdd-iterations"
                      label="Max TDD iterations"
                    >
                      <Input
                        id="max-tdd-iterations"
                        min={1}
                        onChange={(e) => setMaxTddIterations(Number(e.target.value))}
                        type="number"
                        value={maxTddIterations}
                      />
                    </FieldWrapper>
                    <FieldWrapper
                      hint="Eval-harness attempt cap."
                      id="max-eval-iterations"
                      label="Max eval iterations"
                    >
                      <Input
                        id="max-eval-iterations"
                        min={1}
                        onChange={(e) => setMaxEvalIterations(Number(e.target.value))}
                        type="number"
                        value={maxEvalIterations}
                      />
                    </FieldWrapper>
                  </div>
                </div>

                <div>
                  <p className="mb-3 text-xs uppercase tracking-wide text-paper-500">
                    Ephemeral workspace container
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <FieldWrapper
                      hint="Docker memory limit, e.g. 4g."
                      id="workspace-memory"
                      label="Memory"
                    >
                      <Input
                        id="workspace-memory"
                        onChange={(e) => setWorkspaceMemory(e.target.value)}
                        placeholder="4g"
                        value={workspaceMemory}
                      />
                    </FieldWrapper>
                    <FieldWrapper
                      hint="Default base image for workspace containers."
                      id="workspace-image"
                      label="Base image"
                    >
                      <Input
                        id="workspace-image"
                        onChange={(e) => setWorkspaceImage(e.target.value)}
                        placeholder="node:24-alpine"
                        value={workspaceImage}
                      />
                    </FieldWrapper>
                    <FieldWrapper hint="CPU quota (cores)." id="workspace-cpus" label="CPUs">
                      <Input
                        id="workspace-cpus"
                        min={0.1}
                        onChange={(e) => setWorkspaceCpus(Number(e.target.value))}
                        step={0.5}
                        type="number"
                        value={workspaceCpus}
                      />
                    </FieldWrapper>
                    <FieldWrapper
                      hint="Max process count (pids limit)."
                      id="workspace-pids"
                      label="PIDs limit"
                    >
                      <Input
                        id="workspace-pids"
                        min={1}
                        onChange={(e) => setWorkspacePidsLimit(Number(e.target.value))}
                        type="number"
                        value={workspacePidsLimit}
                      />
                    </FieldWrapper>
                  </div>
                </div>

                <div>
                  <p className="mb-3 text-xs uppercase tracking-wide text-paper-500">
                    Lesson retrieval
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <FieldWrapper
                      hint="Max lessons retrieved per run."
                      id="lesson-retrieval-limit"
                      label="Retrieval limit"
                    >
                      <Input
                        id="lesson-retrieval-limit"
                        min={1}
                        onChange={(e) => setLessonRetrievalLimit(Number(e.target.value))}
                        type="number"
                        value={lessonRetrievalLimit}
                      />
                    </FieldWrapper>
                    <FieldWrapper
                      hint="Cosine similarity floor (0–1)."
                      id="lesson-retrieval-threshold"
                      label="Retrieval threshold"
                    >
                      <Input
                        id="lesson-retrieval-threshold"
                        max={1}
                        min={0}
                        onChange={(e) => setLessonRetrievalThreshold(Number(e.target.value))}
                        step={0.01}
                        type="number"
                        value={lessonRetrievalThreshold}
                      />
                    </FieldWrapper>
                  </div>
                </div>

                <div>
                  <p className="mb-3 text-xs uppercase tracking-wide text-paper-500">
                    Eval health gate &amp; judge thresholds
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <FieldWrapper
                      hint="Max acceptable flake rate (0–1)."
                      id="eval-health-flake"
                      label="Max flake rate"
                    >
                      <Input
                        id="eval-health-flake"
                        max={1}
                        min={0}
                        onChange={(e) => setEvalHealthMaxFlakeRate(Number(e.target.value))}
                        step={0.01}
                        type="number"
                        value={evalHealthMaxFlakeRate}
                      />
                    </FieldWrapper>
                    <FieldWrapper
                      hint="Max acceptable stale rate (0–1)."
                      id="eval-health-stale"
                      label="Max stale rate"
                    >
                      <Input
                        id="eval-health-stale"
                        max={1}
                        min={0}
                        onChange={(e) => setEvalHealthMaxStaleRate(Number(e.target.value))}
                        step={0.01}
                        type="number"
                        value={evalHealthMaxStaleRate}
                      />
                    </FieldWrapper>
                    <FieldWrapper
                      hint="Minimum inter-rater kappa (0–1)."
                      id="eval-health-kappa"
                      label="Min kappa"
                    >
                      <Input
                        id="eval-health-kappa"
                        max={1}
                        min={0}
                        onChange={(e) => setEvalHealthMinKappa(Number(e.target.value))}
                        step={0.01}
                        type="number"
                        value={evalHealthMinKappa}
                      />
                    </FieldWrapper>
                    <FieldWrapper
                      hint="LLM-judge pass threshold (0–1)."
                      id="eval-judge-threshold"
                      label="Judge threshold"
                    >
                      <Input
                        id="eval-judge-threshold"
                        max={1}
                        min={0}
                        onChange={(e) => setEvalJudgeThreshold(Number(e.target.value))}
                        step={0.01}
                        type="number"
                        value={evalJudgeThreshold}
                      />
                    </FieldWrapper>
                  </div>
                </div>
              </div>
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

          {/* ── Canary routing ── */}
          <div className="mt-8">
            <h3 className="text-lg font-semibold">Canary routing</h3>
            <p className="mt-1 text-sm text-paper-400">
              Routes a configurable fraction of work-requests to a candidate agent version for A/B
              comparison (evals P2). Routing is deterministic — the same work-request ID always
              lands in the same arm. Takes effect immediately; no Temporal schedule needed.
            </p>
          </div>

          {canaryLoading ? (
            <p className="text-sm text-paper-400">Loading…</p>
          ) : (
            <form className="space-y-6" onSubmit={handleCanarySubmit}>
              <Card>
                <CardHeader>
                  <CardTitle eyebrow="A/B">Canary configuration</CardTitle>
                </CardHeader>
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <input
                      checked={canaryEnabled}
                      className="h-4 w-4 accent-ember-400"
                      id="canary-enabled"
                      onChange={(e) => setCanaryEnabled(e.target.checked)}
                      type="checkbox"
                    />
                    <label className="text-sm" htmlFor="canary-enabled">
                      Canary enabled
                    </label>
                  </div>

                  {canaryEnabled && canaryAgentKey && canaryCandidateVersion > 0 && (
                    <p className="rounded-[9px] border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
                      Warning: {Math.round(canaryPercent * 100)}% of work-requests will be routed to{' '}
                      <span className="font-mono">
                        {canaryAgentKey}@v{canaryCandidateVersion}
                      </span>{' '}
                      instead of the standard version.
                    </p>
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label
                        className="mb-1 block text-xs uppercase text-paper-500"
                        htmlFor="canary-agent-key"
                      >
                        Agent key
                      </label>
                      <input
                        className="w-full rounded-[9px] border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                        id="canary-agent-key"
                        onChange={(e) => setCanaryAgentKey(e.target.value)}
                        placeholder="implementer"
                        value={canaryAgentKey}
                      />
                      <p className="mt-1 text-[11px] text-paper-500">
                        Agent role under canary (e.g. <span className="font-mono">implementer</span>
                        ).
                      </p>
                    </div>

                    <div>
                      <label
                        className="mb-1 block text-xs uppercase text-paper-500"
                        htmlFor="canary-version"
                      >
                        Candidate version
                      </label>
                      <input
                        className="w-full rounded-[9px] border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                        id="canary-version"
                        min={1}
                        onChange={(e) => setCanaryCandidateVersion(Number(e.target.value))}
                        type="number"
                        value={canaryCandidateVersion}
                      />
                      <p className="mt-1 text-[11px] text-paper-500">
                        Agent library version number to route the canary arm to.
                      </p>
                    </div>
                  </div>

                  <div>
                    <label
                      className="mb-1 block text-xs uppercase text-paper-500"
                      htmlFor="canary-percent"
                    >
                      Canary percent (0.0 – 1.0)
                    </label>
                    <input
                      className="w-full rounded-[9px] border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                      id="canary-percent"
                      max={1}
                      min={0}
                      onChange={(e) => setCanaryPercent(Number(e.target.value))}
                      step={0.01}
                      type="number"
                      value={canaryPercent}
                    />
                    <p className="mt-1 text-[11px] text-paper-500">
                      Fraction of work-requests routed to the candidate. 0 = off, 1 = all.
                    </p>
                  </div>
                </div>
              </Card>

              {canarySaved && (
                <p className="text-sm text-emerald-400">Canary configuration saved.</p>
              )}
              {canaryError && <p className="text-sm text-brick-400">{canaryError}</p>}

              <div className="flex justify-end">
                <Button disabled={updateCanary.isPending} type="submit" variant="primary">
                  {updateCanary.isPending ? 'Saving…' : 'Save canary config'}
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}
