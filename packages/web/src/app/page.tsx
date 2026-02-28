'use client';

import { useMemo } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { WorkflowStatusChart } from '@/components/charts/WorkflowStatusChart';
import { WorkflowsOverTimeChart } from '@/components/charts/WorkflowsOverTimeChart';
import { WorkflowsByRepoChart } from '@/components/charts/WorkflowsByRepoChart';
import { useWorkflows } from '@/hooks/useWorkflows';
import { formatRelativeTime } from '@/lib/utils';
import {
  groupWorkflowsByStatus,
  groupWorkflowsByDate,
  groupWorkflowsByRepo,
} from '@/lib/chartUtils';

export default function DashboardPage() {
  const { data: workflows, isLoading } = useWorkflows();

  const all = workflows ?? [];
  const active = all.filter((w: any) => !['COMPLETED', 'FAILED', 'TIMED_OUT'].includes(w.currentStatus));
  const completed = all.filter((w: any) => w.currentStatus === 'COMPLETED');
  const failed = all.filter((w: any) => w.currentStatus === 'FAILED');
  const needsAttention = all.filter((w: any) =>
    ['AWAITING_HUMAN_MERGE', 'FAILED'].includes(w.currentStatus),
  );

  const statusData = useMemo(() => groupWorkflowsByStatus(all), [all]);
  const timeData = useMemo(() => groupWorkflowsByDate(all), [all]);
  const repoData = useMemo(() => groupWorkflowsByRepo(all), [all]);

  if (isLoading) return <div className="text-center py-12 text-[var(--muted-foreground)]">Loading...</div>;

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

      {/* Charts Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle>Workflow Status</CardTitle></CardHeader>
          <WorkflowStatusChart data={statusData} />
        </Card>
        <Card>
          <CardHeader><CardTitle>Workflows Over Time</CardTitle></CardHeader>
          <WorkflowsOverTimeChart data={timeData} />
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Workflows by Repository</CardTitle></CardHeader>
        <WorkflowsByRepoChart data={repoData} />
      </Card>

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
          {all.slice(0, 10).map((w: any) => (
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
