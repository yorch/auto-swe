'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useMyJoinRequests, useWithdrawJoinRequest } from '@/hooks/useJoinRequests';
import {
  decisionErrorMessage,
  decisionNote,
  isOpenJoinRequest,
  type JoinRequestRow,
  joinCloseReasonText,
} from '@/lib/joinRequests';
import { teamRoleLabel } from '@/lib/roleLabels';
import { teamHref } from '@/lib/teamSpace';
import { JoinRequestStatusChip } from './JoinRequestStatusChip';

/** The caller's own requests, newest first, with the reviewers' notes and a way to withdraw. */
export function MyJoinRequestsPanel() {
  const requests = useMyJoinRequests();
  const withdraw = useWithdrawJoinRequest();
  const [confirming, setConfirming] = useState<JoinRequestRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = requests.data?.requests ?? [];

  return (
    <div className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <QueryBoundary
        error={requests.error}
        isError={requests.isError}
        isFetching={requests.isFetching}
        isLoading={requests.isLoading}
        label="your requests"
        onRetry={() => void requests.refetch()}
      >
        {rows.length === 0 ? (
          <EmptyState
            bordered
            hint="Find a team in the Directory and choose Request to join."
            icon="inbox"
            title="No requests yet"
          />
        ) : (
          <ul aria-label="Your join requests" className="space-y-3">
            {rows.map((r) => (
              <li key={r.id}>
                <RequestCard onWithdraw={() => setConfirming(r)} row={r} />
              </li>
            ))}
          </ul>
        )}
        {requests.data?.truncated && (
          <p className="text-xs text-paper-500">Showing your 200 most recent requests.</p>
        )}
      </QueryBoundary>
      <ConfirmModal
        confirmLabel="Withdraw request"
        dangerous
        message={`Withdraw your request to join ${confirming?.teamName ?? 'this team'}? You can ask again later.`}
        onClose={() => setConfirming(null)}
        onConfirm={async () => {
          if (!confirming) {
            return;
          }
          setError(null);
          try {
            await withdraw.mutateAsync(confirming.id);
          } catch (err) {
            setConfirming(null);
            setError(decisionErrorMessage(err, 'Could not withdraw the request'));
          }
        }}
        open={confirming !== null}
        title="Withdraw request?"
      />
    </div>
  );
}

function RequestCard({ onWithdraw, row }: { onWithdraw: () => void; row: JoinRequestRow }) {
  const note = decisionNote(row);
  const closed = joinCloseReasonText(row.closeReason);
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-paper-50">
            {row.status === 'APPROVED' && row.teamSlug ? (
              <Link className="hover:underline" href={teamHref(row.teamSlug)}>
                {row.teamName ?? 'Team'}
              </Link>
            ) : (
              (row.teamName ?? 'Team')
            )}
          </h3>
          <p className="text-xs text-paper-500">
            {row.orgName ? `${row.orgName} · ` : ''}Requested <RelativeTime value={row.createdAt} />
          </p>
        </div>
        <div className="flex items-center gap-2">
          <JoinRequestStatusChip closeReason={row.closeReason} status={row.status} />
          {isOpenJoinRequest(row.status) && (
            <Button
              aria-label={`Withdraw request to ${row.teamName ?? 'team'}`}
              onClick={onWithdraw}
              size="sm"
            >
              Withdraw
            </Button>
          )}
        </div>
      </div>
      {closed && !isOpenJoinRequest(row.status) && (
        <p className="mt-2 text-xs text-paper-400">{closed}</p>
      )}
      {row.message && <p className="mt-3 text-sm text-paper-400">“{row.message}”</p>}
      {row.status === 'APPROVED' && row.grantedRole && (
        <p className="mt-2 text-xs text-paper-400">Joined as {teamRoleLabel(row.grantedRole)}.</p>
      )}
      {note && (
        <p className="mt-2 text-sm text-paper-300">
          <span className="text-xs text-paper-500">Note from the {note.by}: </span>
          {note.note}
        </p>
      )}
    </Card>
  );
}
