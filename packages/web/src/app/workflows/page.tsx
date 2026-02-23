'use client';

import { useWorkflows } from '@/hooks/useWorkflows';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Card } from '@/components/ui/Card';
import { formatRelativeTime } from '@/lib/utils';
import Link from 'next/link';

export default function WorkflowsPage() {
  const { data: workflows, isLoading } = useWorkflows();

  if (isLoading) return <div className="text-center py-12 text-[var(--muted-foreground)]">Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Workflows</h2>
        <span className="text-sm text-[var(--muted-foreground)]">{(workflows ?? []).length} total</span>
      </div>

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--muted)]">
              <th className="text-left px-4 py-3 font-medium">Repository</th>
              <th className="text-left px-4 py-3 font-medium">Branch</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {(workflows ?? []).map((w: any) => (
              <tr key={w.id} className="border-b border-[var(--border)] hover:bg-[var(--muted)] transition-colors">
                <td className="px-4 py-3">
                  <Link href={`/workflows/${w.id}`} className="text-[var(--primary)] hover:underline font-medium">
                    {w.repository?.organizationName}/{w.repository?.repoName}
                  </Link>
                </td>
                <td className="px-4 py-3 text-[var(--muted-foreground)]">{w.assignedBranch}</td>
                <td className="px-4 py-3"><StatusBadge status={w.currentStatus} /></td>
                <td className="px-4 py-3 text-[var(--muted-foreground)]">{formatRelativeTime(w.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
