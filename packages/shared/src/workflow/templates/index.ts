import type { InputSchema } from '../../lib/inputSchema.js';
import type { WorkspaceProviderType } from '../../lib/workspaceProviders.js';
import { BUDGET_TIERS } from '../../types/workflow.js';
import type { WorkflowSpec } from '../spec.js';
import { ADDRESS_PR_FEEDBACK_SPEC, PR_FEEDBACK_INPUT_SCHEMA } from './addressPrFeedback.js';
import { AGENT_REVIEWED_PR_SPEC } from './agentReviewedPr.js';
import { APPROVE_BEFORE_PR_SPEC } from './approveBeforePr.js';
import { CI_TRIAGE_AND_FIX_SPEC, CI_TRIAGE_INPUT_SCHEMA } from './ciTriageAndFix.js';
import { CODE_AND_CI_SPEC } from './codeAndCi.js';
import { CONSENSUS_REVIEW_SPEC } from './consensusReview.js';
import { CREATE_ISSUE_SPEC } from './createIssue.js';
import { CREATE_ISSUE_FROM_BRIEF_SPEC } from './createIssueFromBrief.js';
import { DB_MIGRATION_DRY_RUN_SPEC } from './dbMigrationDryRun.js';
import { DEPENDENCY_UPDATE_SPEC } from './dependencyUpdate.js';
import { EXTERNAL_APPROVAL_GATE_SPEC } from './externalApprovalGate.js';
import { FOUR_EYES_SPEC } from './fourEyes.js';
import { FULLY_SUPERVISED_SPEC } from './fullySupervised.js';
import { HOTFIX_SPEC } from './hotfix.js';
import { HUMAN_CODE_REVIEW_SPEC } from './humanCodeReview.js';
import { ISSUE_TO_CONFLUENCE_PAGE_SPEC } from './issueToConfluencePage.js';
import { MODEL_CATALOG_REFRESH_SPEC } from './modelCatalogRefresh.js';
import { NOTION_CONTENT_BRAND_REVIEW_SPEC } from './notionContentBrandReview.js';
import { NOTION_CONTENT_DRAFT_SPEC } from './notionContentDraft.js';
import { PARALLEL_FAN_OUT_SPEC } from './parallelFanOut.js';
import { PRD_DECOMPOSITION_SPEC } from './prdDecomposition.js';
import { PRODUCT_PRD_DRAFT_SPEC } from './productPrdDraft.js';
import { SCOPE_CLARIFICATION_SPEC } from './scopeClarification.js';
import { SECURITY_TRIAGE_SPEC } from './securityTriage.js';
import { SEND_SLACK_UPDATE_SPEC } from './sendSlackUpdate.js';
import { STAGED_DEPLOY_SIGNALS_SPEC } from './stagedDeploySignals.js';
import { TICKET_TO_MERGE_SPEC } from './ticketToMerge.js';
import { TICKET_TO_MERGE_QODO_SPEC } from './ticketToMergeQodo.js';
import { TIERED_ESCALATION_SPEC } from './tieredEscalation.js';
import { ZENDESK_TICKET_REPLY_SPEC } from './zendeskTicketReply.js';

export interface BuiltinTemplate {
  name: string;
  description: string;
  spec: WorkflowSpec;
  /** Marks the global default used when a team has no team-scoped template. */
  isDefault?: boolean;
  /** Declarative run-input contract; null = accept any payload. */
  inputSchema?: InputSchema;
  /** Workspace provider this template expects; defaults to git_repo for legacy SWE templates. */
  workspaceProvider?: WorkspaceProviderType;
}

/**
 * The SWE run-input contract: a ticket id, the target git_repo Connection, a
 * free-text description, and an optional budget tier. Declared on the default
 * `ticket-to-merge` template so the gateway validates SWE submissions against it
 * (and non-SWE templates can declare their own instead).
 */
export const SWE_INPUT_SCHEMA: InputSchema = {
  properties: {
    budget: { enum: [...BUDGET_TIERS], type: 'string' },
    // `connection`, not a uuid-format string: validation is identical (both
    // must be a UUID), but the run form renders a picker of git_repo
    // connections instead of a field asking the user to paste an id.
    connectionId: { connectionType: 'git_repo', type: 'connection' },
    description: { type: 'string' },
    ticketId: { type: 'string' },
  },
  required: ['ticketId', 'connectionId', 'description'],
  type: 'object',
};

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  // ── Core (always seeded, first is the global default) ────────────────────
  {
    description: TICKET_TO_MERGE_SPEC.description,
    inputSchema: SWE_INPUT_SCHEMA,
    isDefault: true,
    name: TICKET_TO_MERGE_SPEC.name,
    spec: TICKET_TO_MERGE_SPEC,
  },
  {
    // The same run inputs as ticket-to-merge; Qodo's review is read once CI is green.
    description: TICKET_TO_MERGE_QODO_SPEC.description,
    inputSchema: SWE_INPUT_SCHEMA,
    name: TICKET_TO_MERGE_QODO_SPEC.name,
    spec: TICKET_TO_MERGE_QODO_SPEC,
  },

  // ── Automated (no HITL) ──────────────────────────────────────────────────
  { description: HOTFIX_SPEC.description, name: HOTFIX_SPEC.name, spec: HOTFIX_SPEC },
  {
    description: DEPENDENCY_UPDATE_SPEC.description,
    name: DEPENDENCY_UPDATE_SPEC.name,
    spec: DEPENDENCY_UPDATE_SPEC,
  },
  {
    description: MODEL_CATALOG_REFRESH_SPEC.description,
    name: MODEL_CATALOG_REFRESH_SPEC.name,
    spec: MODEL_CATALOG_REFRESH_SPEC,
  },
  {
    description: CODE_AND_CI_SPEC.description,
    name: CODE_AND_CI_SPEC.name,
    spec: CODE_AND_CI_SPEC,
  },
  {
    // Started by a CI-failure trigger (a repository's `workflow_run` webhook), or by hand
    // with a run id. Fix mode opens a draft into the branch that failed.
    description: CI_TRIAGE_AND_FIX_SPEC.description,
    inputSchema: CI_TRIAGE_INPUT_SCHEMA,
    name: CI_TRIAGE_AND_FIX_SPEC.name,
    spec: CI_TRIAGE_AND_FIX_SPEC,
  },
  {
    // Started by a pull-request feedback trigger (a repository's review/comment webhook).
    description: ADDRESS_PR_FEEDBACK_SPEC.description,
    inputSchema: PR_FEEDBACK_INPUT_SCHEMA,
    name: ADDRESS_PR_FEEDBACK_SPEC.name,
    spec: ADDRESS_PR_FEEDBACK_SPEC,
  },
  {
    description: AGENT_REVIEWED_PR_SPEC.description,
    name: AGENT_REVIEWED_PR_SPEC.name,
    spec: AGENT_REVIEWED_PR_SPEC,
  },
  {
    description: CONSENSUS_REVIEW_SPEC.description,
    name: CONSENSUS_REVIEW_SPEC.name,
    spec: CONSENSUS_REVIEW_SPEC,
  },

  // ── Signal-driven ────────────────────────────────────────────────────────
  {
    description: EXTERNAL_APPROVAL_GATE_SPEC.description,
    name: EXTERNAL_APPROVAL_GATE_SPEC.name,
    spec: EXTERNAL_APPROVAL_GATE_SPEC,
  },
  {
    description: STAGED_DEPLOY_SIGNALS_SPEC.description,
    name: STAGED_DEPLOY_SIGNALS_SPEC.name,
    spec: STAGED_DEPLOY_SIGNALS_SPEC,
  },

  // ── Parallel execution ───────────────────────────────────────────────────
  {
    description: PARALLEL_FAN_OUT_SPEC.description,
    name: PARALLEL_FAN_OUT_SPEC.name,
    spec: PARALLEL_FAN_OUT_SPEC,
  },

  // ── HITL examples ────────────────────────────────────────────────────────
  {
    description: APPROVE_BEFORE_PR_SPEC.description,
    name: APPROVE_BEFORE_PR_SPEC.name,
    spec: APPROVE_BEFORE_PR_SPEC,
  },
  {
    description: SCOPE_CLARIFICATION_SPEC.description,
    name: SCOPE_CLARIFICATION_SPEC.name,
    spec: SCOPE_CLARIFICATION_SPEC,
  },
  {
    description: SECURITY_TRIAGE_SPEC.description,
    name: SECURITY_TRIAGE_SPEC.name,
    spec: SECURITY_TRIAGE_SPEC,
  },
  {
    description: HUMAN_CODE_REVIEW_SPEC.description,
    name: HUMAN_CODE_REVIEW_SPEC.name,
    spec: HUMAN_CODE_REVIEW_SPEC,
  },
  {
    description: TIERED_ESCALATION_SPEC.description,
    name: TIERED_ESCALATION_SPEC.name,
    spec: TIERED_ESCALATION_SPEC,
  },
  { description: FOUR_EYES_SPEC.description, name: FOUR_EYES_SPEC.name, spec: FOUR_EYES_SPEC },
  {
    description: DB_MIGRATION_DRY_RUN_SPEC.description,
    name: DB_MIGRATION_DRY_RUN_SPEC.name,
    spec: DB_MIGRATION_DRY_RUN_SPEC,
  },
  {
    description: FULLY_SUPERVISED_SPEC.description,
    name: FULLY_SUPERVISED_SPEC.name,
    spec: FULLY_SUPERVISED_SPEC,
  },

  // ── Record workspace (Zendesk) ───────────────────────────────────────────
  {
    description: ZENDESK_TICKET_REPLY_SPEC.description,
    inputSchema: {
      properties: {
        connectionId: { connectionType: 'zendesk', type: 'connection' },
        instructions: { type: 'string' },
        public: { type: 'boolean' },
        ticketId: { type: 'string' },
      },
      required: ['connectionId', 'ticketId'],
      type: 'object',
    },
    name: ZENDESK_TICKET_REPLY_SPEC.name,
    spec: ZENDESK_TICKET_REPLY_SPEC,
    workspaceProvider: 'record',
  },

  // ── Document workspace (Notion) ──────────────────────────────────────────
  {
    description: NOTION_CONTENT_DRAFT_SPEC.description,
    inputSchema: {
      properties: {
        connectionId: { connectionType: 'notion', type: 'connection' },
        instructions: { type: 'string' },
        sourcePageId: { type: 'string' },
        targetPageId: { type: 'string' },
      },
      required: ['connectionId', 'sourcePageId', 'targetPageId'],
      type: 'object',
    },
    name: NOTION_CONTENT_DRAFT_SPEC.name,
    spec: NOTION_CONTENT_DRAFT_SPEC,
    workspaceProvider: 'document',
  },
  {
    description: NOTION_CONTENT_BRAND_REVIEW_SPEC.description,
    inputSchema: {
      properties: {
        connectionId: { connectionType: 'notion', type: 'connection' },
        instructions: { type: 'string' },
        sourcePageId: { type: 'string' },
        targetPageId: { type: 'string' },
      },
      required: ['connectionId', 'sourcePageId', 'targetPageId'],
      type: 'object',
    },
    name: NOTION_CONTENT_BRAND_REVIEW_SPEC.name,
    spec: NOTION_CONTENT_BRAND_REVIEW_SPEC,
    workspaceProvider: 'document',
  },

  // ── Product pack (PRD draft) ───────────────────────────────────────────────
  {
    description: PRODUCT_PRD_DRAFT_SPEC.description,
    inputSchema: {
      properties: {
        brief: { type: 'string' },
        connectionId: { connectionType: 'notion', type: 'connection' },
        instructions: { type: 'string' },
        sourcePageId: { type: 'string' },
        targetPageId: { type: 'string' },
      },
      required: ['brief', 'connectionId', 'targetPageId'],
      type: 'object',
    },
    name: PRODUCT_PRD_DRAFT_SPEC.name,
    spec: PRODUCT_PRD_DRAFT_SPEC,
    workspaceProvider: 'document',
  },

  // ── Slack / messaging pack ───────────────────────────────────────────────
  {
    description: SEND_SLACK_UPDATE_SPEC.description,
    inputSchema: {
      properties: {
        channelId: { type: 'string' },
        connectionId: { connectionType: 'slack_workspace', type: 'connection' },
        message: { type: 'string' },
      },
      required: ['channelId', 'connectionId', 'message'],
      type: 'object',
    },
    name: SEND_SLACK_UPDATE_SPEC.name,
    spec: SEND_SLACK_UPDATE_SPEC,
    workspaceProvider: 'api_only',
  },

  // ── Issue tracker pack (Linear / Jira) ───────────────────────────────────
  {
    description: CREATE_ISSUE_SPEC.description,
    inputSchema: {
      properties: {
        connectionId: { connectionType: 'issue_tracker', type: 'connection' },
        description: { type: 'string' },
        projectKey: { type: 'string' },
        title: { type: 'string' },
      },
      required: ['connectionId', 'title'],
      type: 'object',
    },
    name: CREATE_ISSUE_SPEC.name,
    spec: CREATE_ISSUE_SPEC,
    workspaceProvider: 'issue_tracker',
  },
  {
    description: CREATE_ISSUE_FROM_BRIEF_SPEC.description,
    inputSchema: {
      properties: {
        brief: { type: 'string' },
        connectionId: { connectionType: 'issue_tracker', type: 'connection' },
        instructions: { type: 'string' },
        projectKey: { type: 'string' },
        title: { type: 'string' },
      },
      required: ['connectionId', 'title', 'brief'],
      type: 'object',
    },
    name: CREATE_ISSUE_FROM_BRIEF_SPEC.name,
    spec: CREATE_ISSUE_FROM_BRIEF_SPEC,
    workspaceProvider: 'issue_tracker',
  },

  // ── Issue tracker -> document (Jira/Linear issue -> Confluence page) ──────
  {
    description: ISSUE_TO_CONFLUENCE_PAGE_SPEC.description,
    inputSchema: {
      properties: {
        connectionId: { connectionType: 'issue_tracker', type: 'connection' },
        docConnectionId: { connectionType: 'confluence', type: 'connection' },
        instructions: { type: 'string' },
        issueId: { type: 'string' },
        spaceKey: { type: 'string' },
        targetPageId: { type: 'string' },
        title: { type: 'string' },
        // The version the caller read before drafting. Supplying it makes the write
        // refuse rather than replace a page that moved on meanwhile. A form leaves
        // an untouched optional number out of the payload entirely
        // (`buildInitialPayload`), so declaring it here does not make a normal
        // launch fail validation.
        version: { integer: true, minimum: 1, type: 'number' },
      },
      required: ['connectionId', 'docConnectionId', 'issueId'],
      type: 'object',
    },
    name: ISSUE_TO_CONFLUENCE_PAGE_SPEC.name,
    spec: ISSUE_TO_CONFLUENCE_PAGE_SPEC,
    workspaceProvider: 'issue_tracker',
  },

  // ── PRD workflow ─────────────────────────────────────────────────────────
  {
    description: PRD_DECOMPOSITION_SPEC.description,
    inputSchema: {
      properties: {
        prdContent: { type: 'string' },
        prdTitle: { type: 'string' },
        projectKey: { type: 'string' },
        repoIds: { items: { format: 'uuid', type: 'string' }, type: 'array' },
      },
      required: ['prdTitle', 'prdContent', 'repoIds'],
      type: 'object',
    },
    name: PRD_DECOMPOSITION_SPEC.name,
    spec: PRD_DECOMPOSITION_SPEC,
  },
];

export { AGENT_REVIEWED_PR_SPEC } from './agentReviewedPr.js';
export { APPROVE_BEFORE_PR_SPEC } from './approveBeforePr.js';
export { CI_TRIAGE_AND_FIX_SPEC, CI_TRIAGE_INPUT_SCHEMA } from './ciTriageAndFix.js';
export { CODE_AND_CI_SPEC } from './codeAndCi.js';
export { CONSENSUS_REVIEW_SPEC } from './consensusReview.js';
export { CREATE_ISSUE_SPEC } from './createIssue.js';
export { CREATE_ISSUE_FROM_BRIEF_SPEC } from './createIssueFromBrief.js';
export { DB_MIGRATION_DRY_RUN_SPEC } from './dbMigrationDryRun.js';
export { DEPENDENCY_UPDATE_SPEC } from './dependencyUpdate.js';
export { EXTERNAL_APPROVAL_GATE_SPEC } from './externalApprovalGate.js';
export { FOUR_EYES_SPEC } from './fourEyes.js';
export { FULLY_SUPERVISED_SPEC } from './fullySupervised.js';
export { HOTFIX_SPEC } from './hotfix.js';
export { HUMAN_CODE_REVIEW_SPEC } from './humanCodeReview.js';
export { ISSUE_TO_CONFLUENCE_PAGE_SPEC } from './issueToConfluencePage.js';
export { MODEL_CATALOG_REFRESH_SPEC } from './modelCatalogRefresh.js';
export { NOTION_CONTENT_BRAND_REVIEW_SPEC } from './notionContentBrandReview.js';
export { NOTION_CONTENT_DRAFT_SPEC } from './notionContentDraft.js';
export { PARALLEL_FAN_OUT_SPEC } from './parallelFanOut.js';
export { PRD_DECOMPOSITION_SPEC } from './prdDecomposition.js';
export { PRODUCT_PRD_DRAFT_SPEC } from './productPrdDraft.js';
export { SCOPE_CLARIFICATION_SPEC } from './scopeClarification.js';
export { SECURITY_TRIAGE_SPEC } from './securityTriage.js';
export { SEND_SLACK_UPDATE_SPEC } from './sendSlackUpdate.js';
export { STAGED_DEPLOY_SIGNALS_SPEC } from './stagedDeploySignals.js';
// Re-export individual specs so callers can import from this module directly.
export { TICKET_TO_MERGE_SPEC } from './ticketToMerge.js';
export { TICKET_TO_MERGE_QODO_SPEC } from './ticketToMergeQodo.js';
export { TIERED_ESCALATION_SPEC } from './tieredEscalation.js';
export { ZENDESK_TICKET_REPLY_SPEC } from './zendeskTicketReply.js';
