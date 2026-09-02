'use client';

import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { NewRequestModal } from '@/components/workflow/NewRequestModal';
import { RunTemplateModal } from '@/components/workflow/RunTemplateModal';
import { useWorkflows } from '@/hooks/useRuns';
import { formatCost, formatRelativeTime } from '@/lib/utils';

export default function WorkflowsPage() {
  const { data: workflows, isLoading } = useWorkflows();
  const [newOpen, setNewOpen] = useState(false);
  const [runTarget, setRunTarget] = useState<WorkflowTemplateSummary | null>(null);

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button onClick={() => setNewOpen(true)} variant="primary">
            + New request
          </Button>
        }
        chapter={`§ Requests · ${(workflows ?? []).length} total`}
        title="Request queue"
      />
      <NewRequestModal
        onClose={() => setNewOpen(false)}
        onSelect={(t) => {
          setRunTarget(t);
          setNewOpen(false);
        }}
        open={newOpen}
      />
      {runTarget && (
        <RunTemplateModal onClose={() => setRunTarget(null)} open template={runTarget} />
      )}

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
