import { Card } from '@/components/ui/Card';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { RelativeTime } from '@/components/ui/RelativeTime';
import type { CampaignSummary } from '@/hooks/useCampaigns';
import { CampaignStateBadge } from './CampaignStateBadge';
import {
  breakdownText,
  campaignProgress,
  PAUSED_REASON_LABELS,
  PLAN_LABELS,
  recipeSummary,
} from './campaignDisplay';

const COLUMNS: DataTableColumn<CampaignSummary>[] = [
  {
    cell: (campaign) => <span className="break-words">{campaign.name}</span>,
    header: 'Campaign',
    id: 'campaign',
    primary: true,
    secondary: (campaign) => (
      <span className="line-clamp-1 break-words">
        {campaign.plan === 'PLANNED' ? `${PLAN_LABELS.PLANNED} · ` : ''}
        {recipeSummary(campaign.recipeRef, campaign.recipeParams)}
      </span>
    ),
  },
  {
    cell: (campaign) => (
      <div>
        <CampaignStateBadge state={campaign.state} />
        {campaign.state === 'PAUSED' && campaign.pausedReason && (
          <span className="block text-xs text-paper-500">
            {PAUSED_REASON_LABELS[campaign.pausedReason]}
          </span>
        )}
      </div>
    ),
    header: 'Status',
    id: 'status',
  },
  {
    cell: (campaign) => {
      const progress = campaignProgress(campaign.counts);
      const rest = breakdownText(campaign.counts);
      return (
        <div>
          <span className="tabular text-paper-200">
            {progress.satisfied} of {progress.total} satisfied
          </span>
          {progress.needsAttention > 0 && (
            <span className="tabular block text-xs font-medium text-danger-400">
              {progress.needsAttention} {progress.needsAttention === 1 ? 'needs' : 'need'} attention
            </span>
          )}
          {rest && <span className="block text-xs text-paper-500">{rest}</span>}
        </div>
      );
    },
    header: 'Repositories',
    id: 'repositories',
  },
  {
    cell: (campaign) => <span className="text-paper-300">{campaign.ownerTeam?.name ?? '—'}</span>,
    header: 'Team',
    id: 'team',
  },
  {
    cell: (campaign) =>
      campaign.createdBy?.name ? (
        <span className="text-paper-300">{campaign.createdBy.name}</span>
      ) : (
        <span className="text-paper-500">—</span>
      ),
    header: 'Started by',
    id: 'started-by',
  },
  {
    cell: (campaign) => (
      <span className="whitespace-nowrap text-paper-400">
        <RelativeTime value={campaign.createdAt} />
      </span>
    ),
    header: 'Created',
    id: 'created',
  },
];

/** The campaigns list: one row per campaign, newest first. */
export function CampaignList({ campaigns }: { campaigns: CampaignSummary[] }) {
  // The gateway names the team and the starter only for some responses; a column of dashes is noise.
  const hasTeam = campaigns.some((c) => c.ownerTeam?.name);
  const hasStarter = campaigns.some((c) => c.createdBy?.name);
  const columns = COLUMNS.filter(
    (column) => (column.id !== 'team' || hasTeam) && (column.id !== 'started-by' || hasStarter)
  );
  return (
    <Card className="overflow-hidden p-0">
      <DataTable
        caption="Multi-repository campaigns, newest first"
        columns={columns}
        getRowId={(campaign) => campaign.id}
        rowHref={(campaign) => `/campaigns/${encodeURIComponent(campaign.id)}`}
        rows={campaigns}
      />
    </Card>
  );
}
