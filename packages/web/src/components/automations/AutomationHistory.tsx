'use client';

import { eventSource } from '@auto-swe/shared/automation';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useAutomationFires } from '@/hooks/useAutomations';
import { errMsg } from '@/lib/errors';

const OUTCOME_TONE: Record<string, BadgeTone> = { FAILED_TO_START: 'brick', STARTED: 'moss' };

/** A plain label for a decision: `SUPPRESSED_SAME_SUBJECT` → "already handled". */
export function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case 'STARTED':
      return 'started';
    case 'SUPPRESSED_OWN_OUTPUT':
      return 'platform’s own fix';
    case 'SUPPRESSED_SAME_SUBJECT':
      return 'already handled';
    case 'SUPPRESSED_PRECONDITION':
      return 'not applicable';
    default:
      return outcome
        .replace(/^SUPPRESSED_/, '')
        .replace(/_/g, ' ')
        .toLowerCase();
  }
}

export function outcomeTone(outcome: string): BadgeTone {
  return OUTCOME_TONE[outcome] ?? 'amber';
}

/** What one event automation decided, newest first. */
export function AutomationHistory({
  automationId,
  source,
}: {
  automationId: string;
  source: string;
}) {
  const { data, isLoading, isError, error } = useAutomationFires(automationId);
  const descriptor = eventSource(source);
  if (isLoading) {
    return <SkeletonRows rows={2} />;
  }
  if (isError) {
    return <Alert>{errMsg(error, 'Could not load what this automation decided.')}</Alert>;
  }
  if (!data || data.length === 0) {
    return <p className="text-paper-500 text-xs">Nothing has matched this automation yet.</p>;
  }
  return (
    <ul className="divide-y divide-ink-600 text-xs">
      {data.map((f) => (
        <li className="flex items-start justify-between gap-3 py-2" key={f.id}>
          <div className="min-w-0">
            <div className="truncate text-paper-200">
              {descriptor ? descriptor.describeOccurrence(f.facts) : f.scopeKey}
            </div>
            <div className="mt-0.5 text-paper-500">
              {f.subjectKey.slice(0, 12)}
              {f.reason && ` · ${f.reason}`}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge tone={outcomeTone(f.outcome)} variant="outline">
              {outcomeLabel(f.outcome)}
            </Badge>
            <RelativeTime className="text-paper-500" value={f.createdAt} />
          </div>
        </li>
      ))}
    </ul>
  );
}
