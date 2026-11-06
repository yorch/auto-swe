import type { PullRequestCockpitFinding } from '@auto-swe/shared/types/api';
import { Badge } from '@/components/ui/Badge';
import { visibleText } from '@/lib/visibleText';

/** Model text, so plain text with its hidden characters made visible; never markup. */
const body = (text: string) => visibleText(text, { multiline: true });

/**
 * One finding of the review network. Everything but the severity is model output: it is shown as
 * plain text and a suggested fix is only text, never something to apply.
 */
export function FindingNote({
  finding,
  showLocation = false,
}: {
  finding: PullRequestCockpitFinding;
  /** Name the file and line, for a finding shown away from its line. */
  showLocation?: boolean;
}) {
  const critical = finding.severity === 'CRITICAL';
  return (
    <div className="space-y-1 text-xs text-paper-200">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={critical ? 'danger' : 'warning'} variant="outline">
          {critical ? 'Critical' : 'Warning'}
        </Badge>
        <span className="text-paper-400">
          {visibleText(finding.category)} · {visibleText(finding.reviewer)}
        </span>
        {showLocation ? (
          <span className="break-all font-mono text-paper-400">
            {visibleText(finding.file)}
            {finding.line !== null ? `:${finding.line}` : ''}
          </span>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap break-words">{body(finding.description)}</p>
      {finding.suggestedFix ? (
        <p className="whitespace-pre-wrap break-words text-paper-400">
          Suggested: {body(finding.suggestedFix)}
        </p>
      ) : null}
    </div>
  );
}
