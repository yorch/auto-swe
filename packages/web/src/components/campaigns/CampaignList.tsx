import { Card } from '@/components/ui/Card';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { StatusBadge } from '@/components/ui/StatusBadge';
import type { CampaignSummary } from '@/hooks/useCampaigns';
import { countsText, finishedTargets, recipeSummary, totalTargets } from './campaignDisplay';

const COLUMNS: DataTableColumn<CampaignSummary>[] = [
  {
    cell: (campaign) => <span className="break-words">{campaign.name}</span>,
    header: 'Campaign',
    id: 'campaign',
    primary: true,
    secondary: (campaign) => (
      <span className="line-clamp-1 break-words">
        {recipeSummary(campaign.recipeRef, campaign.recipeParams)}
      </span>
    ),
  },
  { cell: (campaign) => <StatusBadge status={campaign.state} />, header: 'Status', id: 'status' },
  {
    cell: (campaign) => (
      <div>
        <span className="tabular text-paper-200">
          {finishedTargets(campaign.counts)} of {totalTargets(campaign.counts)} done
        </span>
        <span className="block text-xs text-paper-500">{countsText(campaign.counts)}</span>
      </div>
    ),
    header: 'Repositories',
    id: 'repositories',
  },
  {
    cell: (campaign) => <span className="text-paper-300">{campaign.ownerTeam.name}</span>,
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
  return (
    <Card className="overflow-hidden p-0">
      <DataTable
        caption="Multi-repository campaigns, newest first"
        columns={COLUMNS}
        getRowId={(campaign) => campaign.id}
        rowHref={(campaign) => `/campaigns/${encodeURIComponent(campaign.id)}`}
        rows={campaigns}
      />
    </Card>
  );
}
