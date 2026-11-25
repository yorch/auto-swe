'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { type CampaignDetail, useConfirmCampaign } from '@/hooks/useCampaigns';
import { ApiError } from '@/lib/api';
import { GATE_LABELS, targetAnchor } from './campaignDisplay';
import { UpstreamNames } from './UpstreamNames';

const EDIT_UNAVAILABLE_ID = 'campaign-plan-edit-unavailable';
const CONFIRM_BLOCKED_ID = 'campaign-plan-confirm-blocked';

/** What the gateway's `CAMPAIGN_PLAN_NOT_READY` refusal means to the person who pressed Confirm. */
export const PLAN_NOT_READY_MESSAGE =
  'The plan is not ready: at least one repository has no brief yet. Wait for the planner to finish, or cancel this campaign and start it again.';

/**
 * What the planner decided, shown to the launcher before anything starts: one brief per
 * repository and the order between them. Confirming starts the campaign. Editing the briefs or the
 * edges has no route yet, so that control is shown disabled with the reason instead of being left
 * out, and the way to change a plan today is stated beside it.
 */
export function CampaignPlanReview({
  campaign,
  isLauncher,
}: {
  campaign: Pick<CampaignDetail, 'gate' | 'id' | 'planFailure' | 'targets'>;
  /** Only the launcher may confirm (the gateway decides). */
  isLauncher: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const confirm = useConfirmCampaign(campaign.id);
  const targets = [...campaign.targets].sort((a, b) => a.position - b.position);
  const labels = new Map(targets.map((t) => [t.id, t.repoLabel]));
  const planFailed = campaign.planFailure !== null && campaign.planFailure !== undefined;
  const missingBriefs = targets.filter((t) => !t.brief?.trim()).length;
  const blockedReason = planFailed
    ? 'Planning failed, so there is no plan to confirm. Cancel this campaign and start a new one.'
    : targets.length === 0
      ? 'There is no planned work to confirm yet.'
      : missingBriefs > 0
        ? `${missingBriefs} ${missingBriefs === 1 ? 'repository has' : 'repositories have'} no brief yet, so the plan cannot be confirmed.`
        : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle hint="The planner’s work for each repository. Nothing starts until the launcher confirms.">
          Plan
        </CardTitle>
        <span className="text-sm text-paper-400">
          A repository starts when {GATE_LABELS[campaign.gate].toLowerCase()}
        </span>
      </CardHeader>
      {campaign.planFailure && (
        <Alert className="mb-4" title="Planning failed" variant="error">
          Planning failed: {campaign.planFailure.reason}
        </Alert>
      )}
      {targets.length === 0 ? (
        <EmptyState
          hint="The planner has not written any work yet. Check again in a moment."
          icon="clock"
          title="No planned work to show"
        />
      ) : (
        <ol className="space-y-3">
          {targets.map((target) => (
            <li
              className="rounded-lg border border-ink-500/70 bg-ink-900/40 p-3"
              id={targetAnchor(target.id)}
              key={target.id}
            >
              <p className="break-words text-sm font-medium text-paper-100">{target.repoLabel}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-paper-300">
                {target.brief || (
                  <span className="text-paper-500">No brief for this repository</span>
                )}
              </p>
              <p className="mt-2 text-xs text-paper-500">
                {target.dependsOn.length > 0 ? (
                  <>
                    Starts after{' '}
                    <UpstreamNames labels={labels} linkable targetIds={target.dependsOn} />
                  </>
                ) : (
                  'Starts first: it waits for no other repository'
                )}
              </p>
            </li>
          ))}
        </ol>
      )}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {isLauncher ? (
          <Button
            aria-describedby={blockedReason ? CONFIRM_BLOCKED_ID : undefined}
            disabled={blockedReason !== null}
            onClick={() => {
              setRefusal(null);
              setOpen(true);
            }}
            variant="primary"
          >
            Confirm and start
          </Button>
        ) : (
          <p className="text-sm text-paper-400">
            Only the person who started this campaign can confirm it.
          </p>
        )}
        {isLauncher && (
          <Button aria-describedby={EDIT_UNAVAILABLE_ID} disabled>
            Edit before confirming
          </Button>
        )}
      </div>
      {isLauncher && blockedReason && (
        <p className="mt-2 text-sm text-warning-400" id={CONFIRM_BLOCKED_ID}>
          {blockedReason}
        </p>
      )}
      {refusal && (
        <p className="mt-2 text-sm text-danger-400" role="alert">
          {refusal}
        </p>
      )}
      {isLauncher && (
        <p className="mt-2 text-xs text-paper-500" id={EDIT_UNAVAILABLE_ID}>
          Editing the briefs or the order is not available yet. To change the plan, cancel this
          campaign and start a new one with a corrected brief.
        </p>
      )}
      <ConfirmModal
        confirmLabel="Confirm and start"
        message={
          <p>
            The campaign starts now. Repositories begin in the order above, and every pull request
            is opened as you.
          </p>
        }
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          try {
            await confirm.mutateAsync();
          } catch (err) {
            if (err instanceof ApiError && err.code === 'CAMPAIGN_PLAN_NOT_READY') {
              setRefusal(PLAN_NOT_READY_MESSAGE);
              return;
            }
            throw err;
          }
        }}
        open={open}
        pendingLabel="Starting…"
        title="Start this campaign?"
      />
    </Card>
  );
}
