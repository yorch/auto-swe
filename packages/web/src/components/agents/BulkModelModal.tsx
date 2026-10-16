'use client';

import { useMemo, useState } from 'react';
import { ModelSpecPicker } from '@/components/modelConfig/ModelSpecPicker';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  type AgentRow,
  type BulkModelChange,
  type BulkModelPlan,
  type BulkModelRequest,
  type BulkModelStatus,
  useApplyBulkModel,
  usePreviewBulkModel,
} from '@/hooks/useAgentLibrary';
import { scopeLabel } from '@/lib/agentDisplay';
import { errMsg } from '@/lib/errors';

const TONE: Record<
  BulkModelStatus,
  'success' | 'neutral' | 'warning' | 'danger' | 'accent2' | 'muted'
> = {
  BLOCKED: 'danger',
  CONFLICT: 'accent2',
  ERROR: 'danger',
  INHERITS: 'neutral',
  NOOP: 'muted',
  OK: 'success',
  UNMATCHED: 'warning',
};

function PlanTable({ applied, plan }: { applied: boolean; plan: BulkModelPlan }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" role="status">
        <Badge tone="success">{plan.summary.ok} to change</Badge>
        <Badge tone="neutral">{plan.summary.inherits} follow a parent</Badge>
        {plan.summary.noop > 0 && <Badge tone="muted">{plan.summary.noop} already set</Badge>}
        {plan.summary.unmatched > 0 && (
          <Badge tone="warning">{plan.summary.unmatched} unmatched</Badge>
        )}
        {plan.summary.blocked > 0 && <Badge tone="danger">{plan.summary.blocked} blocked</Badge>}
        {plan.summary.conflict > 0 && (
          <Badge tone="accent2">{plan.summary.conflict} conflict</Badge>
        )}
        {plan.summary.error > 0 && <Badge tone="danger">{plan.summary.error} errors</Badge>}
      </div>
      <Table stacked>
        <THead>
          <Th variant="compact">Agent</Th>
          <Th variant="compact">Scope</Th>
          <Th variant="compact">Model</Th>
          <Th variant="compact">Status and notes</Th>
        </THead>
        <tbody>
          {plan.changes.map((change) => (
            <PlanRow applied={applied} change={change} key={change.id} />
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function PlanRow({ applied, change }: { applied: boolean; change: BulkModelChange }) {
  return (
    <TRow>
      <Td className="py-2 pr-3" primary>
        {/* An id whose row could not be read has no name or key; the id is what identifies it. */}
        <span className="font-medium">{change.name || change.id}</span>
        {change.key && <div className="font-mono text-xs text-paper-500">{change.key}</div>}
      </Td>
      <Td className="py-2 pr-3" label="Scope">
        {change.scope ? (
          <Badge tone={change.scope === 'GLOBAL' ? 'neutral' : 'info'}>
            {scopeLabel(change.scope)}
          </Badge>
        ) : (
          <span className="text-paper-500">Unknown</span>
        )}
      </Td>
      <Td className="py-2 pr-3 font-mono text-xs" label="Model">
        <span>
          {change.from ?? '—'} → {change.to ?? '—'}
        </span>
        {change.runtimeChange && (
          <div className="mt-1 text-paper-400">
            Runtime: {change.runtimeChange.from ?? '—'} → {change.runtimeChange.to ?? '—'}
          </div>
        )}
        {change.credentialCleared && <div className="mt-1 text-paper-400">Credential cleared</div>}
        {applied && change.status === 'OK' && change.newVersion !== null && (
          <div className="mt-1 text-paper-400">Saved as v{change.newVersion}</div>
        )}
      </Td>
      <Td className="py-2 pr-3" label="Status and notes">
        <Badge tone={TONE[change.status]}>{change.status}</Badge>
        {change.blockers.length > 0 && (
          <ul className="mt-1 list-disc pl-4 text-xs text-danger-400">
            {change.blockers.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
        {change.warnings.length > 0 && (
          <ul className="mt-1 list-disc pl-4 text-xs text-warning-400">
            {change.warnings.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
        {change.shadowedBy.length > 0 && (
          <p className="mt-1 text-xs text-paper-400">
            A narrower override ({change.shadowedBy.join(', ')}) of the same key wins for runs in
            that scope, so this change does not reach them.
          </p>
        )}
        {change.inheritedFrom && (
          <p className="mt-1 text-xs text-paper-400">
            Follows {change.inheritedFrom}; this agent is not written.
          </p>
        )}
      </Td>
    </TRow>
  );
}

export function BulkModelModal({
  agents,
  open,
  onClose,
}: {
  agents: AgentRow[];
  open: boolean;
  onClose: () => void;
}) {
  const specs = useMemo(
    () => [...new Set(agents.map((a) => a.modelSpec).filter((x): x is string => Boolean(x)))],
    [agents]
  );
  const [mode, setMode] = useState<'SET' | 'REMAP'>('SET');
  const [modelSpec, setModelSpec] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [adaptRuntime, setAdaptRuntime] = useState(false);
  const [clearMismatchedCredentials, setClearMismatchedCredentials] = useState(false);
  // A plan belongs to the inputs that produced it, the selected agents included — they are part of
  // the request. Keying it that way means a preview that lands after the operator has edited
  // something, or after a refetch changed the selection, is never shown and never applied, without
  // every input having to remember to invalidate it.
  const inputsKey = JSON.stringify([
    agents.map((agent) => agent.id),
    mode,
    modelSpec,
    mapping,
    adaptRuntime,
    clearMismatchedCredentials,
  ]);
  const [previewed, setPreviewed] = useState<{
    body: BulkModelRequest;
    key: string;
    plan: BulkModelPlan;
  } | null>(null);
  const [appliedPlan, setAppliedPlan] = useState<BulkModelPlan | null>(null);
  const [auditWarnings, setAuditWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const preview = usePreviewBulkModel();
  const apply = useApplyBulkModel();

  function request(): BulkModelRequest {
    const body: BulkModelRequest = { ids: agents.map((a) => a.id), mode };
    if (mode === 'SET') {
      body.modelSpec = modelSpec;
    } else {
      body.mapping = Object.fromEntries(
        Object.entries(mapping).filter(([, value]) => value.trim())
      );
    }
    if (adaptRuntime) {
      body.adaptRuntime = true;
    }
    if (clearMismatchedCredentials) {
      body.clearMismatchedCredentials = true;
    }
    return body;
  }

  async function previewPlan() {
    setError(null);
    const body = request();
    try {
      const result = await preview.mutateAsync(body);
      // The result of an apply already on screen is not replaced by this: it outranks a preview,
      // and the dialog is remounted per opening, so nothing else has to clear it.
      setPreviewed({ body, key: inputsKey, plan: result });
    } catch (e) {
      setError(errMsg(e, 'Preview failed'));
    }
  }

  async function applyPlan() {
    setError(null);
    if (!activePreview) {
      return;
    }
    try {
      const result = await apply.mutateAsync(activePreview.body);
      setAppliedPlan(result.data);
      setAuditWarnings(result.auditWarnings ?? []);
    } catch (e) {
      setError(errMsg(e, 'Apply failed'));
    }
  }

  /** The preview whose inputs still match the form; null once anything is edited. */
  const activePreview = previewed?.key === inputsKey ? previewed : null;
  const plan = activePreview?.plan ?? null;
  const shownPlan = appliedPlan ?? plan;
  // REMAP with nothing filled would send an empty mapping, which the gateway refuses.
  const canPreview =
    mode === 'SET'
      ? Boolean(modelSpec.trim())
      : Object.values(mapping).some((value) => value.trim());
  return (
    <Modal
      // Escape and a backdrop click bypass the footer's disabled button, so they are what actually
      // has to be held shut while a batch is being written: the report of a partial success is the
      // only place the operator learns which agents landed.
      dismissible={!apply.isPending}
      onClose={onClose}
      open={open}
      size="full"
      subtitle="Review every affected agent before saving. Each saved change creates a new agent version."
      title="Change agent models"
    >
      <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
        {error && <Alert variant="error">{error}</Alert>}
        {auditWarnings.length > 0 && (
          <Alert variant="warning">
            These changes are applied, but their audit entries could not be recorded:
            <ul className="mt-1 list-disc pl-5">
              {auditWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </Alert>
        )}
        {!appliedPlan && (
          <>
            <div className="space-y-3">
              <SegmentedControl
                ariaLabel="Model change mode"
                onChange={(v) => {
                  setMode(v);
                }}
                options={[
                  { label: 'Set one model', value: 'SET' },
                  { label: 'Map each model', value: 'REMAP' },
                ]}
                value={mode}
              />
              {mode === 'SET' ? (
                <ModelSpecPicker
                  kind="CHAT"
                  label="Target model"
                  onChange={(value) => {
                    setModelSpec(value);
                  }}
                  value={modelSpec}
                />
              ) : (
                <div className="space-y-3">
                  {specs.map((spec) => (
                    <div
                      className="grid gap-2 sm:grid-cols-[minmax(12rem,1fr)_2fr] sm:items-end"
                      key={spec}
                    >
                      <div className="font-mono text-xs text-paper-300">{spec}</div>
                      <ModelSpecPicker
                        kind="CHAT"
                        label={`Target for ${spec}`}
                        onChange={(value) => {
                          setMapping({ ...mapping, [spec]: value });
                        }}
                        value={mapping[spec] ?? ''}
                      />
                    </div>
                  ))}
                  <div className="grid gap-2 sm:grid-cols-[minmax(12rem,1fr)_2fr] sm:items-end">
                    <div className="text-sm text-paper-300">Any other model</div>
                    <ModelSpecPicker
                      kind="CHAT"
                      label="Catch-all target"
                      onChange={(value) => {
                        setMapping({ ...mapping, '*': value });
                      }}
                      placeholder="Applies to any other current model"
                      value={mapping['*'] ?? ''}
                    />
                  </div>
                  <p className="text-xs text-paper-500">
                    A model left blank here follows the catch-all when one is set, and is otherwise
                    left alone. The preview shows which of these agents that covers.
                  </p>
                </div>
              )}
            </div>
            <div className="space-y-3 border-t border-ink-600 pt-4">
              <Checkbox
                checked={adaptRuntime}
                hint="The harness speaks only the Anthropic API, so an agent on it cannot take another provider’s model unless it moves."
                label="Move Claude Code agents to the Mastra loop"
                onChange={(e) => {
                  setAdaptRuntime(e.target.checked);
                }}
              />
              <Checkbox
                checked={clearMismatchedCredentials}
                hint="The pin is dropped and the agent falls back to the provider’s default credential."
                label="Clear credentials pinned to another provider"
                onChange={(e) => {
                  setClearMismatchedCredentials(e.target.checked);
                }}
              />
            </div>
            <p className="text-xs leading-relaxed text-paper-500">
              Agents which inherit their model from another agent are not edited: they follow their
              parent. The preview lists each one with the agent it follows.
            </p>
            <div className="flex justify-end">
              <Button
                disabled={!canPreview || preview.isPending}
                onClick={previewPlan}
                variant="secondary"
              >
                {preview.isPending ? 'Previewing…' : 'Preview changes'}
              </Button>
            </div>
          </>
        )}
        {shownPlan && <PlanTable applied={Boolean(appliedPlan)} plan={shownPlan} />}
      </div>
      <ModalFooter
        cancelLabel={appliedPlan ? 'Done' : 'Close'}
        disabled={!plan || plan.summary.ok === 0}
        isPending={apply.isPending}
        onCancel={onClose}
        onSubmit={appliedPlan ? onClose : plan ? applyPlan : undefined}
        pendingLabel="Applying…"
        submitLabel={
          appliedPlan ? undefined : plan ? `Apply ${plan.summary.ok} changes` : undefined
        }
      />
    </Modal>
  );
}
