'use client';

import { use } from 'react';
import { useWorkflow } from '@/hooks/useWorkflows';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { formatDate } from '@/lib/utils';
import Link from 'next/link';

export default function WorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: workflow, isLoading } = useWorkflow(id);

  if (isLoading) return <div className="text-center py-12 text-[var(--muted-foreground)]">Loading...</div>;
  if (!workflow) return <div className="text-center py-12 text-[var(--muted-foreground)]">Workflow not found</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/workflows" className="text-[var(--primary)] hover:underline text-sm">&larr; Back</Link>
        <h2 className="text-2xl font-bold">{workflow.repository?.repoName ?? 'Workflow'}</h2>
        <StatusBadge status={workflow.currentStatus} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>Details</CardTitle></CardHeader>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-[var(--muted-foreground)]">Workflow ID</dt>
              <dd className="font-mono text-xs">{workflow.temporalWorkflowId}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--muted-foreground)]">Branch</dt>
              <dd>{workflow.assignedBranch}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--muted-foreground)]">Status</dt>
              <dd><StatusBadge status={workflow.currentStatus} /></dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--muted-foreground)]">Updated</dt>
              <dd>{formatDate(workflow.updatedAt)}</dd>
            </div>
          </dl>
        </Card>

        <Card>
          <CardHeader><CardTitle>Pull Requests</CardTitle></CardHeader>
          {(workflow.pullRequests ?? []).length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)]">No PRs yet</p>
          ) : (
            <div className="space-y-2">
              {workflow.pullRequests.map((pr) => (
                <div key={pr.id} className="flex items-center justify-between text-sm">
                  <span className="font-medium">PR #{pr.prNumber}</span>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={pr.ciStatus ?? 'PENDING'} />
                    <span className="text-xs text-[var(--muted-foreground)]">{pr.status}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {workflow.workRequest && (
        <Card>
          <CardHeader><CardTitle>Work Request</CardTitle></CardHeader>
          <p className="text-sm">{workflow.workRequest.description || workflow.workRequest.externalTicketId}</p>
        </Card>
      )}
    </div>
  );
}
