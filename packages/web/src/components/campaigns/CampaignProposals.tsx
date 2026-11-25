import type { CampaignProposalDto } from '@auto-swe/shared/lib/campaignApi';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { RelativeTime } from '@/components/ui/RelativeTime';

/**
 * Repositories discovery found that match the goal but that the person the campaign runs as is not
 * authorized to start work in. Nothing starts in them; each says why.
 */
export function CampaignProposals({ proposals }: { proposals: readonly CampaignProposalDto[] }) {
  if (proposals.length === 0) {
    return null;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle hint="Found by discovery but not authorized for the person this campaign runs as, so nothing starts in them.">
          Found, not started
        </CardTitle>
        <span className="tabular text-sm text-paper-400">{proposals.length}</span>
      </CardHeader>
      <ul className="divide-y divide-ink-600">
        {proposals.map((proposal) => (
          <li className="py-2.5 first:pt-0 last:pb-0" key={proposal.id}>
            <p className="break-words text-sm font-medium text-paper-100">
              {proposal.repoLabel ?? 'A repository you cannot see'}
            </p>
            <p className="mt-0.5 break-words text-xs text-paper-400">{proposal.reason}</p>
            <p className="mt-0.5 text-xs text-paper-500">
              Found <RelativeTime value={proposal.createdAt} />
              {proposal.decidedAt && (
                <>
                  {' · '}decided <RelativeTime value={proposal.decidedAt} />
                </>
              )}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
