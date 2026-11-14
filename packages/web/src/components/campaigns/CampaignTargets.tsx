import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataTable, TableLink } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusBadge } from '@/components/ui/StatusBadge';
import type { CampaignDetail, CampaignTarget } from '@/hooks/useCampaigns';
import { safeHttpUrl } from '@/lib/safeUrl';
import { finishedTargets, totalTargets } from './campaignDisplay';

const PATH_LABELS: Record<NonNullable<CampaignTarget['path']>, string> = {
  AGENT: 'Agent',
  NONE: 'No change',
  RECIPE: 'Recipe',
  RECIPE_THEN_AGENT: 'Recipe, then agent',
};

const VERIFICATION_LABELS: Record<NonNullable<CampaignTarget['verification']>, string> = {
  FAILED: 'Failed',
  NOT_RUN: 'Not run',
  PASSED: 'Passed',
};

/**
 * The per-repository outcomes of a campaign. A target links to its child run when the viewer can
 * read it (`runIdByWorkflowId`) and to the platform's review page for its draft pull request when
 * one is known (`reviewIdByConnection`); the host's own link is the fallback.
 */
export function CampaignTargets({
  campaign,
  reviewIdByConnection,
  runIdByWorkflowId,
}: {
  campaign: CampaignDetail;
  reviewIdByConnection: ReadonlyMap<string, string>;
  runIdByWorkflowId: ReadonlyMap<string, string>;
}) {
  const total = totalTargets(campaign.counts);
  const done = finishedTargets(campaign.counts);
  const percent = total ? Math.round((done / total) * 100) : 0;
  return (
    <Card className="overflow-hidden p-0">
      <CardHeader className="mb-0 px-5 pt-5 pb-3">
        <CardTitle>Repositories</CardTitle>
        <span className="tabular text-sm text-paper-400">
          {done} of {total} finished
        </span>
      </CardHeader>
      {total > 0 && (
        <div className="px-5 pb-4">
          <div
            aria-label="Repositories finished"
            aria-valuemax={total}
            aria-valuemin={0}
            aria-valuenow={done}
            className="h-1.5 w-full overflow-hidden rounded-full bg-ink-600"
            role="progressbar"
          >
            <div className="h-full rounded-full bg-accent-400" style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}
      {campaign.hiddenTargetCount > 0 && (
        <p className="px-5 pb-3 text-xs text-paper-500" data-testid="campaign-hidden-targets">
          {campaign.hiddenTargetCount}{' '}
          {campaign.hiddenTargetCount === 1 ? 'repository is' : 'repositories are'} not listed: you
          cannot reach {campaign.hiddenTargetCount === 1 ? 'it' : 'them'}. They count towards the
          totals.
        </p>
      )}
      <DataTable
        caption="Repositories in this campaign, in launch order"
        columns={[
          {
            cell: (target) => {
              const runId = target.childWorkflowId
                ? runIdByWorkflowId.get(target.childWorkflowId)
                : undefined;
              return runId ? (
                <TableLink href={`/runs/${encodeURIComponent(runId)}`}>
                  {target.repoLabel}
                </TableLink>
              ) : (
                target.repoLabel
              );
            },
            header: 'Repository',
            id: 'repository',
            primary: true,
            secondary: (target) =>
              target.state === 'FAILED' || target.state === 'SKIPPED' ? (
                target.failureReason ? (
                  <span className="line-clamp-2 break-words">{target.failureReason}</span>
                ) : null
              ) : null,
          },
          {
            cell: (target) => (
              <div>
                <StatusBadge status={target.state} />
                {target.liveStatus && (
                  <span className="block text-xs text-paper-500">
                    {target.liveStatus.replace(/_/g, ' ').toLowerCase()}
                  </span>
                )}
              </div>
            ),
            header: 'Status',
            id: 'status',
          },
          {
            cell: (target) =>
              target.path ? (
                <span className="text-paper-300">{PATH_LABELS[target.path]}</span>
              ) : (
                <span className="text-paper-500">—</span>
              ),
            header: 'Path',
            id: 'path',
          },
          {
            cell: (target) =>
              target.verification ? (
                <span className="text-paper-300">{VERIFICATION_LABELS[target.verification]}</span>
              ) : (
                <span className="text-paper-500">—</span>
              ),
            header: 'Verification',
            id: 'verification',
          },
          {
            cell: (target) => {
              const reviewId = target.connectionId
                ? reviewIdByConnection.get(target.connectionId)
                : undefined;
              const hostUrl = safeHttpUrl(target.prUrl);
              const label = target.prNumber !== null ? `#${target.prNumber}` : 'Pull request';
              if (reviewId) {
                return (
                  <TableLink href={`/pull-requests/${encodeURIComponent(reviewId)}`}>
                    {label}
                  </TableLink>
                );
              }
              if (hostUrl) {
                return (
                  <a
                    className="text-paper-100 underline-offset-2 hover:underline"
                    href={hostUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {label}
                  </a>
                );
              }
              return <span className="text-paper-500">—</span>;
            },
            header: 'Draft PR',
            id: 'pull-request',
          },
        ]}
        empty={
          <EmptyState
            hint="Repositories appear here as the campaign reaches them."
            icon="clock"
            title="No repositories to show"
          />
        }
        getRowId={(target) => `${target.position}`}
        revealActions={false}
        rows={campaign.targets}
      />
    </Card>
  );
}
