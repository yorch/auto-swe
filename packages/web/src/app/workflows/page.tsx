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
import { useAllWorkflowRuns } from '@/hooks/useRuns';
import { cn } from '@/lib/utils';

type Scope = 'ALL' | 'MINE' | 'TEAM';

const SCOPE_LABELS: Record<Scope, string> = {
  ALL: 'All',
  MINE: 'Mine',
  TEAM: 'Team',
};

function OutcomeCell({
  outcomeDomain,
  outcomeType,
  status,
}: {
  outcomeDomain: string | null;
  outcomeType: string | null;
  status: string;
}) {
  if (outcomeDomain) {
    return (
      <span className="text-paper-400">
        {outcomeDomain}
        {outcomeType ? <span className="text-paper-500"> · {outcomeType}</span> : null}
      </span>
    );
  }
  if (status === 'SUCCESS') {
    return <span className="text-paper-400">completed</span>;
  }
  return <span className="text-paper-600">—</span>;
}

export default function WorkflowsPage() {
  const [scope, setScope] = useState<Scope>('MINE');
  const { data, isLoading } = useAllWorkflowRuns({ limit: 50, scope });
  const [newOpen, setNewOpen] = useState(false);
  const [runTarget, setRunTarget] = useState<WorkflowTemplateSummary | null>(null);
  const runs = data?.data ?? [];
  const total = data?.meta.total ?? 0;

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
        chapter={`§ Requests · ${total} total`}
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

      <div className="flex gap-2">
        {(Object.keys(SCOPE_LABELS) as Scope[]).map((s) => (
          <button
            className={cn(
              'rounded px-3 py-1.5 text-xs font-medium uppercase tracking-wider transition-colors',
              s === scope
                ? 'bg-ember-400 text-ink-900'
                : 'border border-ink-600 text-paper-400 hover:border-ember-400 hover:text-paper-200'
            )}
            key={s}
            onClick={() => setScope(s)}
            type="button"
          >
            {SCOPE_LABELS[s]}
          </button>
        ))}
      </div>

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-600 bg-ink-800">
              <th className="text-left px-4 py-3 font-medium">Label</th>
              <th className="text-left px-4 py-3 font-medium">Workflow</th>
              <th className="text-left px-4 py-3 font-medium">Domain</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-xs text-paper-500" colSpan={5}>
                  No requests in this scope.
                </td>
              </tr>
            )}
            {runs.map((r) => (
              <tr className="border-b border-ink-600 hover:bg-ink-800 transition-colors" key={r.id}>
                <td className="px-4 py-3">
                  <Link
                    className="text-ember-400 hover:underline font-medium"
                    href={`/runs/${r.id}`}
                  >
                    {r.workRequest?.description || r.workRequest?.externalTicketId || '—'}
                  </Link>
                </td>
                <td className="px-4 py-3 text-paper-400">{r.templateName ?? '—'}</td>
                <td className="px-4 py-3 text-paper-400">{r.domain ?? '—'}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-4 py-3">
                  <OutcomeCell
                    outcomeDomain={r.outcomeDomain}
                    outcomeType={r.outcomeType}
                    status={r.status}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
