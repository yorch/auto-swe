import { z } from 'zod';
import {
  APPROVAL_STATUSES,
  CHILD_ROLES,
  CHILD_STATUSES,
  ChildResultSchema,
  MESSAGE_KINDS,
  MESSAGE_ROLES,
  ORCHESTRATION_REFUSAL_CODES,
  ORCHESTRATION_STATUSES,
} from './orchestration.js';

/**
 * Wire shapes of the orchestration REST API (`/api/v1/orchestrations`), shared by the gateway
 * (which produces them), the dashboard and CLI (which consume them) and the worker (which
 * calls the child routes with an orchestration token). Dates are ISO strings on the wire.
 */

export const OrchestrationChildDtoSchema = z.object({
  agentKey: z.string(),
  /** Set when the run opened a branch or draft pull request. */
  branch: z.string().nullable(),
  costUsd: z.number(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  id: z.string(),
  label: z.string(),
  pathScopes: z.array(z.string()),
  prUrl: z.string().nullable(),
  result: ChildResultSchema.nullable(),
  role: z.enum(CHILD_ROLES),
  runId: z.string().nullable(),
  status: z.enum(CHILD_STATUSES),
  /** Steering messages written for the run and not yet taken by its loop. */
  undeliveredSteering: z.number().int(),
  /** The child's `WorkRequest` id; the run viewer finds the run by `workRequestId`. */
  workRequestId: z.string(),
});
export type OrchestrationChildDto = z.infer<typeof OrchestrationChildDtoSchema>;

export const OrchestrationApprovalDtoSchema = z.object({
  /** Redacted description of the arguments; never the values. */
  argumentsDigest: z.string(),
  childId: z.string().nullable(),
  connectionId: z.string(),
  connectionName: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  status: z.enum(APPROVAL_STATUSES),
  toolName: z.string(),
});
export type OrchestrationApprovalDto = z.infer<typeof OrchestrationApprovalDtoSchema>;

export const OrchestrationMessageDtoSchema = z.object({
  authorId: z.string().nullable(),
  body: z.string(),
  /** Set for a message addressed to, or reporting on, one child. */
  childId: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  kind: z.enum(MESSAGE_KINDS),
  /** Kind-specific data: the attach request's reason and candidate, an approval id, a result. */
  payload: z.record(z.string(), z.unknown()).nullable(),
  role: z.enum(MESSAGE_ROLES),
});
export type OrchestrationMessageDto = z.infer<typeof OrchestrationMessageDtoSchema>;

export const OrchestrationSummaryDtoSchema = z.object({
  childCount: z.number().int(),
  costUsd: z.number(),
  createdAt: z.string(),
  id: z.string(),
  launchedById: z.string().nullable(),
  repoId: z.string().nullable(),
  repoName: z.string().nullable(),
  runningChildCount: z.number().int(),
  status: z.enum(ORCHESTRATION_STATUSES),
  teamId: z.string(),
  title: z.string(),
  updatedAt: z.string(),
});
export type OrchestrationSummaryDto = z.infer<typeof OrchestrationSummaryDtoSchema>;

export const OrchestrationDetailDtoSchema = OrchestrationSummaryDtoSchema.extend({
  allowlist: z.array(z.string()),
  budgetTier: z.string(),
  /** True for the launcher: the only caller who sees the message box, attach and approvals. */
  canControl: z.boolean(),
  children: z.array(OrchestrationChildDtoSchema),
  connections: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
  /** Spend of the orchestrator's own turns, of its children, and the sum. */
  cost: z.object({ childrenUsd: z.number(), orchestratorUsd: z.number(), totalUsd: z.number() }),
  launchedByName: z.string().nullable(),
  pendingApprovals: z.array(OrchestrationApprovalDtoSchema),
  /** The one pending repository request, if any. */
  pendingAttach: z
    .object({ candidateRepoId: z.string().nullable(), messageId: z.string(), reason: z.string() })
    .nullable(),
  repoAttachedAt: z.string().nullable(),
  teamName: z.string().nullable(),
});
export type OrchestrationDetailDto = z.infer<typeof OrchestrationDetailDtoSchema>;

export const OrchestrationLaunchResponseSchema = z.object({
  orchestrationId: z.string(),
  status: z.enum(ORCHESTRATION_STATUSES),
  workflowId: z.string(),
});
export type OrchestrationLaunchResponse = z.infer<typeof OrchestrationLaunchResponseSchema>;

export const OrchestrationMessagesPageSchema = z.object({
  data: z.array(OrchestrationMessageDtoSchema),
  /** Pass as `after` to read newer messages; null when the page was empty. */
  next: z.string().nullable(),
});
export type OrchestrationMessagesPage = z.infer<typeof OrchestrationMessagesPageSchema>;

export const OrchestrationBodySchema = z.object({ body: z.string().min(1).max(4000) });
export type OrchestrationBody = z.infer<typeof OrchestrationBodySchema>;

export const AttachRepoBodySchema = z.object({ repoId: z.string().uuid() });
export type AttachRepoBody = z.infer<typeof AttachRepoBodySchema>;

export const ApprovalDecisionBodySchema = z.object({ decision: z.enum(['APPROVE', 'DENY']) });
export type ApprovalDecisionBody = z.infer<typeof ApprovalDecisionBodySchema>;

/** The worker's call to start a child: the validated intent plus the idempotency key of the turn. */
export const SpawnChildResponseSchema = z.object({
  childId: z.string(),
  workflowId: z.string(),
  workRequestId: z.string(),
});
export type SpawnChildResponse = z.infer<typeof SpawnChildResponseSchema>;

/** The error body of a refused child start, message, cancel or attach. */
export const OrchestrationRefusalSchema = z.object({
  code: z.enum(ORCHESTRATION_REFUSAL_CODES),
  message: z.string(),
});
export type OrchestrationRefusal = z.infer<typeof OrchestrationRefusalSchema>;

/**
 * Payloads of the workflow signals. The worker's workflow file cannot import this module at
 * runtime, so it declares the same shapes with `import type` and matching signal names.
 */
export const UserMessageSignalSchema = z.object({ messageId: z.string() });
export const ChildFinishedSignalSchema = z.object({ childId: z.string() });
export const AttachResolvedSignalSchema = z.object({
  accepted: z.boolean(),
  messageId: z.string(),
  repoId: z.string().nullable(),
});
export const ApprovalResolvedSignalSchema = z.object({
  approvalId: z.string(),
  status: z.enum(['APPROVED', 'DENIED']),
});
export type UserMessageSignal = z.infer<typeof UserMessageSignalSchema>;
export type ChildFinishedSignal = z.infer<typeof ChildFinishedSignalSchema>;
export type AttachResolvedSignal = z.infer<typeof AttachResolvedSignalSchema>;
export type ApprovalResolvedSignal = z.infer<typeof ApprovalResolvedSignalSchema>;
