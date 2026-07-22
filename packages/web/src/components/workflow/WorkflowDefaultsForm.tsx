'use client';

import type { ReactNode } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { Textarea } from '@/components/ui/Textarea';
import {
  useUpdateWorkflowDefaultsConfig,
  useWorkflowDefaultsConfig,
  type WorkflowDefaultsConfig,
  type WorkflowDefaultsInput,
} from '@/hooks/useAdminConfig';
import { useConfigForm } from '@/hooks/useConfigForm';

// Flat form shape: one object instead of ~22 scalar useState hooks. Budgets are
// nested on the read payload (`budgetTiers`) but flat on the PUT body, so we
// flatten on load (`fromResolved`) and keep them flat in state.
interface FormState {
  branchPrefix: string;
  prTitleTemplate: string;
  prBodyTemplate: string;
  defaultTeamSlug: string;
  budgetStandardInputTokens: number;
  budgetStandardOutputTokens: number;
  budgetLargeInputTokens: number;
  budgetLargeOutputTokens: number;
  budgetEpicInputTokens: number;
  budgetEpicOutputTokens: number;
  maxTddIterations: number;
  maxEvalIterations: number;
  workspaceMemory: string;
  workspaceCpus: number;
  workspacePidsLimit: number;
  workspaceImage: string;
  lessonRetrievalLimit: number;
  lessonRetrievalThreshold: number;
  evalHealthMaxFlakeRate: number;
  evalHealthMaxStaleRate: number;
  evalHealthMinKappa: number;
  evalJudgeThreshold: number;
}

const DEFAULTS: FormState = {
  branchPrefix: '',
  budgetEpicInputTokens: 20_000_000,
  budgetEpicOutputTokens: 5_000_000,
  budgetLargeInputTokens: 8_000_000,
  budgetLargeOutputTokens: 2_000_000,
  budgetStandardInputTokens: 2_000_000,
  budgetStandardOutputTokens: 500_000,
  defaultTeamSlug: '',
  evalHealthMaxFlakeRate: 0.1,
  evalHealthMaxStaleRate: 0.1,
  evalHealthMinKappa: 0.4,
  evalJudgeThreshold: 0.5,
  lessonRetrievalLimit: 5,
  lessonRetrievalThreshold: 0.7,
  maxEvalIterations: 3,
  maxTddIterations: 5,
  prBodyTemplate: '',
  prTitleTemplate: '',
  workspaceCpus: 2,
  workspaceImage: 'node:24-alpine',
  workspaceMemory: '4g',
  workspacePidsLimit: 512,
};

// Seed the flat form from the resolved GET payload, flattening budgetTiers and
// falling back to the baked-in default for any field the server omits.
function fromResolved(data: WorkflowDefaultsConfig): FormState {
  const tiers = data.budgetTiers;
  return {
    branchPrefix: data.branchPrefix ?? DEFAULTS.branchPrefix,
    budgetEpicInputTokens: tiers?.EPIC.inputTokens ?? DEFAULTS.budgetEpicInputTokens,
    budgetEpicOutputTokens: tiers?.EPIC.outputTokens ?? DEFAULTS.budgetEpicOutputTokens,
    budgetLargeInputTokens: tiers?.LARGE.inputTokens ?? DEFAULTS.budgetLargeInputTokens,
    budgetLargeOutputTokens: tiers?.LARGE.outputTokens ?? DEFAULTS.budgetLargeOutputTokens,
    budgetStandardInputTokens: tiers?.STANDARD.inputTokens ?? DEFAULTS.budgetStandardInputTokens,
    budgetStandardOutputTokens: tiers?.STANDARD.outputTokens ?? DEFAULTS.budgetStandardOutputTokens,
    defaultTeamSlug: data.defaultTeamSlug ?? DEFAULTS.defaultTeamSlug,
    evalHealthMaxFlakeRate: data.evalHealthMaxFlakeRate ?? DEFAULTS.evalHealthMaxFlakeRate,
    evalHealthMaxStaleRate: data.evalHealthMaxStaleRate ?? DEFAULTS.evalHealthMaxStaleRate,
    evalHealthMinKappa: data.evalHealthMinKappa ?? DEFAULTS.evalHealthMinKappa,
    evalJudgeThreshold: data.evalJudgeThreshold ?? DEFAULTS.evalJudgeThreshold,
    lessonRetrievalLimit: data.lessonRetrievalLimit ?? DEFAULTS.lessonRetrievalLimit,
    lessonRetrievalThreshold: data.lessonRetrievalThreshold ?? DEFAULTS.lessonRetrievalThreshold,
    maxEvalIterations: data.maxEvalIterations ?? DEFAULTS.maxEvalIterations,
    maxTddIterations: data.maxTddIterations ?? DEFAULTS.maxTddIterations,
    prBodyTemplate: data.prBodyTemplate ?? DEFAULTS.prBodyTemplate,
    prTitleTemplate: data.prTitleTemplate ?? DEFAULTS.prTitleTemplate,
    workspaceCpus: data.workspaceCpus ?? DEFAULTS.workspaceCpus,
    workspaceImage: data.workspaceImage ?? DEFAULTS.workspaceImage,
    workspaceMemory: data.workspaceMemory ?? DEFAULTS.workspaceMemory,
    workspacePidsLimit: data.workspacePidsLimit ?? DEFAULTS.workspacePidsLimit,
  };
}

// Build the PUT body. Text fields are only sent when non-empty (unchanged from
// the original handler); the Tier-2 numeric knobs are always sent since they're
// seeded from the server and always carry a valid value.
function toBody(form: FormState): WorkflowDefaultsInput {
  const body: WorkflowDefaultsInput = {
    budgetEpicInputTokens: form.budgetEpicInputTokens,
    budgetEpicOutputTokens: form.budgetEpicOutputTokens,
    budgetLargeInputTokens: form.budgetLargeInputTokens,
    budgetLargeOutputTokens: form.budgetLargeOutputTokens,
    budgetStandardInputTokens: form.budgetStandardInputTokens,
    budgetStandardOutputTokens: form.budgetStandardOutputTokens,
    evalHealthMaxFlakeRate: form.evalHealthMaxFlakeRate,
    evalHealthMaxStaleRate: form.evalHealthMaxStaleRate,
    evalHealthMinKappa: form.evalHealthMinKappa,
    evalJudgeThreshold: form.evalJudgeThreshold,
    lessonRetrievalLimit: form.lessonRetrievalLimit,
    lessonRetrievalThreshold: form.lessonRetrievalThreshold,
    maxEvalIterations: form.maxEvalIterations,
    maxTddIterations: form.maxTddIterations,
    workspaceCpus: form.workspaceCpus,
    workspacePidsLimit: form.workspacePidsLimit,
  };
  if (form.branchPrefix) {
    body.branchPrefix = form.branchPrefix;
  }
  if (form.prTitleTemplate) {
    body.prTitleTemplate = form.prTitleTemplate;
  }
  if (form.prBodyTemplate) {
    body.prBodyTemplate = form.prBodyTemplate;
  }
  if (form.defaultTeamSlug) {
    body.defaultTeamSlug = form.defaultTeamSlug;
  }
  if (form.workspaceMemory) {
    body.workspaceMemory = form.workspaceMemory;
  }
  if (form.workspaceImage) {
    body.workspaceImage = form.workspaceImage;
  }
  return body;
}

// Numeric keys of FormState — the fields NumberField edits.
type NumericKey = {
  [K in keyof FormState]: FormState[K] extends number ? K : never;
}[keyof FormState];

/** A grouped block of Tier-2 fields with an uppercase caption. */
function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-3 text-xs uppercase tracking-wide text-paper-500">{label}</p>
      <div className="grid grid-cols-2 gap-4">{children}</div>
    </div>
  );
}

export function WorkflowDefaultsForm() {
  const { data, isLoading } = useWorkflowDefaultsConfig();
  const update = useUpdateWorkflowDefaultsConfig();
  const { form, setField, submit, saved, error } = useConfigForm({
    data,
    initial: DEFAULTS,
    mutateAsync: update.mutateAsync,
    toBody,
    toForm: fromResolved,
  });

  const num = (key: NumericKey) => (v: number) => setField(key, v);

  if (isLoading) {
    return <LoadingState message="Loading…" />;
  }

  return (
    <form className="space-y-6" onSubmit={submit}>
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Git &amp; PR">Branch and pull request templates</CardTitle>
        </CardHeader>
        <div className="space-y-4">
          <FieldWrapper
            hint={`Branches are created as ${form.branchPrefix || 'auto'}/<ticketId>.`}
            id="branch-prefix"
            label="Branch prefix"
          >
            <Input
              id="branch-prefix"
              onChange={(e) => setField('branchPrefix', e.target.value)}
              placeholder="auto"
              value={form.branchPrefix}
            />
          </FieldWrapper>

          <FieldWrapper
            hint="Available variables: {{ticketId}}, {{description}}."
            id="pr-title-template"
            label="PR title template"
          >
            <Input
              id="pr-title-template"
              onChange={(e) => setField('prTitleTemplate', e.target.value)}
              placeholder="[auto-swe] {{ticketId}}"
              value={form.prTitleTemplate}
            />
          </FieldWrapper>

          <FieldWrapper
            hint="Available variables: {{ticketId}}, {{description}}, {{prUrl}}. Leave blank to use system default."
            id="pr-body-template"
            label="PR body template"
          >
            <Textarea
              id="pr-body-template"
              onChange={(e) => setField('prBodyTemplate', e.target.value)}
              placeholder={
                'Resolves {{ticketId}}\n\n## Summary\n{{description}}\n\n---\n🤖 Implemented by auto-swe'
              }
              rows={6}
              value={form.prBodyTemplate}
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
            onChange={(e) => setField('defaultTeamSlug', e.target.value)}
            placeholder="default"
            value={form.defaultTeamSlug}
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
          <FieldGroup label="Per-tier token budgets">
            <NumberField
              hint="STANDARD tier input-token cap."
              id="budget-standard-input"
              label="Standard · input tokens"
              min={1}
              onChange={num('budgetStandardInputTokens')}
              value={form.budgetStandardInputTokens}
            />
            <NumberField
              hint="STANDARD tier output-token cap."
              id="budget-standard-output"
              label="Standard · output tokens"
              min={1}
              onChange={num('budgetStandardOutputTokens')}
              value={form.budgetStandardOutputTokens}
            />
            <NumberField
              hint="LARGE tier input-token cap."
              id="budget-large-input"
              label="Large · input tokens"
              min={1}
              onChange={num('budgetLargeInputTokens')}
              value={form.budgetLargeInputTokens}
            />
            <NumberField
              hint="LARGE tier output-token cap."
              id="budget-large-output"
              label="Large · output tokens"
              min={1}
              onChange={num('budgetLargeOutputTokens')}
              value={form.budgetLargeOutputTokens}
            />
            <NumberField
              hint="EPIC tier input-token cap."
              id="budget-epic-input"
              label="Epic · input tokens"
              min={1}
              onChange={num('budgetEpicInputTokens')}
              value={form.budgetEpicInputTokens}
            />
            <NumberField
              hint="EPIC tier output-token cap."
              id="budget-epic-output"
              label="Epic · output tokens"
              min={1}
              onChange={num('budgetEpicOutputTokens')}
              value={form.budgetEpicOutputTokens}
            />
          </FieldGroup>

          <FieldGroup label="Agent refine-loop caps">
            <NumberField
              hint="Implementer TDD refine-loop cap per run."
              id="max-tdd-iterations"
              label="Max TDD iterations"
              min={1}
              onChange={num('maxTddIterations')}
              value={form.maxTddIterations}
            />
            <NumberField
              hint="Eval-harness attempt cap."
              id="max-eval-iterations"
              label="Max eval iterations"
              min={1}
              onChange={num('maxEvalIterations')}
              value={form.maxEvalIterations}
            />
          </FieldGroup>

          <FieldGroup label="Ephemeral workspace container">
            <FieldWrapper hint="Docker memory limit, e.g. 4g." id="workspace-memory" label="Memory">
              <Input
                id="workspace-memory"
                onChange={(e) => setField('workspaceMemory', e.target.value)}
                placeholder="4g"
                value={form.workspaceMemory}
              />
            </FieldWrapper>
            <FieldWrapper
              hint="Default base image for workspace containers."
              id="workspace-image"
              label="Base image"
            >
              <Input
                id="workspace-image"
                onChange={(e) => setField('workspaceImage', e.target.value)}
                placeholder="node:24-alpine"
                value={form.workspaceImage}
              />
            </FieldWrapper>
            <NumberField
              hint="CPU quota (cores)."
              id="workspace-cpus"
              label="CPUs"
              min={0.1}
              onChange={num('workspaceCpus')}
              step={0.5}
              value={form.workspaceCpus}
            />
            <NumberField
              hint="Max process count (pids limit)."
              id="workspace-pids"
              label="PIDs limit"
              min={1}
              onChange={num('workspacePidsLimit')}
              value={form.workspacePidsLimit}
            />
          </FieldGroup>

          <FieldGroup label="Lesson retrieval">
            <NumberField
              hint="Max lessons retrieved per run."
              id="lesson-retrieval-limit"
              label="Retrieval limit"
              min={1}
              onChange={num('lessonRetrievalLimit')}
              value={form.lessonRetrievalLimit}
            />
            <NumberField
              hint="Cosine similarity floor (0–1)."
              id="lesson-retrieval-threshold"
              label="Retrieval threshold"
              max={1}
              min={0}
              onChange={num('lessonRetrievalThreshold')}
              step={0.01}
              value={form.lessonRetrievalThreshold}
            />
          </FieldGroup>

          <FieldGroup label="Eval health gate &amp; judge thresholds">
            <NumberField
              hint="Max acceptable flake rate (0–1)."
              id="eval-health-flake"
              label="Max flake rate"
              max={1}
              min={0}
              onChange={num('evalHealthMaxFlakeRate')}
              step={0.01}
              value={form.evalHealthMaxFlakeRate}
            />
            <NumberField
              hint="Max acceptable stale rate (0–1)."
              id="eval-health-stale"
              label="Max stale rate"
              max={1}
              min={0}
              onChange={num('evalHealthMaxStaleRate')}
              step={0.01}
              value={form.evalHealthMaxStaleRate}
            />
            <NumberField
              hint="Minimum inter-rater kappa (0–1)."
              id="eval-health-kappa"
              label="Min kappa"
              max={1}
              min={0}
              onChange={num('evalHealthMinKappa')}
              step={0.01}
              value={form.evalHealthMinKappa}
            />
            <NumberField
              hint="LLM-judge pass threshold (0–1)."
              id="eval-judge-threshold"
              label="Judge threshold"
              max={1}
              min={0}
              onChange={num('evalJudgeThreshold')}
              step={0.01}
              value={form.evalJudgeThreshold}
            />
          </FieldGroup>
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
  );
}

/** A labelled numeric input — the repeated FieldWrapper+Input(type=number) block. */
function NumberField({
  id,
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <FieldWrapper hint={hint} id={id} label={label}>
      <Input
        id={id}
        max={max}
        min={min}
        onChange={(e) => onChange(Number(e.target.value))}
        step={step}
        type="number"
        value={value}
      />
    </FieldWrapper>
  );
}
