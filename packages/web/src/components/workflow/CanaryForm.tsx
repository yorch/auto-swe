'use client';

import { Alert } from '@/components/ui/Alert';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SaveBar } from '@/components/ui/SaveBar';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  type CanaryConfig,
  type CanaryConfigInput,
  useCanaryConfig,
  useUpdateCanaryConfig,
} from '@/hooks/useAdminConfig';
import { useConfigForm } from '@/hooks/useConfigForm';

interface CanaryFormState {
  enabled: boolean;
  agentKey: string;
  candidateVersion: number;
  /** Stored as the API's 0–1 fraction; the input shows and edits it as a percent. */
  percent: number;
}

/** Fraction ↔ whole-number percent at the input boundary, without float noise (0.07 × 100). */
const toPercent = (fraction: number) => Math.round(fraction * 10_000) / 100;
const toFraction = (percent: number) => Math.round(percent * 100) / 10_000;

const INITIAL: CanaryFormState = {
  agentKey: '',
  candidateVersion: 2,
  enabled: false,
  percent: 0,
};

function toForm(data: CanaryConfig): CanaryFormState {
  return {
    agentKey: data.agentKey ?? '',
    candidateVersion: data.candidateVersion ?? 2,
    enabled: data.enabled,
    percent: data.percent ?? 0,
  };
}

function toBody(form: CanaryFormState): CanaryConfigInput {
  return {
    agentKey: form.agentKey || null,
    candidateVersion: form.candidateVersion || null,
    enabled: form.enabled,
    percent: form.percent,
  };
}

export function CanaryForm() {
  const { data: canary, error: loadError, isError, isLoading } = useCanaryConfig();
  const update = useUpdateCanaryConfig();
  const { form, setField, submit, saved, error, dirtyCount, discard } = useConfigForm({
    data: canary,
    initial: INITIAL,
    mutateAsync: update.mutateAsync,
    toBody,
    toForm,
  });

  return (
    <>
      <SectionHeader
        className="mt-8"
        hint="routes a share of work-requests to a candidate agent version"
        title="Canary routing"
      />
      <p className="mb-5 text-sm text-paper-400">
        Routes a configurable fraction of work-requests to a candidate agent version for A/B
        comparison. Routing is deterministic — the same work-request ID always lands in the same
        arm. Takes effect immediately; no Temporal schedule needed.
      </p>

      <QueryBoundary
        compact
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="the canary configuration"
      >
        <form className="space-y-6" onSubmit={submit}>
          <Card>
            <CardHeader>
              <CardTitle eyebrow="A/B">Canary configuration</CardTitle>
            </CardHeader>
            <div className="space-y-4">
              <ToggleSwitch
                checked={form.enabled}
                label="Canary enabled"
                onChange={() => setField('enabled', !form.enabled)}
              />

              {form.enabled && form.agentKey && form.candidateVersion > 0 && (
                <Alert variant="warning">
                  {toPercent(form.percent)}% of work-requests will be routed to{' '}
                  <span className="font-mono">
                    {form.agentKey}@v{form.candidateVersion}
                  </span>{' '}
                  instead of the standard version.
                </Alert>
              )}

              <div className="grid grid-cols-2 gap-4">
                <Input
                  hint="Agent role under canary (e.g. implementer)."
                  id="canary-agent-key"
                  label="Agent key"
                  onChange={(e) => setField('agentKey', e.target.value)}
                  placeholder="implementer"
                  value={form.agentKey}
                />

                <Input
                  hint="Agent library version number to route the canary arm to."
                  id="canary-version"
                  label="Candidate version"
                  min={1}
                  onChange={(e) => setField('candidateVersion', Number(e.target.value))}
                  type="number"
                  value={form.candidateVersion}
                />
              </div>

              <Input
                hint="Share of work-requests routed to the candidate. 0 = off, 100 = all."
                id="canary-percent"
                label="Canary percent"
                max={100}
                min={0}
                onChange={(e) => setField('percent', toFraction(Number(e.target.value)))}
                step={1}
                type="number"
                value={toPercent(form.percent)}
              />
            </div>
          </Card>

          <SaveBar
            dirtyCount={dirtyCount}
            error={error}
            onDiscard={discard}
            pending={update.isPending}
            saved={saved}
            savedMessage="Canary configuration saved."
          />
        </form>
      </QueryBoundary>
    </>
  );
}
