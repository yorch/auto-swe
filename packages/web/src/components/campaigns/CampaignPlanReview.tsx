'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { type CampaignDetail, useConfirmCampaign } from '@/hooks/useCampaigns';
import { GATE_LABELS, targetAnchor } from './campaignDisplay';
import { UpstreamNames } from './UpstreamNames';

const EDIT_UNAVAILABLE_ID = 'campaign-plan-edit-unavailable';

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
  campaign: Pick<CampaignDetail, 'gate' | 'id' | 'targets'>;
  /** Only the launcher may confirm (the gateway decides). */
  isLauncher: boolean;
}) {
  const [open, setOpen] = useState(false);
  const confirm = useConfirmCampaign(campaign.id);
  const targets = [...campaign.targets].sort((a, b) => a.position - b.position);
  const labels = new Map(targets.map((t) => [t.id, t.repoLabel]));
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
          <Button onClick={() => setOpen(true)} variant="primary">
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
          await confirm.mutateAsync();
        }}
        open={open}
        pendingLabel="Starting…"
        title="Start this campaign?"
      />
    </Card>
  );
}
