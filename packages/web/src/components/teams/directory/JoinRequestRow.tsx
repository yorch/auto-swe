import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { type JoinRequestRow as Row, requesterLabel } from '@/lib/joinRequests';
import { teamRoleLabel } from '@/lib/roleLabels';

/**
 * One request as a reviewer reads it: who, when, their message and whether it crosses
 * organizations; `actions` holds the decision buttons (or a note that none can be taken).
 */
export function JoinRequestItem({
  actions,
  context,
  row,
}: {
  actions?: ReactNode;
  /** What the request is for, when the list spans teams (the organization queue). */
  context?: ReactNode;
  row: Row;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm text-paper-100">
          <span className="font-medium">{requesterLabel(row)}</span>
          {context && <span className="text-paper-400"> {context}</span>}
        </p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-paper-500">
          <RelativeTime value={row.createdAt} />
          {row.requiresOrgApproval && (
            <Badge tone="info" variant="outline">
              Also needs organization approval
            </Badge>
          )}
        </p>
        {row.grantedRole && (
          <p className="text-xs text-paper-400">
            Role granted by the team:{' '}
            <span className="font-medium">{teamRoleLabel(row.grantedRole)}</span>
            {row.teamDecidedAt && (
              <>
                {' '}
                <RelativeTime value={row.teamDecidedAt} />
              </>
            )}
            {row.teamDecisionNote && (
              <span className="[overflow-wrap:anywhere]"> — “{row.teamDecisionNote}”</span>
            )}
          </p>
        )}
        {row.message && (
          <p className="text-sm text-paper-400 [overflow-wrap:anywhere]">“{row.message}”</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
