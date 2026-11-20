'use client';

import { useState } from 'react';
import { DecideJoinRequestDialog } from '@/components/teams/directory/DecideJoinRequestDialog';
import { JoinRequestItem } from '@/components/teams/directory/JoinRequestRow';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useDecideOrgJoinRequest, useOrgJoinRequests } from '@/hooks/useJoinRequests';
import { buildDecisionBody, type JoinRequestRow } from '@/lib/joinRequests';

/**
 * People who asked to join one of this organization's teams from outside it, after the team said
 * yes: an organization admin makes the last decision, and approving adds them to the organization
 * and the team together.
 */
export function OrgJoinApprovalsPanel({ orgId }: { orgId: string }) {
  const requests = useOrgJoinRequests(orgId);
  const decide = useDecideOrgJoinRequest(orgId);
  const [deciding, setDeciding] = useState<{
    decision: 'approve' | 'reject';
    row: JoinRequestRow;
  } | null>(null);
  const rows = requests.data ?? [];

  return (
    <Card className="p-4 sm:p-6">
      <CardHeader>
        <CardTitle>Approvals</CardTitle>
      </CardHeader>
      <p className="mb-3 text-sm text-paper-400">
        People outside this organization whose request to join one of its teams a team has already
        approved.
      </p>
      <QueryBoundary
        error={requests.error}
        isError={requests.isError}
        isFetching={requests.isFetching}
        isLoading={requests.isLoading}
        label="approvals"
        onRetry={() => void requests.refetch()}
        rows={2}
      >
        {rows.length === 0 ? (
          <p className="text-sm text-paper-500">No requests are waiting for approval.</p>
        ) : (
          <ul
            aria-label="Requests awaiting organization approval"
            className="divide-y divide-ink-600"
          >
            {rows.map((row) => (
              <li key={row.id}>
                <JoinRequestItem
                  actions={
                    <>
                      <Button onClick={() => setDeciding({ decision: 'reject', row })} size="sm">
                        Reject
                      </Button>
                      <Button
                        onClick={() => setDeciding({ decision: 'approve', row })}
                        size="sm"
                        variant="primary"
                      >
                        Approve
                      </Button>
                    </>
                  }
                  context={<>to join {row.teamName ?? 'a team'}</>}
                  row={row}
                />
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <DecideJoinRequestDialog
        decision={deciding?.decision ?? 'approve'}
        onClose={() => setDeciding(null)}
        onSubmit={async ({ note }) => {
          if (deciding) {
            await decide.mutateAsync({
              decision: deciding.decision,
              requestId: deciding.row.id,
              ...buildDecisionBody(note),
            });
          }
        }}
        open={deciding !== null}
        request={deciding?.row ?? null}
        teamName={deciding?.row.teamName ?? undefined}
      />
    </Card>
  );
}
