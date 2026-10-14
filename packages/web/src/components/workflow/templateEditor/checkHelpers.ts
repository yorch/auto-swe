import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import type { ServerWorkflowIssue } from '@/hooks/useValidateWorkflow';
import { plural } from '@/lib/utils';

/** What the server's save-time checks said about the spec at the click. */
export type ServerCheck =
  | { state: 'pending' }
  | { state: 'done'; issues: ServerWorkflowIssue[] }
  | { state: 'failed'; reason: string };

/** A "Check workflow" snapshot, tied to the spec it was taken on. */
export interface CheckSnapshot {
  spec: WorkflowSpec;
  /** Bumped per click so the live region's text node changes and is announced again. */
  seq: number;
  server: ServerCheck;
}

const SERVER_SCHEMA_CODES = new Set([
  'SCHEMA_INVALID',
  'INVALID_PRESENTATION',
  'SCHEMA_VERSION',
  'SPEC_NOT_OBJECT',
]);

/** Two findings are the same when they name the same problem on the same node and field. */
function issueKey(i: { code: string; nodeId?: string; field?: string }): string {
  // The editor's schema pass reports every parse failure as 'SCHEMA'; the server names the
  // same failures with these codes (specCheck.ts parseSpec). Its INTERNAL_STEP matches the
  // editor's lint finding of that name as is, so it is deliberately not in this set.
  const code = SERVER_SCHEMA_CODES.has(i.code) ? 'SCHEMA' : i.code;
  return `${code}|${i.nodeId ?? ''}|${i.field ?? ''}`;
}

/** The server findings not already among `client`, each reported once. */
export function newServerIssues(
  server: ServerWorkflowIssue[],
  client: { code: string; nodeId?: string; field?: string }[]
): ServerWorkflowIssue[] {
  const seen = new Set(client.map(issueKey));
  const out: ServerWorkflowIssue[] = [];
  for (const issue of server) {
    const key = issueKey(issue);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(issue);
    }
  }
  return out;
}

const NOT_RUN = 'This does not run the workflow.';

/** The announced outcome of "Check workflow": truthful about which checks actually ran. */
export function checkMessage(server: ServerCheck, errors: number, warnings: number): string {
  if (server.state === 'pending') {
    return 'Checking with the server…';
  }
  const failed =
    server.state === 'failed'
      ? `The server check could not run (${server.reason}); showing the editor check only. `
      : '';
  if (errors + warnings === 0) {
    return server.state === 'failed'
      ? `${failed}The editor check found no problems. ${NOT_RUN}`
      : `No problems found by the editor's checks or the server's save checks. ${NOT_RUN}`;
  }
  return `${failed}${plural(errors, 'error')}, ${plural(warnings, 'warning')}. Details are listed below. ${NOT_RUN}`;
}
