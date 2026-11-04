'use client';

import { type FormEvent, useCallback, useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { DocLink } from '@/components/ui/DocLink';
import { Input } from '@/components/ui/Input';
import { SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SaveBar } from '@/components/ui/SaveBar';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  type CanaryConfig,
  type CanaryConfigInput,
  useCanaryConfig,
  useUpdateCanaryConfig,
} from '@/hooks/useAdminConfig';
import { useAgentLibrary } from '@/hooks/useAgentLibrary';
import { useConfigForm } from '@/hooks/useConfigForm';
import { HELP_LINKS } from '@/lib/helpLinks';
import { NumberField } from './WorkflowDefaultsForm';

/** Routing this share of traffic (or going live at all) asks first. */
const CONFIRM_PERCENT = 50;

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
  const {
    data: canary,
    error: loadError,
    isError,
    isFetching,
    refetch,
    isLoading,
  } = useCanaryConfig();
  const update = useUpdateCanaryConfig();
  const { form, setField, submit, saved, error, dirtyCount, discard } = useConfigForm({
    data: canary,
    initial: INITIAL,
    mutateAsync: update.mutateAsync,
    toBody,
    toForm,
  });

  // The agent library supplies the keys and their versions, so a typo cannot route real traffic
  // to an agent or version that does not exist. If it cannot load, the free-text fields remain.
  const library = useAgentLibrary({ all: true, scope: 'GLOBAL' });
  const keys = useMemo(
    () => [...new Set((library.data ?? []).map((a) => a.key))].sort((a, b) => a.localeCompare(b)),
    [library.data]
  );
  const versions = useMemo(
    () =>
      (library.data ?? [])
        .filter((a) => a.key === form.agentKey)
        .map((a) => a.version)
        .sort((a, b) => b - a),
    [library.data, form.agentKey]
  );
  const pickLists = library.isSuccess;

  const [percentInvalid, setPercentInvalid] = useState(false);
  const onPercentValidity = useCallback((_id: string, invalid: boolean) => {
    setPercentInvalid(invalid);
  }, []);
  const [attempted, setAttempted] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Going live, or sending a large share, changes which agent real work runs on.
  const needsConfirm =
    form.enabled && (canary?.enabled !== true || toPercent(form.percent) >= CONFIRM_PERCENT);
  const incomplete = form.enabled && (!form.agentKey || !(form.candidateVersion > 0));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (percentInvalid || incomplete) {
      setAttempted(true);
      return;
    }
    setAttempted(false);
    if (needsConfirm) {
      setConfirmOpen(true);
      return;
    }
    void submit();
  };

  return (
    <>
      <SectionHeader
        className="mt-8"
        hint="Routes a share of work requests to a candidate agent version"
        title="Canary routing"
      />
      <p className="mb-5 text-sm text-paper-400">
        Routes a configurable fraction of work-requests to a candidate agent version for A/B
        comparison. Routing is deterministic — the same work-request ID always lands in the same
        arm. Takes effect immediately; no Temporal schedule needed.{' '}
        <DocLink label="How canary routing works" {...HELP_LINKS.canaryRouting} />
      </p>

      <QueryBoundary
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="the canary configuration"
        onRetry={() => void refetch()}
        rows={2}
        shape="form"
      >
        <form className="space-y-6" noValidate onSubmit={onSubmit}>
          <Card>
            <CardHeader>
              <CardTitle>Canary configuration</CardTitle>
            </CardHeader>
            <div className="space-y-4">
              <ToggleSwitch
                checked={form.enabled}
                label="Canary enabled"
                onChange={() => setField('enabled', !form.enabled)}
              />

              {form.enabled && !incomplete && (
                <Alert variant="warning">
                  {toPercent(form.percent)}% of work-requests will be routed to{' '}
                  <span className="font-mono">
                    {form.agentKey}@v{form.candidateVersion}
                  </span>{' '}
                  instead of the standard version.
                </Alert>
              )}
              {form.enabled && incomplete && (
                <Alert variant="info">
                  Choose the agent and candidate version to route to; nothing is routed until both
                  are set.
                </Alert>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {pickLists ? (
                  <Combobox
                    emptyMessage="No agent in the library matches."
                    error={attempted && !form.agentKey ? 'Choose an agent' : undefined}
                    hint="Agent role under canary, from the agent library."
                    id="canary-agent-key"
                    label="Agent key"
                    onChange={(key) => {
                      setField('agentKey', key);
                      // A version belongs to one agent; keep it only if the new agent has it.
                      const has = (library.data ?? []).some(
                        (a) => a.key === key && a.version === form.candidateVersion
                      );
                      if (!has) {
                        setField('candidateVersion', 0);
                      }
                    }}
                    options={(keys.includes(form.agentKey) || !form.agentKey
                      ? keys
                      : [form.agentKey, ...keys]
                    ).map((k) => ({ label: k, value: k }))}
                    placeholder="Choose an agent…"
                    value={form.agentKey}
                  />
                ) : (
                  <Input
                    hint="Agent role under canary (e.g. implementer). The agent library could not be loaded, so this is free text: check the key."
                    id="canary-agent-key"
                    label="Agent key"
                    onChange={(e) => setField('agentKey', e.target.value)}
                    placeholder="implementer"
                    value={form.agentKey}
                  />
                )}

                {pickLists ? (
                  <Select
                    disabled={!form.agentKey}
                    error={
                      attempted && form.agentKey && !(form.candidateVersion > 0)
                        ? 'Choose a version'
                        : undefined
                    }
                    hint="Agent library version to route the canary arm to."
                    id="canary-version"
                    label="Candidate version"
                    onChange={(v) => setField('candidateVersion', Number(v))}
                    options={versions.map((v) => ({ label: `v${v}`, value: String(v) }))}
                    placeholder={form.agentKey ? 'Choose a version…' : 'Choose an agent first'}
                    value={form.candidateVersion > 0 ? String(form.candidateVersion) : ''}
                  />
                ) : (
                  <Input
                    hint="Agent library version number to route the canary arm to."
                    id="canary-version"
                    label="Candidate version"
                    min={1}
                    onChange={(e) => setField('candidateVersion', Number(e.target.value))}
                    type="number"
                    value={form.candidateVersion}
                  />
                )}
              </div>

              <NumberField
                hint="Share of work-requests routed to the candidate. 0 = off (no runs are routed to the candidate), 100 = all."
                id="canary-percent"
                label="Canary percent"
                max={100}
                min={0}
                onChange={(p) => setField('percent', toFraction(p))}
                onValidityChange={onPercentValidity}
                step={1}
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
        <ConfirmModal
          confirmLabel="Route traffic"
          message={
            <>
              This sends {toPercent(form.percent)}% of new work requests to{' '}
              <span className="font-mono">
                {form.agentKey}@v{form.candidateVersion}
              </span>{' '}
              instead of the standard version, starting immediately. Set the percent to 0 or turn
              the canary off to stop.
            </>
          }
          onClose={() => setConfirmOpen(false)}
          onConfirm={async () => {
            await submit();
          }}
          open={confirmOpen}
          title="Route live traffic to the candidate?"
        />
      </QueryBoundary>
    </>
  );
}
