import type { InputSchema } from '../../lib/inputSchema.js';
import type { WorkspaceProviderType } from '../../lib/workspaceProviders.js';
import { BUDGET_TIERS } from '../../types/workflow.js';
import type { WorkflowSpec } from '../spec.js';
import { ADDRESS_PR_FEEDBACK_SPEC, PR_FEEDBACK_INPUT_SCHEMA } from './addressPrFeedback.js';
import { AGENT_REVIEWED_PR_SPEC } from './agentReviewedPr.js';
import { APPROVE_BEFORE_PR_SPEC } from './approveBeforePr.js';
import { CI_TRIAGE_AND_FIX_SPEC, CI_TRIAGE_INPUT_SCHEMA } from './ciTriageAndFix.js';
import { CODE_AND_CI_SPEC } from './codeAndCi.js';
import { CODE_REVIEW_SPEC } from './codeReview.js';
import { CODE_REVIEW_QODO_SPEC } from './codeReviewQodo.js';
import { CONFLUENCE_REVIEW_TO_TICKETS_SPEC } from './confluenceReviewToTickets.js';
import { CONSENSUS_REVIEW_SPEC } from './consensusReview.js';
import { CREATE_ISSUE_SPEC } from './createIssue.js';
import { CREATE_ISSUE_FROM_BRIEF_SPEC } from './createIssueFromBrief.js';
import { DB_MIGRATION_DRY_RUN_SPEC } from './dbMigrationDryRun.js';
import { DEPENDENCY_UPDATE_SPEC } from './dependencyUpdate.js';
import {
  DEPENDENCY_UPGRADE_CAMPAIGN_INPUT_SCHEMA,
  DEPENDENCY_UPGRADE_CAMPAIGN_SPEC,
} from './dependencyUpgradeCampaign.js';
import { DOCS_REFRESH_SPEC } from './docsRefresh.js';
import { EXTERNAL_APPROVAL_GATE_SPEC } from './externalApprovalGate.js';
import { FOUR_EYES_SPEC } from './fourEyes.js';
import { FULLY_SUPERVISED_SPEC } from './fullySupervised.js';
import { HOTFIX_SPEC } from './hotfix.js';
import { HUMAN_CODE_REVIEW_SPEC } from './humanCodeReview.js';
import { HUMAN_REVIEW_OF_RUN_SPEC } from './humanReviewOfRun.js';
import {
  INCIDENT_POSTMORTEM_INPUT_SCHEMA,
  INCIDENT_POSTMORTEM_SPEC,
} from './incidentPostmortem.js';
import { INCIDENT_TRIAGE_INPUT_SCHEMA, INCIDENT_TRIAGE_SPEC } from './incidentTriage.js';
import { ISSUE_TO_CONFLUENCE_PAGE_SPEC } from './issueToConfluencePage.js';
import { MODEL_CATALOG_REFRESH_SPEC } from './modelCatalogRefresh.js';
import { NOTION_CONTENT_BRAND_REVIEW_SPEC } from './notionContentBrandReview.js';
import { NOTION_CONTENT_DRAFT_SPEC } from './notionContentDraft.js';
import { PARALLEL_FAN_OUT_SPEC } from './parallelFanOut.js';
import { PRD_DECOMPOSITION_SPEC } from './prdDecomposition.js';
import { PRODUCT_PRD_DRAFT_SPEC } from './productPrdDraft.js';
import { REPO_ONBOARDING_INPUT_SCHEMA, REPO_ONBOARDING_SPEC } from './repoOnboarding.js';
import { SCOPE_CLARIFICATION_SPEC } from './scopeClarification.js';
import { SECURITY_TRIAGE_SPEC } from './securityTriage.js';
import { SEND_SLACK_UPDATE_SPEC } from './sendSlackUpdate.js';
import { STAGED_DEPLOY_SIGNALS_SPEC } from './stagedDeploySignals.js';
import { TICKET_TO_MERGE_SPEC } from './ticketToMerge.js';
import { TICKET_TO_MERGE_QODO_SPEC } from './ticketToMergeQodo.js';
import { TIERED_ESCALATION_SPEC } from './tieredEscalation.js';
import {
  VULNERABILITY_REMEDIATION_INPUT_SCHEMA,
  VULNERABILITY_REMEDIATION_SPEC,
} from './vulnerabilityRemediation.js';
import { ZENDESK_TICKET_REPLY_SPEC } from './zendeskTicketReply.js';

export interface BuiltinTemplate {
  kind?: 'review' | 'automation';
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
    // Fired by a repository schedule or by hand; a run with nothing to change opens no PR.
    description: DOCS_REFRESH_SPEC.description,
    name: DOCS_REFRESH_SPEC.name,
    spec: DOCS_REFRESH_SPEC,
  },
  {
    // The request carries the advisory: a ticket's text, or the fields an inbound event maps.
    description: VULNERABILITY_REMEDIATION_SPEC.description,
    inputSchema: VULNERABILITY_REMEDIATION_INPUT_SCHEMA,
    name: VULNERABILITY_REMEDIATION_SPEC.name,
    spec: VULNERABILITY_REMEDIATION_SPEC,
  },
  {
    // Every child of a campaign runs this template, pinned to one version at launch.
    description: DEPENDENCY_UPGRADE_CAMPAIGN_SPEC.description,
    inputSchema: DEPENDENCY_UPGRADE_CAMPAIGN_INPUT_SCHEMA,
    name: DEPENDENCY_UPGRADE_CAMPAIGN_SPEC.name,
    spec: DEPENDENCY_UPGRADE_CAMPAIGN_SPEC,
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
    kind: 'automation',
    spec: CI_TRIAGE_AND_FIX_SPEC,
  },
  {
    // Started by an inbound-event automation on a PagerDuty endpoint, or by hand with an
    // incident id. Fix mode opens a draft into the repository's base branch.
    description: INCIDENT_TRIAGE_SPEC.description,
    inputSchema: INCIDENT_TRIAGE_INPUT_SCHEMA,
    name: INCIDENT_TRIAGE_SPEC.name,
    spec: INCIDENT_TRIAGE_SPEC,
  },
  {
    // Started by an inbound-event automation on a second PagerDuty endpoint that receives
    // `incident.resolved`, or by hand with an incident id.
    description: INCIDENT_POSTMORTEM_SPEC.description,
    inputSchema: INCIDENT_POSTMORTEM_INPUT_SCHEMA,
    name: INCIDENT_POSTMORTEM_SPEC.name,
    spec: INCIDENT_POSTMORTEM_SPEC,
  },
  {
    // Started by a pull-request feedback trigger (a repository's review/comment webhook).
    description: ADDRESS_PR_FEEDBACK_SPEC.description,
    inputSchema: PR_FEEDBACK_INPUT_SCHEMA,
    name: ADDRESS_PR_FEEDBACK_SPEC.name,
    kind: 'automation',
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

  // ── Document review (Confluence page -> comments -> Jira tickets) ──────────
  {
    description: CONFLUENCE_REVIEW_TO_TICKETS_SPEC.description,
    inputSchema: {
      properties: {
        connectionId: { connectionType: 'confluence', type: 'connection' },
        // What the page is reviewed against; the reviewer falls back to a general rubric.
        criteria: { type: 'string' },
        // Jira issue type names, for a project that does not call them Epic, Story and Sub-task.
        epicIssueType: { type: 'string' },
        instructions: { type: 'string' },
        pageId: { type: 'string' },
        projectKey: { type: 'string' },
        storyIssueType: { type: 'string' },
        subtaskIssueType: { type: 'string' },
        trackerConnectionId: { connectionType: 'issue_tracker', type: 'connection' },
      },
      required: ['connectionId', 'pageId', 'trackerConnectionId'],
      type: 'object',
    },
    name: CONFLUENCE_REVIEW_TO_TICKETS_SPEC.name,
    spec: CONFLUENCE_REVIEW_TO_TICKETS_SPEC,
    workspaceProvider: 'document',
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
  {
    name: REPO_ONBOARDING_SPEC.name,
    description: REPO_ONBOARDING_SPEC.description,
    spec: REPO_ONBOARDING_SPEC,
    inputSchema: REPO_ONBOARDING_INPUT_SCHEMA,
  },
  ...[CODE_REVIEW_SPEC, CODE_REVIEW_QODO_SPEC, HUMAN_REVIEW_OF_RUN_SPEC].map((spec) => ({
    description: spec.description,
    kind: 'review' as const,
    name: spec.name,
    spec,
  })),
];

export { AGENT_REVIEWED_PR_SPEC } from './agentReviewedPr.js';
export { APPROVE_BEFORE_PR_SPEC } from './approveBeforePr.js';
export { CI_TRIAGE_AND_FIX_SPEC, CI_TRIAGE_INPUT_SCHEMA } from './ciTriageAndFix.js';
export { CODE_AND_CI_SPEC } from './codeAndCi.js';
export { CODE_REVIEW_SPEC } from './codeReview.js';
export { CODE_REVIEW_QODO_SPEC } from './codeReviewQodo.js';
export { CONFLUENCE_REVIEW_TO_TICKETS_SPEC } from './confluenceReviewToTickets.js';
export { CONSENSUS_REVIEW_SPEC } from './consensusReview.js';
export { CREATE_ISSUE_SPEC } from './createIssue.js';
export { CREATE_ISSUE_FROM_BRIEF_SPEC } from './createIssueFromBrief.js';
export { DB_MIGRATION_DRY_RUN_SPEC } from './dbMigrationDryRun.js';
export { DEPENDENCY_UPDATE_SPEC } from './dependencyUpdate.js';
export {
  DEPENDENCY_UPGRADE_CAMPAIGN_INPUT_SCHEMA,
  DEPENDENCY_UPGRADE_CAMPAIGN_SPEC,
} from './dependencyUpgradeCampaign.js';
export { DOCS_REFRESH_SPEC } from './docsRefresh.js';
export { EXTERNAL_APPROVAL_GATE_SPEC } from './externalApprovalGate.js';
export { FOUR_EYES_SPEC } from './fourEyes.js';
export { FULLY_SUPERVISED_SPEC } from './fullySupervised.js';
export { HOTFIX_SPEC } from './hotfix.js';
export { HUMAN_CODE_REVIEW_SPEC } from './humanCodeReview.js';
export { HUMAN_REVIEW_OF_RUN_SPEC } from './humanReviewOfRun.js';
export {
  INCIDENT_POSTMORTEM_INPUT_SCHEMA,
  INCIDENT_POSTMORTEM_SPEC,
} from './incidentPostmortem.js';
export {
  INCIDENT_TRIAGE_DEFAULT_MIN_FIX_CONFIDENCE,
  INCIDENT_TRIAGE_INPUT_SCHEMA,
  INCIDENT_TRIAGE_SPEC,
} from './incidentTriage.js';
export { ISSUE_TO_CONFLUENCE_PAGE_SPEC } from './issueToConfluencePage.js';
export { MODEL_CATALOG_REFRESH_SPEC } from './modelCatalogRefresh.js';
export { NOTION_CONTENT_BRAND_REVIEW_SPEC } from './notionContentBrandReview.js';
export { NOTION_CONTENT_DRAFT_SPEC } from './notionContentDraft.js';
export { PARALLEL_FAN_OUT_SPEC } from './parallelFanOut.js';
export { PRD_DECOMPOSITION_SPEC } from './prdDecomposition.js';
export { PRODUCT_PRD_DRAFT_SPEC } from './productPrdDraft.js';
export { REPO_ONBOARDING_INPUT_SCHEMA, REPO_ONBOARDING_SPEC } from './repoOnboarding.js';
export { SCOPE_CLARIFICATION_SPEC } from './scopeClarification.js';
export { SECURITY_TRIAGE_SPEC } from './securityTriage.js';
export { SEND_SLACK_UPDATE_SPEC } from './sendSlackUpdate.js';
export { STAGED_DEPLOY_SIGNALS_SPEC } from './stagedDeploySignals.js';
// Re-export individual specs so callers can import from this module directly.
export { TICKET_TO_MERGE_SPEC } from './ticketToMerge.js';
export { TICKET_TO_MERGE_QODO_SPEC } from './ticketToMergeQodo.js';
export { TIERED_ESCALATION_SPEC } from './tieredEscalation.js';
export {
  VULNERABILITY_REMEDIATION_INPUT_SCHEMA,
  VULNERABILITY_REMEDIATION_SPEC,
  VULNERABILITY_SEVERITIES,
} from './vulnerabilityRemediation.js';
export { ZENDESK_TICKET_REPLY_SPEC } from './zendeskTicketReply.js';
