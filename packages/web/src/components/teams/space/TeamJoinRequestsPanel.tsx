'use client';

import Link from 'next/link';
import { useState } from 'react';
import { DecideJoinRequestDialog } from '@/components/teams/directory/DecideJoinRequestDialog';
import { JoinRequestItem } from '@/components/teams/directory/JoinRequestRow';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useCan, useOrgIdsCan, usePlatformAdmin } from '@/hooks/useCan';
import {
  useApproveTeamJoinRequest,
  useRejectTeamJoinRequest,
  useTeamJoinRequests,
  useTeamJoinRequestsAwaitingOrg,
} from '@/hooks/useJoinRequests';
import {
  approvalCompletesOrgStep,
  approvalRoleOptions,
  buildApproveBody,
  buildDecisionBody,
  type JoinRequestRow,
} from '@/lib/joinRequests';
import type { TeamRoleValue } from '@/lib/roleLabels';

/**
 * The team's open join requests, for those who hold `team.members.manage`. A request that is past
 * the team step and waits for the organization is listed read-only. The roles an approver may
 * name are the ones they may grant (`grantableRoles`, the same list the Add member form offers).
 */
export function TeamJoinRequestsPanel({
  grantableRoles,
  teamId,
  teamName,
}: {
  grantableRoles: readonly TeamRoleValue[];
  teamId: string;
  teamName: string;
}) {
  const pending = useTeamJoinRequests(teamId);
  const awaitingOrg = useTeamJoinRequestsAwaitingOrg(teamId);
  const approve = useApproveTeamJoinRequest(teamId);
  const reject = useRejectTeamJoinRequest(teamId);
  const [deciding, setDeciding] = useState<{
    decision: 'approve' | 'reject';
    row: JoinRequestRow;
  } | null>(null);
  const roles = approvalRoleOptions(grantableRoles);
  // Only the rows still at their step belong in each list, whatever a cached answer says.
  const waiting = (awaitingOrg.data ?? []).filter((r) => r.status === 'PENDING_ORG');
  const open = (pending.data ?? []).filter((r) => r.status === 'PENDING_TEAM');
  const orgOfDeciding = deciding?.row.requiresOrgApproval ? (deciding.row.orgId ?? null) : null;
  // `useCan` without an organization asks "in any"; the hint is only for the request's own.
  const managesOrg = useCan('org.members.manage', { orgId: orgOfDeciding ?? undefined });
  const orgsIManage = useOrgIdsCan('org.members.manage');
  const platformAdmin = usePlatformAdmin();
  const alsoCompletesOrgStep = approvalCompletesOrgStep(
    deciding?.row ?? null,
    !!orgOfDeciding && managesOrg
  );

  return (
    <Card className="p-4 sm:p-6">
      <CardHeader>
        <CardTitle>Join requests</CardTitle>
      </CardHeader>
      <QueryBoundary
        error={pending.error}
        isError={pending.isError}
        isFetching={pending.isFetching}
        isLoading={pending.isLoading}
        label="join requests"
        onRetry={() => void pending.refetch()}
        rows={2}
      >
        {open.length === 0 ? (
          <p className="text-sm text-paper-500">No requests are waiting for a decision.</p>
        ) : (
          <ul aria-label="Requests awaiting a team decision" className="divide-y divide-ink-600">
            {open.map((row) => (
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
                  row={row}
                />
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      {waiting.length > 0 && (
        <div className="mt-4 border-t border-ink-600 pt-4">
          <h3 className="text-xs font-medium tracking-wide text-paper-500 uppercase">
            Waiting for organization approval
          </h3>
          <ul
            aria-label="Requests awaiting organization approval"
            className="divide-y divide-ink-600"
          >
            {waiting.map((row) => (
              <li key={row.id}>
                <JoinRequestItem
                  actions={
                    <span className="text-xs text-paper-500">
                      Approved by the team; waiting for organization approval.{' '}
                      {row.orgId && (platformAdmin || orgsIManage?.has(row.orgId)) ? (
                        <Link
                          className="text-accent-400 underline"
                          href={`/admin/organizations/${row.orgId}`}
                        >
                          Decide in organization approvals
                        </Link>
                      ) : (
                        'An organization admin decides this step.'
                      )}
                    </span>
                  }
                  row={row}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      {awaitingOrg.isError && (
        <Alert variant="warning">Requests waiting for the organization could not be loaded.</Alert>
      )}
      <DecideJoinRequestDialog
        alsoCompletesOrgStep={alsoCompletesOrgStep}
        decision={deciding?.decision ?? 'approve'}
        onClose={() => setDeciding(null)}
        onSubmit={async ({ note, role }) => {
          if (!deciding) {
            return;
          }
          const requestId = deciding.row.id;
          if (deciding.decision === 'approve') {
            await approve.mutateAsync({
              requestId,
              ...buildApproveBody({ allowed: roles, note, role }),
            });
          } else {
            await reject.mutateAsync({ requestId, ...buildDecisionBody(note) });
          }
        }}
        open={deciding !== null}
        request={deciding?.row ?? null}
        roleOptions={roles}
        teamName={teamName}
      />
    </Card>
  );
}
