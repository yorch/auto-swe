import { parseWorkflowSpec } from '@auto-swe/shared/workflow';
import { nodeDisplayName } from '@/components/workflow/nodeDisplay';
import { phasesOf } from '@/components/workflow/workflowPhases';
import { humanizeWorkflowKey } from '@/lib/workflowLabels';

export function summarizeWorkflow(raw: unknown) {
  try {
    const spec = parseWorkflowSpec(raw);
    return {
      humanSteps: Object.entries(spec.nodes)
        .filter(([, node]) => node.type.startsWith('human'))
        .map(([id, node]) => nodeDisplayName(node, id)),
      outputs: [
        ...new Set(
          Object.values(spec.nodes).flatMap((node) =>
            node.type === 'terminate' && node.result ? Object.keys(node.result) : []
          )
        ),
      ],
      phases: phasesOf(spec),
      signals: Object.values(spec.nodes)
        .filter((node) => node.type === 'signal')
        .map((node) => node.name),
    };
  } catch {
    return null;
  }
}

export function workflowGuide(
  summary: ReturnType<typeof summarizeWorkflow>,
  workspaceProvider: string | null | undefined
) {
  const producesPr =
    summary !== null &&
    [...summary.outputs, ...summary.phases].some((key) =>
      /\b(pr|pull request)\b/i.test(humanizeWorkflowKey(key))
    );
  return {
    points: [
      'The workflow runs its configured steps and checks.',
      ...(summary?.humanSteps.length
        ? [
            `Human steps: ${summary.humanSteps.join(', ')}. You are asked when your input is needed.`,
          ]
        : ['Platform policies may still require approval.']),
      producesPr
        ? 'The workflow opens a pull request for you to review.'
        : workspaceProvider && workspaceProvider !== 'git_repo'
          ? 'The workflow updates its configured record or document.'
          : 'Review the declared results when the workflow finishes.',
    ],
    producesPr,
    title: 'Running a workflow',
  };
}
