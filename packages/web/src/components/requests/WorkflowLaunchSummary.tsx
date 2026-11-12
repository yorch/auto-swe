'use client';

import { ReviewList } from '@/components/requests/LaunchSteps';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useWorkflowProcess } from '@/hooks/useWorkflowProcess';
import { humanizeWorkflowKey } from '@/lib/workflowLabels';

export function WorkflowLaunchSummary({ templateId }: { templateId: string }) {
  const { query, summary } = useWorkflowProcess(templateId);
  return (
    <QueryBoundary
      error={query.error}
      isError={query.isError}
      isFetching={query.isFetching}
      isLoading={query.isLoading}
      label="workflow process"
      onRetry={() => void query.refetch()}
      shape="detail"
    >
      {summary ? (
        <ReviewList
          items={[
            ...(summary.phases.length > 0
              ? [{ label: 'Phases', value: summary.phases.join(' · ') }]
              : []),
            {
              label: 'Declared outputs',
              value: summary.outputs.length ? (
                summary.outputs.map(humanizeWorkflowKey).join(', ')
              ) : (
                <span className="text-paper-400">
                  This workflow does not declare a structured result.
                </span>
              ),
            },
            {
              label: 'Human steps',
              value: summary.humanSteps.length ? (
                summary.humanSteps.join(', ')
              ) : (
                <span className="text-paper-400">
                  No explicit human steps. Platform policies may still require approval.
                </span>
              ),
            },
            ...(summary.signals.length > 0
              ? [
                  {
                    label: 'Waits for external events',
                    value: summary.signals
                      .map((signal) => humanizeWorkflowKey(signal).replace(/ signal$/i, ''))
                      .join(', '),
                  },
                ]
              : []),
          ]}
        />
      ) : (
        <p className="text-sm text-paper-400">
          The process summary is unavailable. Open the workflow in the library to review its steps.
        </p>
      )}
    </QueryBoundary>
  );
}
