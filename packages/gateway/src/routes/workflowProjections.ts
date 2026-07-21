/**
 * Shared helpers for the workflow-templates + workflow-runs routes.
 *
 * Both routes return the same `WorkflowRunSummary` shape (one as paginated
 * runs for a template, the other as the global runs list), and both define
 * the same list-pagination querystring. Keep the projection here so the
 * wire shape stays in lockstep.
 */
import type { EvalResultDto } from '@auto-swe/shared/types/api';
import { paginationQuery } from '../lib/pagination.js';

export const RunListPaginationQuery = paginationQuery({ defaultLimit: 50, maxLimit: 100 });

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

/** Shared projection: a captured eval signal row → its wire DTO. Used by both
 *  the per-run endpoint (workflowRuns) and the admin results query (evals). */
export function projectEvalResult(r: {
  id: string;
  runId: string | null;
  nodeId: string | null;
  agentKey: string | null;
  source: EvalResultDto['source'];
  scorer: string;
  scoreType: EvalResultDto['scoreType'];
  value: number;
  passed: boolean | null;
  rationale: string | null;
  metadata: unknown;
  createdAt: Date;
}): EvalResultDto {
  return {
    agentKey: r.agentKey,
    createdAt: r.createdAt.toISOString(),
    id: r.id,
    metadata: r.metadata,
    nodeId: r.nodeId,
    passed: r.passed,
    rationale: r.rationale,
    runId: r.runId,
    scorer: r.scorer,
    scoreType: r.scoreType,
    source: r.source,
    value: r.value,
  };
}
