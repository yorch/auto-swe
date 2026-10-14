import { formatValidationIssue, type ValidationIssue } from '@auto-swe/shared/workflow';
import { Alert } from '@/components/ui/Alert';

/** The selected version's lint errors; the visual editor lists its own, so it skips this. */
export function LintErrorsAlert({ lintErrors }: { lintErrors: ValidationIssue[] }) {
  return (
    <Alert
      title={`${lintErrors.length} error${lintErrors.length === 1 ? '' : 's'} in this workflow`}
    >
      <ul className="list-disc space-y-0.5 pl-5" data-testid="spec-errors">
        {lintErrors.map((issue) => (
          <li key={`${issue.code}:${issue.nodeId ?? ''}:${issue.field ?? ''}:${issue.message}`}>
            {formatValidationIssue(issue)}
          </li>
        ))}
      </ul>
    </Alert>
  );
}
