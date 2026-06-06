'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import { useGlobalAnalytics } from '@/hooks/useWorkflows';
import { formatPercent } from '@/lib/utils';

const WINDOWS = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
];

type SortKey = 'runs' | 'successRate' | 'totalCost' | 'avgCost';

function fmt(n: number | null, digits = 1): string {
  if (n === null) {
    return '—';
  }
  return n.toFixed(digits);
}

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function KpiTile({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <Card>
      <div className="px-4 pt-4 pb-1 text-xs text-[var(--muted-foreground)]">{label}</div>
      <p className={`text-3xl font-bold px-4 pb-4 ${valueClass ?? ''}`}>{value}</p>
    </Card>
  );
}

function SortHeader({
  label,
  col,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  col: SortKey;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  onSort: (k: SortKey) => void;
}) {
  const active = sortKey === col;
  return (
    <th className="px-4 py-2 font-medium text-right">
      <button
        className={`hover:underline ${active ? 'text-[var(--foreground)]' : 'text-[var(--muted-foreground)]'}`}
        onClick={() => onSort(col)}
        type="button"
      >
        {label} {active ? (sortDir === 'desc' ? '↓' : '↑') : ''}
      </button>
    </th>
  );
}

const PAGE_SIZE = 25;

export default function GlobalAnalyticsPage() {
  const [windowDays, setWindowDays] = useState(30);
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('runs');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);
  const { data, isLoading } = useGlobalAnalytics(windowDays);

  const handleSort = (k: SortKey) => {
    if (k === sortKey) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(k);
      setSortDir('desc');
    }
    setPage(0);
  };

  const handleFilter = (v: string) => {
    setFilter(v);
    setPage(0);
  };

  const rows = useMemo(() => {
    if (!data) {
      return [];
    }
    const filterLower = filter.toLowerCase();
    const filtered = filter
      ? data.perTemplate.filter((r) => r.templateName.toLowerCase().includes(filterLower))
      : data.perTemplate;
    return [...filtered].sort((a, b) => {
      let av: number;
      let bv: number;
      if (sortKey === 'runs') {
        av = a.totalRuns;
        bv = b.totalRuns;
      } else if (sortKey === 'successRate') {
        av = a.successRate ?? -1;
        bv = b.successRate ?? -1;
      } else if (sortKey === 'totalCost') {
        av = a.totalCost;
        bv = b.totalCost;
      } else {
        av = a.totalRuns > 0 ? a.totalCost / a.totalRuns : -1;
        bv = b.totalRuns > 0 ? b.totalCost / b.totalRuns : -1;
      }
      return sortDir === 'desc' ? bv - av : av - bv;
    });
  }, [data, filter, sortKey, sortDir]);

  const totalPages = Math.ceil(rows.length / PAGE_SIZE);
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Platform Analytics</h2>
        <div className="flex gap-1 bg-[var(--muted)] rounded-md p-1">
          {WINDOWS.map((w) => (
            <button
              className={`px-3 py-1 text-sm rounded transition-colors ${
                windowDays === w.days
                  ? 'bg-white shadow text-[var(--foreground)]'
                  : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
              }`}
              key={w.days}
              onClick={() => {
                setWindowDays(w.days);
                setPage(0);
              }}
              type="button"
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading || !data ? (
        <LoadingState />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiTile label="Total runs" value={String(data.totalRuns)} />
            <KpiTile label="Success rate" value={formatPercent(data.successRate)} />
            <KpiTile label="Succeeded" value={String(data.succeeded)} valueClass="text-green-700" />
            <KpiTile label="Total cost" value={fmtCost(data.totalCost)} />
          </div>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Templates — ranked by traffic</CardTitle>
                <input
                  className="text-sm border border-[var(--border)] rounded px-2 py-1 bg-[var(--background)] w-48"
                  onChange={(e) => handleFilter(e.target.value)}
                  placeholder="Filter templates…"
                  type="text"
                  value={filter}
                />
              </div>
            </CardHeader>
            {rows.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-[var(--muted-foreground)]">
                {filter
                  ? 'No templates match your filter.'
                  : `No runs in the last ${windowDays} days.`}
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted-foreground)]">
                        <th className="px-4 py-2 font-medium">Template</th>
                        <SortHeader
                          col="runs"
                          label="Runs"
                          onSort={handleSort}
                          sortDir={sortDir}
                          sortKey={sortKey}
                        />
                        <SortHeader
                          col="successRate"
                          label="Success rate"
                          onSort={handleSort}
                          sortDir={sortDir}
                          sortKey={sortKey}
                        />
                        <SortHeader
                          col="totalCost"
                          label="Total cost"
                          onSort={handleSort}
                          sortDir={sortDir}
                          sortKey={sortKey}
                        />
                        <SortHeader
                          col="avgCost"
                          label="Avg cost/run"
                          onSort={handleSort}
                          sortDir={sortDir}
                          sortKey={sortKey}
                        />
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((row) => {
                        const avgCost = row.totalRuns > 0 ? row.totalCost / row.totalRuns : null;
                        const srPct = row.successRate !== null ? row.successRate * 100 : null;
                        return (
                          <tr
                            className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--muted)]"
                            key={row.templateId}
                          >
                            <td className="px-4 py-2">
                              <Link
                                className="text-[var(--primary)] hover:underline"
                                href={`/templates/${row.templateId}`}
                              >
                                {row.templateName}
                              </Link>
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums">{row.totalRuns}</td>
                            <td className="px-4 py-2 text-right tabular-nums">
                              {srPct !== null ? (
                                <span
                                  className={
                                    srPct >= 80
                                      ? 'text-green-700'
                                      : srPct >= 50
                                        ? 'text-amber-600'
                                        : 'text-red-600'
                                  }
                                >
                                  {fmt(srPct)}%
                                </span>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums">
                              {fmtCost(row.totalCost)}
                            </td>
                            <td className="px-4 py-2 text-right tabular-nums">
                              {avgCost !== null ? fmtCost(avgCost) : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {totalPages > 1 && (
                  <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--border)] text-sm text-[var(--muted-foreground)]">
                    <span>
                      {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, rows.length)} of{' '}
                      {rows.length}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        className="px-2 py-1 rounded hover:bg-[var(--muted)] disabled:opacity-40 disabled:cursor-not-allowed"
                        disabled={page === 0}
                        onClick={() => setPage((p) => p - 1)}
                        type="button"
                      >
                        ←
                      </button>
                      {Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNum) => (
                        <button
                          className={`px-2 py-1 rounded text-xs ${
                            pageNum - 1 === page
                              ? 'bg-[var(--primary)] text-white'
                              : 'hover:bg-[var(--muted)]'
                          }`}
                          key={pageNum}
                          onClick={() => setPage(pageNum - 1)}
                          type="button"
                        >
                          {pageNum}
                        </button>
                      ))}
                      <button
                        className="px-2 py-1 rounded hover:bg-[var(--muted)] disabled:opacity-40 disabled:cursor-not-allowed"
                        disabled={page === totalPages - 1}
                        onClick={() => setPage((p) => p + 1)}
                        type="button"
                      >
                        →
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
