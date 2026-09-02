'use client';

import Link from 'next/link';
import { useState } from 'react';
import { SecurityEventBadge, SecurityEventList } from '@/components/security/SecurityEventList';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import type { SecurityEventType } from '@/hooks/useAdmin';
import { useSecurityEvents } from '@/hooks/useAdmin';

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

function SummaryBar({ events }: { events: Array<{ eventType: SecurityEventType }> }) {
  const counts: Partial<Record<SecurityEventType, number>> = {};
  for (const e of events) {
    counts[e.eventType] = (counts[e.eventType] ?? 0) + 1;
  }
  const entries = Object.entries(counts) as Array<[SecurityEventType, number]>;
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
  const {
    data: events,
    isLoading,
    isError,
    error: loadError,
  } = useSecurityEvents({
    limit: 100,
    type: typeFilter || undefined,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <div className="w-52 shrink-0">
            <Select
              onChange={(e) => setTypeFilter(e.target.value as SecurityEventType | '')}
              value={typeFilter}
            >
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
        }
        subtitle="Recent scanner findings across all runs — shell command blocks, file blocks, content security violations, static code analysis findings, and suspicious LLM output. Click any event to expand details. Events refresh every 30 s."
        title="Security Events"
      />

      <QueryBoundary
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="security events"
      >
        {
          <>
            {events && events.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Summary</CardTitle>
                </CardHeader>
                <SummaryBar events={events} />
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle>
                  {typeFilter
                    ? `${TYPE_OPTIONS.find((o) => o.value === typeFilter)?.label} events`
                    : 'All events'}
                  {events && events.length > 0 && (
                    <span className="ml-2 text-sm font-normal text-paper-400">
                      · {events.length}
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <SecurityEventList
                emptyMessage="No security events found. Events appear here when the agent triggers a scanner."
                events={events ?? []}
                showRunLink
              />
              {events && events.length > 0 && (
                <div className="pt-3 mt-3 border-t border-ink-600">
                  <p className="text-xs text-paper-500">
                    Showing the {events.length} most recent events.{' '}
                    <Link className="text-ember-400 hover:underline" href="/runs">
                      View all runs →
                    </Link>
                  </p>
                </div>
              )}
            </Card>
          </>
        }
      </QueryBoundary>
    </div>
  );
}
