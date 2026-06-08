'use client';

import Link from 'next/link';
import { useState } from 'react';
import { SubmitWorkRequestModal } from '@/components/dashboard/SubmitWorkRequestModal';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useRepositories, useWorkflows } from '@/hooks/useWorkflows';
import { formatCost, formatRelativeTime } from '@/lib/utils';

export default function WorkflowsPage() {
  const { data: workflows, isLoading } = useWorkflows();
  const { data: repos } = useRepositories();
  const [submitOpen, setSubmitOpen] = useState(false);
  const canSubmit = (repos ?? []).length > 0;

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-2xl font-bold">Workflows</h2>
        <div className="flex items-center gap-4">
          <span className="text-sm text-paper-400">{(workflows ?? []).length} total</span>
          <Button
            disabled={!canSubmit}
            onClick={() => setSubmitOpen(true)}
            title={canSubmit ? undefined : 'Connect a repository first'}
            variant="primary"
          >
            + Submit
          </Button>
        </div>
      </div>
      <SubmitWorkRequestModal onClose={() => setSubmitOpen(false)} open={submitOpen} />

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-600 bg-ink-800">
              <th className="text-left px-4 py-3 font-medium">Repository</th>
              <th className="text-left px-4 py-3 font-medium">Branch</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Updated</th>
              <th className="text-right px-4 py-3 font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {(workflows ?? []).map((w) => (
              <tr className="border-b border-ink-600 hover:bg-ink-800 transition-colors" key={w.id}>
                <td className="px-4 py-3">
                  <Link
                    className="text-ember-400 hover:underline font-medium"
                    href={`/workflows/${w.id}`}
                  >
                    {w.repository?.organizationName}/{w.repository?.repoName}
                  </Link>
                </td>
                <td className="px-4 py-3 text-paper-400">{w.assignedBranch}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={w.currentStatus} />
                </td>
                <td className="px-4 py-3 text-paper-400">{formatRelativeTime(w.updatedAt)}</td>
                <td className="px-4 py-3 text-right text-xs text-paper-400">
                  {formatCost(w.costUsdAccrued)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
