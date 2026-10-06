'use client';

import { parseWorkflowSpec } from '@auto-swe/shared/workflow';
import { useMemo } from 'react';
import { ReviewList } from '@/components/requests/LaunchSteps';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { nodeDisplayName } from '@/components/workflow/nodeDisplay';
import { useWorkflowTemplate } from '@/hooks/useTemplates';

export function WorkflowLaunchSummary({ templateId }: { templateId: string }) {
  const query = useWorkflowTemplate(templateId);
  const summary = useMemo(() => {
    try {
      const spec = parseWorkflowSpec(query.data?.activeVersionSpec?.spec);
      const humanSteps = Object.entries(spec.nodes)
        .filter(([, node]) => node.type.startsWith('human'))
        .map(([id, node]) => nodeDisplayName(node, id));
      const signals = Object.values(spec.nodes)
        .filter((node) => node.type === 'signal')
        .map((node) => node.name);
      const outputs = [
        ...new Set(
          Object.values(spec.nodes).flatMap((node) =>
            node.type === 'terminate' && node.result ? Object.keys(node.result) : []
          )
        ),
      ];
      return { humanSteps, outputs, signals };
    } catch {
      return null;
    }
  }, [query.data?.activeVersionSpec?.spec]);
  return (
    <QueryBoundary
      error={query.error}
      isError={query.isError}
      isFetching={query.isFetching}
      isLoading={query.isLoading}
      label="workflow process"
      loadingMessage="Loading the workflow process…"
      onRetry={() => void query.refetch()}
    >
      {summary ? (
        <ReviewList
          items={[
            {
              label: 'Declared outputs',
              value: summary.outputs.length ? (
                summary.outputs.map((output) => output.replace(/([A-Z])/g, ' $1')).join(', ')
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
              ? [{ label: 'Waits for external events', value: summary.signals.join(', ') }]
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
