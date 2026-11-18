'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ReviewList } from '@/components/requests/LaunchSteps';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Input } from '@/components/ui/Input';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useRepositories } from '@/hooks/useRepositories';
import { useApprovePlan, useRejectPlan, useRunPlan, useSaveAsTemplate } from '@/hooks/useRunPlans';
import { type IdempotencyState, idempotencyFor } from '@/lib/agentRun';
import { connectionLabel } from '@/lib/connectionDisplay';
import {
  costNote,
  deliveryEffect,
  describePlanError,
  describeSaveError,
  expiryLabel,
  FEEDS_IMPLEMENTER_LABEL,
  formatUsd,
  MARKER_LABEL,
  type NodeMarker,
  type OutlineGroup,
  outlineGroups,
  type PlanErrorView,
  parseCost,
  parsePins,
  planSaveable,
  type RunPlanView,
  type SavedTemplate,
  SCRUBBED_PLAN_NOTICE,
} from '@/lib/runPlan';

const MARKER_TONE: Record<NodeMarker, BadgeTone> = {
  core: 'accent',
  free: 'neutral',
  injected: 'info',
  mandatory: 'accent2',
};

const STATUS_TONE: Record<string, BadgeTone> = {
  APPROVED: 'info',
  EXPIRED: 'neutral',
  LAUNCHED: 'success',
  PENDING: 'warning',
  REJECTED: 'danger',
};

/** A clock that ticks each 30 s so the expiry countdown stays honest without a timer per row. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** All text here comes from a model or a user: it is rendered as React text, never as markup. */
function Outline({ groups }: { groups: OutlineGroup[] }) {
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section aria-label={group.title} key={group.region}>
          <h4 className="text-sm font-medium text-paper-200">{group.title}</h4>
          <p className="mt-0.5 text-xs text-paper-500">{group.hint}</p>
          <ol className="mt-2 divide-y divide-ink-600 rounded-lg border border-ink-500/60 bg-ink-900/40">
            {group.nodes.map((node) => (
              <li
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
                data-testid="plan-node"
                key={node.id}
              >
                <span className="min-w-0 break-words font-medium text-paper-100">{node.title}</span>
                <span className="font-mono text-xs text-paper-500">
                  {node.step ?? node.type ?? ''}
                </span>
                <Badge className="ml-auto" tone={MARKER_TONE[node.marker]} variant="outline">
                  {MARKER_LABEL[node.marker]}
                </Badge>
                {node.action && (
                  <p
                    className="basis-full break-words text-xs text-paper-300"
                    data-testid="node-action"
                  >
                    {node.action}
                  </p>
                )}
                {node.reads && (
                  <p
                    className="basis-full break-words text-xs text-paper-400"
                    data-testid="node-reads"
                  >
                    {node.reads}
                  </p>
                )}
                {node.message && (
                  <p className="basis-full whitespace-pre-wrap break-words text-xs text-paper-400">
                    {node.message}
                  </p>
                )}
                {node.feedsImplementer && (
                  <span data-testid="feeds-implementer">
                    <Badge tone="warning" variant="outline">
                      {FEEDS_IMPLEMENTER_LABEL}
                    </Badge>
                  </span>
                )}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function ErrorAlert({ view }: { view: PlanErrorView }) {
  return (
    <Alert title={view.title} variant={view.drift ? 'warning' : 'error'}>
      <div>{view.message}</div>
      {view.hint && <div className="mt-1 opacity-80">{view.hint}</div>}
    </Alert>
  );
}

export function RunPlanPreview({
  onApproved,
  onBack,
  onRegenerate,
  planId,
}: {
  planId: string;
  onApproved: (workRequestId: string) => void;
  onBack: () => void;
  /** Start a new generation from this plan's goal. */
  onRegenerate: (plan: Pick<RunPlanView, 'intent' | 'connectionId' | 'agentKey'>) => void;
}) {
  const plan = useRunPlan(planId);
  const repos = useRepositories({ limit: 500 });
  const approve = useApprovePlan();
  const reject = useRejectPlan();
  const saveTemplate = useSaveAsTemplate();
  const now = useNow();
  const [saving, setSaving] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [saveFailure, setSaveFailure] = useState<PlanErrorView | null>(null);
  const [savedTemplate, setSavedTemplate] = useState<SavedTemplate | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<PlanErrorView | null>(null);
  const idempotency = useRef<IdempotencyState | null>(null);
  const deciding = useRef(false);

  const data = plan.data;
  const repo = data ? repos.data?.find((r) => r.id === data.connectionId) : undefined;
  const repoName = repo ? connectionLabel(repo) : (data?.connectionId ?? '');
  const expired = data
    ? data.status === 'PENDING' && expiryLabel(data.expiresAt, now) === 'Expired'
    : false;
  const actionable = data?.status === 'PENDING' && !expired && !failure?.drift;

  const doApprove = async () => {
    if (!data || deciding.current) {
      return;
    }
    deciding.current = true;
    // One key per approval of this plan: a retry after a dropped connection reuses it.
    idempotency.current = idempotencyFor(idempotency.current, { id: data.id });
    try {
      const result = await approve.mutateAsync({
        id: data.id,
        idempotencyKey: idempotency.current.key,
      });
      setFailure(null);
      onApproved(result.workRequestId);
    } catch (err) {
      setFailure(describePlanError(err));
    } finally {
      deciding.current = false;
      setConfirming(false);
    }
  };

  const specName = (spec: unknown): string => {
    const name = (spec as { name?: unknown } | null)?.name;
    return typeof name === 'string' ? name : '';
  };

  const openSave = () => {
    setTemplateName(specName(data?.spec).slice(0, 120));
    setSaveFailure(null);
    setSaving(true);
  };

  /** Failures stay in the dialog, in fixed wording; only success closes it. */
  const doSave = async () => {
    if (!data) {
      return;
    }
    const name = templateName.trim();
    try {
      const saved = await saveTemplate.mutateAsync({ id: data.id, ...(name ? { name } : {}) });
      setSavedTemplate(saved);
      setSaveFailure(null);
      setSaving(false);
    } catch (err) {
      setSaveFailure(describeSaveError(err));
    }
  };

  const doReject = async () => {
    if (!data) {
      return;
    }
    try {
      await reject.mutateAsync(data.id);
      setFailure(null);
    } catch (err) {
      setFailure(describePlanError(err));
    }
  };

  return (
    <QueryBoundary
      error={plan.error}
      isError={plan.isError}
      isFetching={plan.isFetching}
      isLoading={plan.isLoading}
      label="plan"
      onRetry={() => void plan.refetch()}
    >
      {data?.scrubbed && (
        <Card className="space-y-5" data-testid="plan-scrubbed">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-600 pb-4">
            <h2 className="text-lg font-semibold tracking-tight text-paper-50">Plan</h2>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={data.mode === 'delivering' ? 'accent' : 'accent2'} variant="outline">
                {data.mode === 'delivering' ? 'Delivers a pull request' : 'Output only'}
              </Badge>
              <Badge tone={STATUS_TONE[data.status] ?? 'neutral'} variant="outline">
                {data.status}
              </Badge>
            </div>
          </div>
          <Alert variant="info">{SCRUBBED_PLAN_NOTICE}.</Alert>
          <ReviewList
            items={[
              { label: 'Repository', value: repoName },
              ...(data.agentKey ? [{ label: 'Library agent', value: data.agentKey }] : []),
              { label: 'Delivery', value: deliveryEffect(data.mode) },
              { label: 'Model', value: data.model ?? 'Unknown' },
              { label: 'Estimated cost', value: formatUsd(parseCost(data.cost).totalUsd) },
              {
                label: 'Made',
                value: <RelativeTime value={data.createdAt} />,
              },
            ]}
          />
          <div className="flex flex-wrap justify-end gap-3 border-t border-ink-600 pt-4">
            <Button onClick={onBack} variant="ghost">
              Back
            </Button>
          </div>
        </Card>
      )}
      {data && !data.scrubbed && (
        <Card className="space-y-5" data-testid="plan-preview">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-600 pb-4">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight text-paper-50">
                Review the plan
              </h2>
              <p className="mt-1 text-sm text-paper-400">
                Nothing starts until you approve exactly this plan.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={data.mode === 'delivering' ? 'accent' : 'accent2'} variant="outline">
                {data.mode === 'delivering' ? 'Delivers a pull request' : 'Output only'}
              </Badge>
              <Badge tone={STATUS_TONE[data.status] ?? 'neutral'} variant="outline">
                {data.status}
              </Badge>
            </div>
          </div>

          {data.status === 'APPROVED' || data.status === 'LAUNCHED' ? (
            <Alert variant="success">This plan was approved and started.</Alert>
          ) : data.status === 'REJECTED' ? (
            <Alert variant="info">This plan was rejected. Nothing was started.</Alert>
          ) : data.status === 'EXPIRED' || expired ? (
            <Alert variant="warning">This plan expired. Generate a new one to continue.</Alert>
          ) : null}
          {failure && <ErrorAlert view={failure} />}
          {savedTemplate && (
            <Alert title="Saved as a draft template" variant="success">
              <div data-testid="saved-template">
                {savedTemplate.name} is a draft in your team’s workflow library. Another person must
                review it before it can be used.{' '}
                <Link className="underline" href={`/library/${savedTemplate.templateId}`}>
                  Open the draft
                </Link>
              </div>
            </Alert>
          )}

          <ReviewList
            items={[
              { label: 'Repository', value: repoName },
              ...(data.agentKey ? [{ label: 'Library agent', value: data.agentKey }] : []),
              { label: 'Your goal', multiline: true, value: data.intent },
              { label: 'Summary', multiline: true, value: data.summary || 'No summary' },
              {
                label: 'Delivery',
                value: deliveryEffect(data.mode),
              },
              { label: 'Model', value: data.model ?? 'Unknown' },
              {
                label: 'Expiry',
                value: (
                  <span>
                    {expiryLabel(data.expiresAt, now)} · made{' '}
                    <RelativeTime value={data.createdAt} />
                  </span>
                ),
              },
            ]}
          />

          <section aria-labelledby="plan-outline">
            <h3 className="mb-3 text-sm font-semibold text-paper-100" id="plan-outline">
              What will run
            </h3>
            <Outline groups={outlineGroups(data)} />
          </section>

          <CostSection plan={data} />

          {data.warnings.length > 0 && (
            <section aria-labelledby="plan-warnings">
              <h3 className="mb-2 text-sm font-semibold text-paper-100" id="plan-warnings">
                Warnings
              </h3>
              <ul className="space-y-2">
                {data.warnings.map((w) => (
                  <li
                    className="rounded-lg border border-warning-400/35 bg-warning-400/[0.07] px-3 py-2 text-sm text-paper-200"
                    key={`${w.source}:${w.code}:${w.nodeId ?? ''}:${w.message}`}
                  >
                    <span className="font-mono text-xs text-warning-400">{w.code}</span>
                    {w.nodeId && <span className="text-paper-500"> · {w.nodeId}</span>}
                    <div className="break-words">{w.message}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <PinsSection plan={data} />

          <div className="flex flex-wrap justify-end gap-3 border-t border-ink-600 pt-4">
            <Button onClick={onBack} variant="ghost">
              Back
            </Button>
            <Button onClick={() => onRegenerate(data)} variant="secondary">
              Regenerate
            </Button>
            {planSaveable(data, now) && (
              <Button onClick={openSave} variant="secondary">
                Save as workflow template
              </Button>
            )}
            {actionable && (
              <Button
                disabled={reject.isPending || approve.isPending}
                onClick={() => void doReject()}
                variant="secondary"
              >
                Reject
              </Button>
            )}
            {actionable && (
              <Button
                disabled={approve.isPending}
                onClick={() => setConfirming(true)}
                variant="primary"
              >
                Approve &amp; start
              </Button>
            )}
          </div>
          {saving && (
            <ConfirmModal
              closeOnConfirm={false}
              confirmLabel="Save draft"
              error={
                saveFailure && (
                  <div data-testid="save-failure">
                    <div className="font-medium">{saveFailure.title}</div>
                    <div>{saveFailure.message}</div>
                    {saveFailure.hint && <div className="mt-1 opacity-80">{saveFailure.hint}</div>}
                  </div>
                )
              }
              message={
                <div className="space-y-3 text-sm">
                  <p>
                    This saves the plan as a draft template in the plan’s team. A draft runs
                    nothing: someone other than you must review it before it can be promoted.
                  </p>
                  <Input
                    autoComplete="off"
                    data-autofocus=""
                    label="Template name"
                    maxLength={120}
                    onChange={(e) => setTemplateName(e.target.value)}
                    value={templateName}
                  />
                </div>
              }
              onClose={() => setSaving(false)}
              onConfirm={doSave}
              open
              pendingLabel="Saving…"
              title="Save as a workflow template?"
            />
          )}
          <ConfirmModal
            confirmLabel="Approve and start"
            message={
              <div className="space-y-3 text-sm">
                <p>Approving starts a run of exactly this plan.</p>
                <ReviewList
                  items={[
                    { label: 'Repository', value: repoName },
                    { label: 'Delivery', value: deliveryEffect(data.mode) },
                    {
                      label: 'Estimated cost',
                      value: `${formatUsd(parseCost(data.cost).totalUsd)} (estimate)`,
                    },
                  ]}
                />
              </div>
            }
            onClose={() => setConfirming(false)}
            onConfirm={doApprove}
            open={confirming}
            pendingLabel="Starting…"
            title="Approve and start this plan?"
          />
        </Card>
      )}
    </QueryBoundary>
  );
}

function CostSection({ plan }: { plan: RunPlanView }) {
  const cost = parseCost(plan.cost);
  return (
    <section aria-labelledby="plan-cost">
      <h3 className="mb-2 text-sm font-semibold text-paper-100" id="plan-cost">
        Cost estimate
      </h3>
      <p className="text-sm text-paper-200">
        <span className="tabular text-base font-medium text-paper-50" data-testid="plan-cost-total">
          {formatUsd(cost.totalUsd)}
        </span>{' '}
        <span className="text-paper-500">estimated</span>
      </p>
      <p className="mt-1 text-xs text-paper-400" data-testid="plan-cost-note">
        {costNote(cost)}
      </p>
      {cost.unpriced.length > 0 && (
        <details className="mt-2 text-xs text-paper-400">
          <summary className="cursor-pointer">Unpriced steps</summary>
          <ul className="mt-1 space-y-0.5 font-mono">
            {cost.unpriced.map((u) => (
              <li key={`${u.nodeId}:${u.reason}`}>
                {u.nodeId} · {u.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function PinsSection({ plan }: { plan: RunPlanView }) {
  const pins = parsePins(plan.agentPins);
  if (pins.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="plan-pins">
      <h3 className="mb-2 text-sm font-semibold text-paper-100" id="plan-pins">
        Pinned agent versions
      </h3>
      <p className="mb-2 text-xs text-paper-400">
        If any of these change before you approve, the plan is refused and must be regenerated.
      </p>
      <ul className="grid gap-1 font-mono text-xs text-paper-300 sm:grid-cols-2">
        {pins.map((p) => (
          <li key={p.agent}>
            {p.agent} <span className="text-paper-500">{p.pin}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
