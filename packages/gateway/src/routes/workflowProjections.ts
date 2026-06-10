/**
 * Shared helpers for the workflow-templates + workflow-runs routes.
 *
 * Both routes return the same `WorkflowRunSummary` shape (one as paginated
 * runs for a template, the other as the global runs list), and both define
 * the same list-pagination querystring. Keep the projection here so the
 * wire shape stays in lockstep.
 */
import { z } from 'zod';

export const RunListPaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export interface RunWithWorkRequest {
  id: string;
  workflowId: string;
  templateId: string;
  templateVersion: number;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  template?: { name: string } | null;
  workRequest: {
    id: string;
    externalTicketId: string;
    description: string;
  } | null;
}

export function projectRunSummary(r: RunWithWorkRequest) {
  return {
    endedAt: r.endedAt,
    id: r.id,
    startedAt: r.startedAt,
    status: r.status,
    templateId: r.templateId,
    templateName: r.template?.name ?? null,
    templateVersion: r.templateVersion,
    workflowId: r.workflowId,
    workRequest: r.workRequest,
  };
}
