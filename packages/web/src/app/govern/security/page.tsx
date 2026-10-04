'use client';

import { useState } from 'react';
import { SecurityEventBadge, SecurityEventList } from '@/components/security/SecurityEventList';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import type { SecurityEventType } from '@/hooks/useAdmin';
import { useSecurityEventSummary, useSecurityEvents } from '@/hooks/useAdmin';

const TYPE_OPTIONS: Array<{ label: string; value: SecurityEventType | '' }> = [
  { label: 'All types', value: '' },
  { label: 'Shell Block', value: 'SHELL_BLOCK' },
  { label: 'File Block', value: 'FILE_BLOCK' },
  { label: 'Content Security Block', value: 'CONTENT_SECURITY_BLOCK' },
  { label: 'Content Security Warn', value: 'CONTENT_SECURITY_WARN' },
  { label: 'Code Security', value: 'CODE_SECURITY' },
  { label: 'LLM Suspicious', value: 'LLM_SUSPICIOUS' },
  { label: 'Channel Suspicious Input', value: 'CHANNEL_SUSPICIOUS' },
];

const LIMIT = 50;

/** Totals per type across every recorded event — not just the page shown. */
function SummaryBar({ counts }: { counts: Partial<Record<SecurityEventType, number>> }) {
  const entries = (Object.entries(counts) as Array<[SecurityEventType, number]>).filter(
    ([, count]) => count > 0
  );
  if (entries.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([type, count]) => (
        <div className="flex items-center gap-1.5" key={type}>
          <SecurityEventBadge type={type} />
          <span className="text-xs text-paper-400 font-mono">{count}</span>
        </div>
      ))}
    </div>
  );
}

export default function GovernSecurityPage() {
  const [typeFilter, setTypeFilter] = useState<SecurityEventType | ''>('');
  const [offset, setOffset] = useState(0);
  const {
    data: page,
    isLoading,
    isError,
    refetch,
    error: loadError,
  } = useSecurityEvents({ limit: LIMIT, offset, type: typeFilter || undefined });
  const { data: counts } = useSecurityEventSummary();
  const events = page?.data ?? [];
  const total = page?.meta.total ?? 0;

  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          <div className="w-52 shrink-0">
            <Select
              aria-label="Filter by event type"
              onChange={(v) => {
                setTypeFilter(v as SecurityEventType | '');
                setOffset(0);
              }}
              options={TYPE_OPTIONS}
              value={typeFilter}
            />
          </div>
        }
        chapter="§ Govern"
        subtitle="Scanner findings across all runs, newest first — shell command blocks, file blocks, content security violations, static code analysis findings, and suspicious LLM output. Click any event to expand details. Events refresh every 30 s."
        title="Security events"
      />

      {counts && Object.values(counts).some((n) => n > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>All recorded events by type</CardTitle>
          </CardHeader>
          <SummaryBar counts={counts} />
        </Card>
      )}

      <QueryBoundary
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="security events"
        onRetry={() => void refetch()}
      >
        <Card>
          <CardHeader>
            <CardTitle>
              {typeFilter
                ? `${TYPE_OPTIONS.find((o) => o.value === typeFilter)?.label} events`
                : 'All events'}
              {total > 0 && (
                <span className="ml-2 text-sm font-normal text-paper-400">· {total}</span>
              )}
            </CardTitle>
          </CardHeader>
          <SecurityEventList
            emptyMessage="No security events found. Events appear here when the agent triggers a scanner."
            events={events}
            showRunLink
          />
          {total > 0 && (
            <div className="pt-3 mt-3 border-t border-ink-600">
              <Pagination
                hasNext={offset + events.length < total}
                hasPrev={offset > 0}
                onNext={() => setOffset((o) => o + LIMIT)}
                onPrev={() => setOffset((o) => Math.max(0, o - LIMIT))}
                rangeEnd={Math.min(offset + LIMIT, total)}
                rangeStart={offset + 1}
                total={total}
              />
            </div>
          )}
        </Card>
      </QueryBoundary>
    </div>
  );
}
