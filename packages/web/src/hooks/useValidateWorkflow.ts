'use client';

import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Which of the server's save-time checks raised an issue. */
export type ServerIssueSource = 'schema' | 'lint' | 'refs' | 'authoring' | 'save';

export interface ServerWorkflowIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;
  field?: string;
  source: ServerIssueSource;
}

export interface ValidateWorkflowResult {
  ok: boolean;
  issues: ServerWorkflowIssue[];
}

export interface ValidateWorkflowBody {
  spec: unknown;
  /** Only to evaluate scope-dependent rules; omitted for a template that is not saved yet. */
  templateId?: string;
  teamId?: string;
  /** The version the edit started from, so a template that has moved on is reported. */
  baseVersion?: number;
  /** The name to save under, so a reserved or taken name is reported. */
  name?: string;
}

/**
 * Asks the gateway to run the checks a save would run (shape, lint, whether the agents and MCP
 * connections exist for the caller, the shell / container authoring gate) without saving or
 * running anything. Needs the LEAD role; the caller treats any failure as "the server check could
 * not run", never as a clean result.
 */
export function useValidateWorkflow() {
  return useMutation({
    mutationFn: (body: ValidateWorkflowBody) =>
      api
        .post<{ data: ValidateWorkflowResult }>('/api/v1/workflow-templates/validate', body)
        .then((r) => r.data),
  });
}
