import type { ValidationIssue, WorkflowSpec } from '@auto-swe/shared/workflow';
import { formatValidationIssue } from '@auto-swe/shared/workflow';
import type { RefObject } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { ServerWorkflowIssue } from '@/hooks/useValidateWorkflow';
import { cn, FOCUS_RING } from '@/lib/utils';

interface IssuesPanelProps {
  spec: WorkflowSpec;
  /** The editor's own lint findings, errors then warnings. */
  issues: ValidationIssue[];
  /** Messages from a save the server rejected. */
  serverIssues: string[];
  /** Check-workflow findings the editor's lint did not already report. */
  serverExtra: ServerWorkflowIssue[];
  shownErrors: number;
  shownWarnings: number;
  onSelect: (id: string | null) => void;
  issuesRef: RefObject<HTMLDetailsElement | null>;
  issuesSummaryRef: RefObject<HTMLElement | null>;
}

/** The collapsible list of lint and server findings under the action bar. */
export function IssuesPanel({
  spec,
  issues,
  serverIssues,
  serverExtra,
  shownErrors,
  shownWarnings,
  onSelect,
  issuesRef,
  issuesSummaryRef,
}: IssuesPanelProps) {
  if (issues.length === 0 && serverIssues.length === 0 && serverExtra.length === 0) {
    return null;
  }
  return (
    <details
      className="group border-b border-ink-600 bg-ink-800/60 px-4 py-2 text-xs"
      open={shownErrors > 0 || serverIssues.length > 0}
      ref={issuesRef}
    >
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center gap-1.5 rounded-sm text-paper-300 select-none [&::-webkit-details-marker]:hidden',
          FOCUS_RING
        )}
        ref={issuesSummaryRef}
      >
        <Icon
          className="text-paper-500 transition-transform group-open:rotate-90"
          name="chevronRight"
          size={12}
        />
        <Icon
          className={
            shownErrors > 0 || serverIssues.length > 0 ? 'text-brick-400' : 'text-amber-400'
          }
          name="warning"
          size={13}
        />
        {serverIssues.length > 0 && (
          <span className="text-brick-400">
            Save rejected: {serverIssues.length} problem{serverIssues.length === 1 ? '' : 's'}
          </span>
        )}
        {serverIssues.length > 0 && shownErrors + shownWarnings > 0 && ' · '}
        {shownErrors > 0 && (
          <span className="text-brick-400">{shownErrors} error{shownErrors === 1 ? '' : 's'}</span>
        )}
        {shownErrors > 0 && shownWarnings > 0 && ' · '}
        {shownWarnings > 0 && (
          <span className="text-amber-400">
            {shownWarnings} warning{shownWarnings === 1 ? '' : 's'}
          </span>
        )}
      </summary>
      <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto pl-5">
        {serverIssues.map((message) => (
          <li className="text-paper-300" key={`server:${message}`}>
            <span className="font-medium text-brick-400">Server:</span> {message}
          </li>
        ))}
        {issues.map((issue) => (
          <li key={`${issue.code}:${issue.nodeId ?? ''}:${issue.field ?? ''}:${issue.message}`}>
            <button
              className={cn(
                'rounded-sm text-left text-paper-300 hover:text-paper-100 disabled:hover:text-paper-300',
                FOCUS_RING
              )}
              disabled={!issue.nodeId || !spec.nodes[issue.nodeId]}
              onClick={() => issue.nodeId && onSelect(issue.nodeId)}
              type="button"
            >
              <span
                className={cn(
                  'font-mono text-[11px]',
                  issue.severity === 'error' ? 'text-brick-400' : 'text-amber-400'
                )}
              >
                {issue.code}
              </span>{' '}
              {formatValidationIssue(issue)}
            </button>
          </li>
        ))}
        {serverExtra.map((issue) => (
          <li
            key={`check:${issue.source}:${issue.code}:${issue.nodeId ?? ''}:${issue.field ?? ''}:${issue.message}`}
          >
            <button
              className={cn(
                'rounded-sm text-left text-paper-300 hover:text-paper-100 disabled:hover:text-paper-300',
                FOCUS_RING
              )}
              disabled={!issue.nodeId || !spec.nodes[issue.nodeId]}
              onClick={() => issue.nodeId && onSelect(issue.nodeId)}
              type="button"
            >
              <span className="mr-1 rounded-sm border border-ink-400 px-1 text-[10px] font-medium text-paper-300 uppercase">
                server: {issue.source}
              </span>{' '}
              <span
                className={cn(
                  'font-mono text-[11px]',
                  issue.severity === 'error' ? 'text-brick-400' : 'text-amber-400'
                )}
              >
                {issue.code}
              </span>{' '}
              {formatValidationIssue(issue)}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
