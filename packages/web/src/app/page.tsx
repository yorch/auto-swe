'use client';

import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useWorkflows } from '@/hooks/useWorkflows';
import { formatRelativeTime } from '@/lib/utils';

export default function DashboardPage() {
  const { data: workflows, isLoading } = useWorkflows();

  if (isLoading) return <div className="text-center py-12 text-[var(--muted-foreground)]">Loading...</div>;

  const active = (workflows ?? []).filter((w: any) => !['COMPLETED', 'FAILED', 'TIMED_OUT'].includes(w.currentStatus));
  const completed = (workflows ?? []).filter((w: any) => w.currentStatus === 'COMPLETED');
  const failed = (workflows ?? []).filter((w: any) => w.currentStatus === 'FAILED');
  const needsAttention = (workflows ?? []).filter((w: any) =>
    ['AWAITING_HUMAN_MERGE', 'FAILED'].includes(w.currentStatus),
  );

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Dashboard</h2>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <div className="text-3xl font-bold text-[var(--primary)]">{active.length}</div>
          <div className="text-sm text-[var(--muted-foreground)]">Active Workflows</div>
        </Card>
        <Card>
          <div className="text-3xl font-bold text-[var(--success)]">{completed.length}</div>
          <div className="text-sm text-[var(--muted-foreground)]">Completed</div>
        </Card>
        <Card>
          <div className="text-3xl font-bold text-[var(--destructive)]">{failed.length}</div>
          <div className="text-sm text-[var(--muted-foreground)]">Failed</div>
        </Card>
        <Card>
          <div className="text-3xl font-bold text-[var(--warning)]">{needsAttention.length}</div>
          <div className="text-sm text-[var(--muted-foreground)]">Needs Attention</div>
        </Card>
      </div>

      {needsAttention.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Needs Attention</CardTitle></CardHeader>
          <div className="space-y-3">
            {needsAttention.map((w: any) => (
              <a key={w.id} href={`/workflows/${w.id}`} className="flex items-center justify-between p-3 rounded-md hover:bg-[var(--muted)]">
                <div>
                  <span className="font-medium">{w.repository?.repoName ?? 'Unknown'}</span>
                  <span className="text-sm text-[var(--muted-foreground)] ml-2">{w.assignedBranch}</span>
                </div>
                <StatusBadge status={w.currentStatus} />
              </a>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Recent Activity</CardTitle></CardHeader>
        <div className="space-y-2">
          {(workflows ?? []).slice(0, 10).map((w: any) => (
            <a key={w.id} href={`/workflows/${w.id}`} className="flex items-center justify-between p-2 rounded hover:bg-[var(--muted)]">
              <div className="flex items-center gap-3">
                <StatusBadge status={w.currentStatus} />
                <span className="text-sm">{w.repository?.repoName ?? 'Unknown'}</span>
              </div>
              <span className="text-xs text-[var(--muted-foreground)]">{formatRelativeTime(w.updatedAt)}</span>
            </a>
          ))}
        </div>
      </Card>
    </div>
  );
}
