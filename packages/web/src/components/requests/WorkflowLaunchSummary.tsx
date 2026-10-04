'use client';

import { parseWorkflowSpec } from '@auto-swe/shared/workflow';
import { useMemo } from 'react';
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
      isLoading={query.isLoading}
      label="workflow process"
      onRetry={() => void query.refetch()}
    >
      {summary ? (
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-paper-400">Declared outputs</dt>
            <dd>
              {summary.outputs.length
                ? summary.outputs.map((output) => output.replace(/([A-Z])/g, ' $1')).join(', ')
                : 'This workflow does not declare a structured result.'}
            </dd>
          </div>
          <div>
            <dt className="text-paper-400">Human steps in the process</dt>
            <dd>
              {summary.humanSteps.length
                ? summary.humanSteps.join(', ')
                : 'No explicit human steps. Platform policies may still require approval.'}
            </dd>
          </div>
          {summary.signals.length > 0 && (
            <div>
              <dt className="text-paper-400">Waits for external events</dt>
              <dd>{summary.signals.join(', ')}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="text-sm text-paper-400">
          The process summary is unavailable. Open the workflow in the library to review its steps.
        </p>
      )}
    </QueryBoundary>
  );
}
