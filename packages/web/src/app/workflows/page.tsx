'use client';

import Link from 'next/link';
import { useState } from 'react';
import { SubmitWorkRequestModal } from '@/components/dashboard/SubmitWorkRequestModal';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useRepositories } from '@/hooks/useRepositories';
import { useWorkflows } from '@/hooks/useRuns';
import { formatCost, formatRelativeTime } from '@/lib/utils';

const PAGE_SIZE = 50;

export default function WorkflowsPage() {
  const [offset, setOffset] = useState(0);
  const {
    data: workflows,
    meta,
    isLoading,
    isError,
    error: loadError,
  } = useWorkflows({ limit: PAGE_SIZE, offset });
  const { data: repos } = useRepositories();
  const [submitOpen, setSubmitOpen] = useState(false);
  const canSubmit = (repos ?? []).length > 0;
  const total = meta?.total ?? 0;

  if (isLoading || isError) {
    return (
      <QueryBoundary error={loadError} isError={isError} isLoading={isLoading} label="workflows" />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button
            disabled={!canSubmit}
            onClick={() => setSubmitOpen(true)}
            title={canSubmit ? undefined : 'Connect a repository first'}
            variant="primary"
          >
            + Submit
          </Button>
        }
        chapter={`§ Workflows · ${total} total`}
        title="Workflows"
      />
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
      <Pagination
        hasNext={offset + PAGE_SIZE < total}
        hasPrev={offset > 0}
        onNext={() => setOffset(offset + PAGE_SIZE)}
        onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
        rangeEnd={Math.min(offset + PAGE_SIZE, total)}
        rangeStart={total === 0 ? 0 : offset + 1}
        total={total}
      />
    </div>
  );
}
