import type { WorkflowTemplateAnalytics } from '@auto-swe/shared/types/api';
import { ButtonLink } from '@/components/ui/Button';
import { KeyValueRow } from '@/components/workflow/KeyValueRow';
import { formatCost, formatDuration, formatPercent } from '@/lib/utils';
import { RailCard } from './RailCard';

interface ObservedCardProps {
  templateId: string;
  analytics: WorkflowTemplateAnalytics;
  estimatedHumanTimeSavedMinutes: number | null | undefined;
}

/** The last 30 days of runs, summarised; the caller renders it only when there were runs. */
export function ObservedCard({
  templateId,
  analytics,
  estimatedHumanTimeSavedMinutes,
}: ObservedCardProps) {
  return (
    <RailCard
      action={
        <ButtonLink href={`/library/${templateId}/analytics`} size="sm" variant="ghost">
          Details
        </ButtonLink>
      }
      hint="Last 30 days"
      title="Observed"
    >
      <dl className="space-y-2">
        <KeyValueRow label="Runs">{analytics.totalRuns}</KeyValueRow>
        <KeyValueRow label="Success rate">{formatPercent(analytics.successRate)}</KeyValueRow>
        {estimatedHumanTimeSavedMinutes != null && (
          <KeyValueRow label="Est. time saved">
            {formatDuration(estimatedHumanTimeSavedMinutes * 60_000)}/run
          </KeyValueRow>
        )}
        {analytics.agentErrorRate != null && (
          <KeyValueRow label="Agent error rate">
            {formatPercent(analytics.agentErrorRate)}
          </KeyValueRow>
        )}
        {analytics.autonomyRate != null && (
          <KeyValueRow label="Autonomy rate">{formatPercent(analytics.autonomyRate)}</KeyValueRow>
        )}
        {analytics.humanReviewRate != null && (
          <KeyValueRow label="Human review rate">
            {formatPercent(analytics.humanReviewRate)}
          </KeyValueRow>
        )}
        {analytics.avgCostPerRun != null && (
          <KeyValueRow label="Avg cost / run">{formatCost(analytics.avgCostPerRun)}</KeyValueRow>
        )}
        {analytics.p50DurationMs != null && (
          <KeyValueRow label="p50 duration">{formatDuration(analytics.p50DurationMs)}</KeyValueRow>
        )}
      </dl>
    </RailCard>
  );
}
