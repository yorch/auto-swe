'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useMemo, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { Select } from '@/components/ui/Select';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { TabBar } from '@/components/ui/TabBar';
import { useTemplateRuns, useWorkflowTemplate } from '@/hooks/useWorkflows';
import { formatDate, formatDuration, formatRelativeTime } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

type SubTab = 'editor' | 'analytics' | 'runs' | 'compare';

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: 'editor', label: 'Editor' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'runs', label: 'Run history' },
  { id: 'compare', label: 'Compare versions' },
];

const PAGE_SIZE = 20;

const RUN_STATUSES = [
  { label: 'All statuses', value: '' },
  { label: 'Running', value: 'RUNNING' },
  { label: 'Succeeded', value: 'SUCCEEDED' },
  { label: 'Failed', value: 'FAILED' },
  { label: 'Cancelled', value: 'CANCELLED' },
  { label: 'Timed out', value: 'TIMED_OUT' },
];

function runDuration(start: string, end: string | null): string {
  if (!end) {
    return 'running';
  }
  return formatDuration(new Date(end).getTime() - new Date(start).getTime());
}

export default function TemplateRunsPage({ params }: PageProps) {
  const router = useRouter();
  const { id } = use(params);
  const { data: template } = useWorkflowTemplate(id);
  const [offset, setOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [versionFilter, setVersionFilter] = useState('');

  const { data, isLoading } = useTemplateRuns(id, { limit: PAGE_SIZE, offset });

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;

  const versions = useMemo(() => {
    const seen = new Set<number>();
    for (const r of rows) {
      seen.add(r.templateVersion);
    }
    return [...seen].sort((a, b) => b - a);
  }, [rows]);

  const filteredRows = useMemo(
    () =>
      rows.filter((r) => {
        if (statusFilter && r.status !== statusFilter) {
          return false;
        }
        if (versionFilter && r.templateVersion !== Number(versionFilter)) {
          return false;
        }
        return true;
      }),
    [rows, statusFilter, versionFilter]
  );

  const handleTabChange = (tab: SubTab) => {
    if (tab === 'editor') {
      router.push(`/templates/${id}`);
    } else if (tab === 'analytics') {
      router.push(`/templates/${id}/analytics`);
    } else if (tab === 'compare') {
      router.push(`/templates/${id}/diff`);
    }
  };

  const handlePrev = () => setOffset(Math.max(0, offset - PAGE_SIZE));
  const handleNext = () => setOffset(offset + PAGE_SIZE);

  return (
    <div className="space-y-10">
      <div className="fade-up">
        <Link
          className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500 transition-colors hover:text-ember-400"
          href={`/templates/${id}`}
        >
          <span>←</span> {template?.name ?? 'template'}
        </Link>
        <div className="mt-4">
          <PageHeader
            chapter={`§ Runs · ${total} total`}
            subtitle="Every execution of this template, newest first. Click a row to drill into a specific run."
            title="Run history."
          />
        </div>
      </div>

      <TabBar active="runs" className="fade-up" onChange={handleTabChange} tabs={SUB_TABS} />

      {/* Filters */}
      <div className="fade-up stagger-1 flex flex-wrap items-end gap-3">
        <Select
          className="h-9 w-auto px-2 font-mono text-xs"
          label="Status"
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setOffset(0);
          }}
          value={statusFilter}
        >
          {RUN_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
        {versions.length > 1 && (
          <Select
            className="h-9 w-auto px-2 font-mono text-xs"
            label="Template version"
            onChange={(e) => {
              setVersionFilter(e.target.value);
              setOffset(0);
            }}
            value={versionFilter}
          >
            <option value="">All versions</option>
            {versions.map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </Select>
        )}
        {(statusFilter || versionFilter) && (
          <button
            className="h-9 rounded-sm border border-ink-500 px-3 font-mono text-[10px] uppercase tracking-wider text-paper-400 hover:border-ember-400 hover:text-ember-400"
            onClick={() => {
              setStatusFilter('');
              setVersionFilter('');
              setOffset(0);
            }}
            type="button"
          >
            Clear filters
          </button>
        )}
        {(statusFilter || versionFilter) && (
          <span className="font-mono text-[11px] text-paper-500">
            {filteredRows.length} of {rows.length} shown
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20 font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500">
          <span className="pulse-dot mr-3 inline-block h-1.5 w-1.5 rounded-full bg-ember-400" />
          loading runs…
        </div>
      ) : (
        <>
          <Card className="fade-up stagger-2 overflow-hidden p-0" variant="inset">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-600">
                  <Th>Started</Th>
                  <Th>Status</Th>
                  <Th>Template ver.</Th>
                  <Th>Work request</Th>
                  <Th align="right">Duration</Th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r) => (
                  <tr
                    className="border-b border-ink-600 transition-colors hover:bg-ink-700/40"
                    key={r.id}
                  >
                    <td className="px-4 py-3">
                      <Link className="text-paper-100 hover:text-ember-400" href={`/runs/${r.id}`}>
                        {formatDate(r.startedAt)}
                      </Link>
                      <div className="font-mono text-[11px] text-paper-500">
                        {formatRelativeTime(r.startedAt)}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-paper-300">
                      v{r.templateVersion}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {r.workRequest ? (
                        <>
                          <div className="font-mono text-paper-100">
                            {r.workRequest.externalTicketId}
                          </div>
                          <div className="max-w-md truncate text-paper-500">
                            {r.workRequest.description}
                          </div>
                        </>
                      ) : (
                        <span className="font-mono text-[11px] uppercase tracking-wider text-paper-500">
                          —
                        </span>
                      )}
                    </td>
                    <td className="tabular px-4 py-3 text-right font-mono text-xs">
                      {r.endedAt === null ? (
                        <span className="inline-flex items-center gap-1.5 text-ember-400">
                          <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-ember-400" />
                          running
                        </span>
                      ) : (
                        <span className="text-paper-300">
                          {runDuration(r.startedAt, r.endedAt)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {filteredRows.length === 0 && (
                  <tr>
                    <td
                      className="px-4 py-12 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500"
                      colSpan={5}
                    >
                      {rows.length === 0
                        ? 'no runs yet — submit a work request to trigger one'
                        : 'no runs match the current filters'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>

          {total > PAGE_SIZE && (
            <div className="fade-up stagger-3">
              <Pagination
                hasNext={offset + PAGE_SIZE < total}
                hasPrev={offset > 0}
                onNext={handleNext}
                onPrev={handlePrev}
                rangeEnd={Math.min(offset + PAGE_SIZE, total)}
                rangeStart={offset + 1}
                total={total}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={`px-4 py-3 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-paper-500 ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}
