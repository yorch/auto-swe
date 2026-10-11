import type { ValidationIssue, WorkflowSpec } from '@auto-swe/shared/workflow';
import { findInvalidPresentation, WorkflowSpecSchema } from '@auto-swe/shared/workflow';

/**
 * The problems the save will refuse on that `validateSpec` cannot see: it assumes a spec that
 * already parses (an empty title, agentRef or command is a schema failure, not a lint finding).
 * Mirrors the gateway's save path: `findInvalidPresentation`, then `WorkflowSpecSchema`.
 */
export function schemaIssues(spec: WorkflowSpec): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const message of findInvalidPresentation(spec)) {
    const m = /^node '([^']+)'\.(\w+) /.exec(message);
    out.push({
      code: 'SCHEMA',
      severity: 'error',
      ...(m?.[1] ? { nodeId: m[1] } : {}),
      ...(m?.[2] ? { field: m[2] } : {}),
      message,
    });
  }
  const parsed = WorkflowSpecSchema.safeParse(spec);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [head, id, ...rest] = issue.path;
      const nodeId = head === 'nodes' && typeof id === 'string' ? id : undefined;
      const field = (nodeId ? rest : issue.path).map(String).join('.');
      out.push({
        code: 'SCHEMA',
        severity: 'error',
        ...(nodeId ? { nodeId } : {}),
        ...(field ? { field } : {}),
        message: issue.message,
      });
    }
  }
  return out;
}
