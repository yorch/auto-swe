'use client';

import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
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
  percent: number;
}

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
  const { data: canary, isLoading } = useCanaryConfig();
  const update = useUpdateCanaryConfig();
  const { form, setField, submit, saved, error } = useConfigForm({
    data: canary,
    initial: INITIAL,
    mutateAsync: update.mutateAsync,
    toBody,
    toForm,
  });

  return (
    <>
      <div className="mt-8">
        <h3 className="text-lg font-semibold">Canary routing</h3>
        <p className="mt-1 text-sm text-paper-400">
          Routes a configurable fraction of work-requests to a candidate agent version for A/B
          comparison (evals P2). Routing is deterministic — the same work-request ID always lands in
          the same arm. Takes effect immediately; no Temporal schedule needed.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-paper-400">Loading…</p>
      ) : (
        <form className="space-y-6" onSubmit={submit}>
          <Card>
            <CardHeader>
              <CardTitle eyebrow="A/B">Canary configuration</CardTitle>
            </CardHeader>
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <input
                  checked={form.enabled}
                  className="h-4 w-4 accent-ember-400"
                  id="canary-enabled"
                  onChange={(e) => setField('enabled', e.target.checked)}
                  type="checkbox"
                />
                <label className="text-sm" htmlFor="canary-enabled">
                  Canary enabled
                </label>
              </div>

              {form.enabled && form.agentKey && form.candidateVersion > 0 && (
                <p className="rounded-[9px] border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
                  Warning: {Math.round(form.percent * 100)}% of work-requests will be routed to{' '}
                  <span className="font-mono">
                    {form.agentKey}@v{form.candidateVersion}
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
                    onChange={(e) => setField('agentKey', e.target.value)}
                    placeholder="implementer"
                    value={form.agentKey}
                  />
                  <p className="mt-1 text-[11px] text-paper-500">
                    Agent role under canary (e.g. <span className="font-mono">implementer</span>).
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
                    onChange={(e) => setField('candidateVersion', Number(e.target.value))}
                    type="number"
                    value={form.candidateVersion}
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
                  onChange={(e) => setField('percent', Number(e.target.value))}
                  step={0.01}
                  type="number"
                  value={form.percent}
                />
                <p className="mt-1 text-[11px] text-paper-500">
                  Fraction of work-requests routed to the candidate. 0 = off, 1 = all.
                </p>
              </div>
            </div>
          </Card>

          {saved && <p className="text-sm text-moss-400">Canary configuration saved.</p>}
          {error && <p className="text-sm text-brick-400">{error}</p>}

          <div className="flex justify-end">
            <Button disabled={update.isPending} type="submit" variant="primary">
              {update.isPending ? 'Saving…' : 'Save canary config'}
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
