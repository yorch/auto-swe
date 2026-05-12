'use client';

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useWorkflowTemplates } from '@/hooks/useWorkflows';
import { formatRelativeTime } from '@/lib/utils';
import { useTeamStore } from '@/stores/teamStore';

export default function TemplatesPage() {
  const selectedTeamId = useTeamStore((s) => s.selectedTeamId);
  const { data: templates, isLoading } = useWorkflowTemplates(selectedTeamId);

  if (isLoading)
    return <div className="text-center py-12 text-[var(--muted-foreground)]">Loading…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Workflow Templates</h2>
        <span className="text-sm text-[var(--muted-foreground)]">
          {(templates ?? []).length} total
        </span>
      </div>

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--muted)]">
              <th className="text-left px-4 py-3 font-medium">Name</th>
              <th className="text-left px-4 py-3 font-medium">Team</th>
              <th className="text-left px-4 py-3 font-medium">Active version</th>
              <th className="text-left px-4 py-3 font-medium">Last run</th>
              <th className="text-left px-4 py-3 font-medium">Updated</th>
              <th className="text-right px-4 py-3 font-medium">Versions</th>
            </tr>
          </thead>
          <tbody>
            {(templates ?? []).map((t) => (
              <tr
                className="border-b border-[var(--border)] hover:bg-[var(--muted)] transition-colors"
                key={t.id}
              >
                <td className="px-4 py-3">
                  <Link
                    className="text-[var(--primary)] hover:underline font-medium"
                    href={`/templates/${t.id}`}
                  >
                    {t.name}
                  </Link>
                  {t.isDefault && (
                    <span className="ml-2 text-xs px-1.5 py-0.5 bg-blue-100 text-blue-800 rounded">
                      default
                    </span>
                  )}
                  {t.description && (
                    <div className="text-xs text-[var(--muted-foreground)]">{t.description}</div>
                  )}
                </td>
                <td className="px-4 py-3 text-[var(--muted-foreground)]">
                  {t.team?.name ?? <em>global</em>}
                </td>
                <td className="px-4 py-3 font-mono text-xs">
                  {t.activeVersion !== null ? `v${t.activeVersion}` : '—'}
                </td>
                <td className="px-4 py-3">
                  {t.lastRun ? (
                    <Link className="hover:underline" href={`/runs/${t.lastRun.id}`}>
                      <StatusBadge status={t.lastRun.status} />
                      <span className="ml-2 text-xs text-[var(--muted-foreground)]">
                        {formatRelativeTime(t.lastRun.startedAt)}
                      </span>
                    </Link>
                  ) : (
                    <span className="text-xs text-[var(--muted-foreground)]">never</span>
                  )}
                </td>
                <td className="px-4 py-3 text-[var(--muted-foreground)]">
                  {formatRelativeTime(t.updatedAt)}
                </td>
                <td className="px-4 py-3 text-right text-xs text-[var(--muted-foreground)]">
                  {t.versionCount}
                </td>
              </tr>
            ))}
            {(templates ?? []).length === 0 && (
              <tr>
                <td className="px-4 py-8 text-center text-[var(--muted-foreground)]" colSpan={6}>
                  No templates yet — seed the default template with{' '}
                  <code className="text-xs">yarn db:seed</code>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
