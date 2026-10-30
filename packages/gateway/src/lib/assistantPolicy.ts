/**
 * What the in-app assistant may do on each gateway route, decided once per route.
 *
 * The assistant calls the same routes the dashboard does, as the user it acts for, so a route's own
 * role gate, visibility filter and audit apply to it unchanged. This table decides the one thing
 * those checks cannot: whether a call made by the assistant, rather than by the person, is allowed
 * at all, and whether it needs the person's confirmation first (`docs/history/in-app-assistant.md`).
 *
 * - `read` — the assistant may call it freely. Every GET that is not refused below.
 * - `{ read: reason }` — a non-GET route that stores nothing, so it is treated as a read. The reason
 *   is required, because "this POST writes nothing" is a claim a reviewer has to check.
 * - `confirm` — the assistant may call it only with a grant the user confirmed for that exact
 *   method, URL and body (`assistantGrants.ts`).
 * - `{ never: reason }` — refused to the assistant whatever the user may do.
 *
 * Default-closed: a route with no entry, every DELETE, and every deprecated alias
 * (`/api/v1/admin/*`, `/api/v1/inbox/*`) is refused. `assistantPolicy.test.ts` walks the registered
 * routes and fails on a route with no entry, so adding a route means deciding this.
 */

export type NeverReason =
  /** A person answers it: a workflow's human step, or the user's own confirmation of an action. */
  | 'humanDecision'
  /** Reads, creates or rotates a credential, token or signing secret. */
  | 'secret'
  /** Manages users, roles, memberships, permission grants or sessions. */
  | 'identity'
  /** Erases data, though not with DELETE. */
  | 'destructive'
  /** Runs compute outside the request — starts a container or a workflow. */
  | 'runsWorkload'
  /**
   * A bulk file download: up to tens of thousands of rows streamed as an attachment, which a tool
   * call cannot consume and which would put the whole file into the conversation.
   */
  | 'bulkExport'
  /** A long-lived event stream, which a tool call cannot consume. */
  | 'stream'
  /** Starts a browser OAuth redirect, which only a person in a browser can complete. */
  | 'oauthFlow'
  /**
   * The assistant panel's own conversations, and the admin view of why other users' replies failed.
   * The assistant reads its conversation through its turn; one that could post here would start
   * turns of its own, and one that read another user's failures would carry their error text into
   * this conversation.
   */
  | 'assistantPanel'
  /**
   * The record of what people were refused and which pages they opened. The assistant acts for one
   * person; it does not read other people's behaviour, and a page view it posted would be its own.
   */
  | 'userActivity';

export type RoutePolicyEntry = 'read' | 'confirm' | { read: string } | { never: NeverReason };

/** The effective decision for one request. */
export type AssistantAccess = 'read' | 'confirm' | 'never';

export const ASSISTANT_ROUTE_POLICY: Readonly<Record<string, RoutePolicyEntry>> = {
  'DELETE /api/v1/report-digests/:id': 'confirm',
  'GET /api/v1/agent-runs/agents': 'read',
  'GET /api/v1/agent-runs/limits': 'read',
  'GET /api/v1/assistant/actions/:id': 'read',
  'GET /api/v1/assistant/api-catalog': 'read',
  'GET /api/v1/assistant/conversations': { never: 'assistantPanel' },
  'GET /api/v1/assistant/conversations/:id': { never: 'assistantPanel' },
  'GET /api/v1/assistant/conversations/:id/messages/:messageId/stream': { never: 'stream' },
  'GET /api/v1/assistant/status': 'read',
  'GET /api/v1/auth/slack/connect': { never: 'oauthFlow' },
  'GET /api/v1/auth/slack/install': { never: 'oauthFlow' },
  'GET /api/v1/auth/tokens': { never: 'secret' },
  'GET /api/v1/automations': 'read',
  'GET /api/v1/automations/events': 'read',
  'GET /api/v1/automations/events/:id/fires': 'read',
  'GET /api/v1/automations/events/templates': 'read',
  'GET /api/v1/epics': 'read',
  'GET /api/v1/epics/:workflowId': 'read',
  'GET /api/v1/human-error-baselines': 'read',
  'GET /api/v1/human-steps': 'read',
  'GET /api/v1/human-steps/:id': 'read',
  'GET /api/v1/human-steps/stream': { never: 'stream' },
  'GET /api/v1/knowledge': 'read',
  'GET /api/v1/knowledge/:id': 'read',
  'GET /api/v1/knowledge/permissions': 'read',
  'GET /api/v1/knowledge/search': 'read',
  'GET /api/v1/lessons': 'read',
  'GET /api/v1/lessons/search': 'read',
  'GET /api/v1/lessons/stats': 'read',
  'GET /api/v1/me/mcp-grants': { never: 'secret' },
  'GET /api/v1/me/preferences': 'read',
  'GET /api/v1/platform/access-tokens': { never: 'secret' },
  'GET /api/v1/platform/activity': { never: 'userActivity' },
  'GET /api/v1/platform/activity/summary': { never: 'userActivity' },
  'GET /api/v1/platform/agent-library': 'read',
  'GET /api/v1/platform/agent-library/:id': 'read',
  'GET /api/v1/platform/agent-library/:id/version-stats': 'read',
  'GET /api/v1/platform/agent-library/:id/versions': 'read',
  'GET /api/v1/platform/assistant/failures': { never: 'assistantPanel' },
  'GET /api/v1/platform/assistant/failures/:messageId': { never: 'assistantPanel' },
  'GET /api/v1/platform/audit-log': 'read',
  'GET /api/v1/platform/audit-log/export': 'read',
  'GET /api/v1/platform/autonomy-decisions': 'read',
  'GET /api/v1/platform/autonomy-policies': 'read',
  'GET /api/v1/platform/autonomy-policies/:id': 'read',
  'GET /api/v1/platform/bundles': 'read',
  'GET /api/v1/platform/bundles/limits': 'read',
  'GET /api/v1/platform/config/audit-log': 'read',
  'GET /api/v1/platform/config/canary': 'read',
  'GET /api/v1/platform/config/consolidation': 'read',
  'GET /api/v1/platform/config/eval-schedule': 'read',
  'GET /api/v1/platform/config/figma': { never: 'secret' },
  'GET /api/v1/platform/config/github': { never: 'secret' },
  'GET /api/v1/platform/config/grants': 'read',
  'GET /api/v1/platform/config/grants/preview': 'read',
  'GET /api/v1/platform/config/issue-tracker': { never: 'secret' },
  'GET /api/v1/platform/config/knowledge-base': { never: 'secret' },
  'GET /api/v1/platform/config/revalidation': 'read',
  'GET /api/v1/platform/config/settings': 'read',
  'GET /api/v1/platform/config/slack': { never: 'secret' },
  'GET /api/v1/platform/config/test-decrypt': { never: 'secret' },
  'GET /api/v1/platform/config/workflow-defaults': 'read',
  'GET /api/v1/platform/credentials': { never: 'secret' },
  'GET /api/v1/platform/embedding-config': { never: 'secret' },
  'GET /api/v1/platform/embedding-config/reembed': 'read',
  'GET /api/v1/platform/evals': 'read',
  'GET /api/v1/platform/evals/:id': 'read',
  'GET /api/v1/platform/evals/results': 'read',
  'GET /api/v1/platform/evals/rubrics': 'read',
  'GET /api/v1/platform/evals/runs': 'read',
  'GET /api/v1/platform/evals/runs/:id': 'read',
  'GET /api/v1/platform/evals/suite-health': 'read',
  'GET /api/v1/platform/evals/trends': 'read',
  'GET /api/v1/platform/github-host-credentials': { never: 'secret' },
  'GET /api/v1/platform/github-installations': 'read',
  'GET /api/v1/platform/github-webhook-secrets': { never: 'secret' },
  'GET /api/v1/platform/mcp-connections': 'read',
  'GET /api/v1/platform/model-catalog': 'read',
  'GET /api/v1/platform/model-catalog/role-pricing': 'read',
  'GET /api/v1/platform/model-catalog/suggestions': 'read',
  'GET /api/v1/platform/model-catalog/unpriced': 'read',
  'GET /api/v1/platform/organizations': 'read',
  'GET /api/v1/platform/organizations/:orgId': 'read',
  'GET /api/v1/platform/organizations/:orgId/budget': 'read',
  'GET /api/v1/platform/organizations/:orgId/members': 'read',
  'GET /api/v1/platform/organizations/budget-alerts': 'read',
  'GET /api/v1/platform/readiness': 'read',
  'GET /api/v1/platform/scanner-patterns': 'read',
  'GET /api/v1/platform/security-events': 'read',
  'GET /api/v1/platform/security-events/summary': 'read',
  'GET /api/v1/platform/sessions': { never: 'identity' },
  'GET /api/v1/platform/skill-sources': 'read',
  'GET /api/v1/platform/skill-sources/:id': 'read',
  'GET /api/v1/platform/skill-sources/:id/diff': 'read',
  'GET /api/v1/platform/skills': 'read',
  'GET /api/v1/platform/skills/:id': 'read',
  'GET /api/v1/platform/skills/:id/revisions': 'read',
  'GET /api/v1/platform/skills/effectiveness': 'read',
  'GET /api/v1/platform/slack-channels': 'read',
  'GET /api/v1/platform/slack-channels/:id': 'read',
  'GET /api/v1/platform/slack-channels/:id/audit': 'read',
  'GET /api/v1/platform/slack-channels/:id/budget': 'read',
  'GET /api/v1/platform/slack-channels/:id/memory': 'read',
  'GET /api/v1/platform/slack-channels/:id/open-items': 'read',
  'GET /api/v1/platform/slack-channels/workspaces': 'read',
  'GET /api/v1/platform/transcripts/access-log': { never: 'secret' },
  'GET /api/v1/platform/transcripts/export': { never: 'secret' },
  'GET /api/v1/platform/usage': 'read',
  'GET /api/v1/platform/usage/export': { never: 'bulkExport' },
  'GET /api/v1/platform/usage/scopes': 'read',
  'GET /api/v1/pr-evaluations': 'read',
  'GET /api/v1/pr-evaluations/:id': 'read',
  'GET /api/v1/pull-requests': 'read',
  'GET /api/v1/pull-requests/outcomes': 'read',
  'GET /api/v1/pull-requests/outcomes/export': { never: 'bulkExport' },
  'GET /api/v1/report-digests': 'read',
  'GET /api/v1/report-digests/unsubscribe': { never: 'secret' },
  'GET /api/v1/reports/automations': 'read',
  'GET /api/v1/reports/budget': 'read',
  'GET /api/v1/reports/delivery': 'read',
  'GET /api/v1/reports/hitl': 'read',
  'GET /api/v1/reports/quality': 'read',
  'GET /api/v1/repositories': 'read',
  'GET /api/v1/repositories/:id/dependencies': 'read',
  'GET /api/v1/repositories/:id/pr-evaluation': 'read',
  'GET /api/v1/repositories/:id/share-candidates': 'read',
  'GET /api/v1/repositories/credentials/mine': { never: 'secret' },
  'GET /api/v1/repositories/dependencies/unresolved': 'read',
  'GET /api/v1/repositories/github/available': 'read',
  'GET /api/v1/scheduled-work-requests': 'read',
  'GET /api/v1/teams': 'read',
  'GET /api/v1/teams/:id': 'read',
  'GET /api/v1/teams/:id/accessible-credentials': { never: 'secret' },
  'GET /api/v1/teams/:id/agent-library': 'read',
  'GET /api/v1/teams/:id/agent-library/options': 'read',
  'GET /api/v1/teams/:id/credentials': { never: 'secret' },
  'GET /api/v1/teams/:id/egress-allowlist': 'read',
  'GET /api/v1/teams/:id/members': 'read',
  'GET /api/v1/teams/:id/shell-image-allowlist': 'read',
  'GET /api/v1/teams/:teamId/callback-endpoints': 'read',
  'GET /api/v1/teams/:teamId/callback-endpoints/:endpointId/deliveries': 'read',
  'GET /api/v1/teams/:teamId/event-endpoints': 'read',
  'GET /api/v1/teams/:teamId/service-principals': { never: 'secret' },
  'GET /api/v1/teams/:teamId/service-principals/:id': { never: 'secret' },
  'GET /api/v1/teams/:teamId/service-principals/:id/tokens': { never: 'secret' },
  'GET /api/v1/teams/:teamId/skills': 'read',
  'GET /api/v1/tickets': 'read',
  'GET /api/v1/transcripts/:id': { never: 'secret' },
  'GET /api/v1/transcripts/:id/content': { never: 'secret' },
  'GET /api/v1/users': 'read',
  'GET /api/v1/users/lookup': 'read',
  'GET /api/v1/work-requests': 'read',
  'GET /api/v1/workflow-runs': 'read',
  'GET /api/v1/workflow-runs/:id': 'read',
  'GET /api/v1/workflow-runs/:id/activity': 'read',
  'GET /api/v1/workflow-runs/:id/activity/export': { never: 'secret' },
  'GET /api/v1/workflow-runs/:id/artifacts/:artifactId': 'read',
  'GET /api/v1/workflow-runs/:id/autonomy-decisions': 'read',
  'GET /api/v1/workflow-runs/:id/callback-deliveries': 'read',
  'GET /api/v1/workflow-runs/:id/eval-results': 'read',
  'GET /api/v1/workflow-runs/:id/http-calls/:callId': { never: 'secret' },
  'GET /api/v1/workflow-runs/:id/lessons': 'read',
  'GET /api/v1/workflow-runs/:id/traces': 'read',
  'GET /api/v1/workflow-runs/:id/transcripts': { never: 'secret' },
  'GET /api/v1/workflow-runs/requests': 'read',
  'GET /api/v1/workflow-steps/registry': 'read',
  'GET /api/v1/workflow-templates': 'read',
  'GET /api/v1/workflow-templates/:id': 'read',
  'GET /api/v1/workflow-templates/:id/analytics': 'read',
  'GET /api/v1/workflow-templates/:id/diff': 'read',
  'GET /api/v1/workflow-templates/:id/runs': 'read',
  'GET /api/v1/workflow-templates/:id/versions/:version': 'read',
  'GET /api/v1/workflow-templates/analytics': 'read',
  'GET /api/v1/workflow-templates/analytics/export': { never: 'bulkExport' },
  'GET /api/v1/workflow-templates/generate/jobs/:jobId': 'read',
  'GET /api/v1/workflows': 'read',
  'GET /api/v1/workflows/:id': 'read',
  'PATCH /api/v1/assistant/conversations/:id': { never: 'assistantPanel' },
  'PATCH /api/v1/automations/events/:id': 'confirm',
  'PATCH /api/v1/me/preferences': 'confirm',
  'PATCH /api/v1/platform/autonomy-policies/:id': 'confirm',
  'PATCH /api/v1/platform/evals/:id/cases/:caseId': 'confirm',
  'PATCH /api/v1/platform/github-host-credentials/:id': { never: 'secret' },
  'PATCH /api/v1/platform/github-installations/:id': 'confirm',
  'PATCH /api/v1/platform/github-webhook-secrets/:id': { never: 'secret' },
  'PATCH /api/v1/platform/mcp-connections/:id': { never: 'secret' },
  'PATCH /api/v1/platform/organizations/:orgId': 'confirm',
  'PATCH /api/v1/platform/organizations/:orgId/budget': 'confirm',
  'PATCH /api/v1/platform/organizations/:orgId/members/:userId': { never: 'identity' },
  'PATCH /api/v1/platform/skill-sources/:id': 'confirm',
  'PATCH /api/v1/platform/slack-channels/:id': 'confirm',
  'PATCH /api/v1/platform/slack-channels/:id/memory/:memoryId': 'confirm',
  'PATCH /api/v1/platform/slack-channels/:id/open-items/:itemId': 'confirm',
  'PATCH /api/v1/report-digests/:id': 'confirm',
  'PATCH /api/v1/repositories/:id': 'confirm',
  'PATCH /api/v1/repositories/:id/dependencies/:edgeId': 'confirm',
  'PATCH /api/v1/scheduled-work-requests/:id': 'confirm',
  'PATCH /api/v1/teams/:id': 'confirm',
  'PATCH /api/v1/teams/:id/members/:userId': { never: 'identity' },
  'PATCH /api/v1/teams/:teamId/callback-endpoints/:endpointId': 'confirm',
  'PATCH /api/v1/teams/:teamId/event-endpoints/:id': 'confirm',
  'PATCH /api/v1/teams/:teamId/service-principals/:id': { never: 'secret' },
  'PATCH /api/v1/users/:id': { never: 'identity' },
  'PATCH /api/v1/workflow-templates/:id': 'confirm',
  'POST /api/auth/device/code': { never: 'oauthFlow' },
  'POST /api/v1/activity/ui': { never: 'userActivity' },
  'POST /api/v1/agent-runs': 'confirm',
  'POST /api/v1/agent-runs/:workRequestId/rerun': 'confirm',
  'POST /api/v1/assistant/actions': {
    read: 'records a proposal the user must confirm; changes nothing else',
  },
  'POST /api/v1/assistant/actions/:id/confirm': { never: 'humanDecision' },
  'POST /api/v1/assistant/actions/:id/decline': { never: 'humanDecision' },
  'POST /api/v1/assistant/conversations': { never: 'assistantPanel' },
  'POST /api/v1/assistant/conversations/:id/close': { never: 'assistantPanel' },
  'POST /api/v1/assistant/conversations/:id/messages': { never: 'assistantPanel' },
  'POST /api/v1/assistant/conversations/:id/title/reset': { never: 'assistantPanel' },
  'POST /api/v1/auth/tokens': { never: 'secret' },
  'POST /api/v1/automations/events': 'confirm',
  'POST /api/v1/automations/events/:id/fires/:fireId/retry': 'confirm',
  'POST /api/v1/epics': 'confirm',
  'POST /api/v1/human-error-baselines': 'confirm',
  'POST /api/v1/human-steps/:id/respond': { never: 'humanDecision' },
  'POST /api/v1/knowledge': 'confirm',
  'POST /api/v1/knowledge/:id/approve': 'confirm',
  'POST /api/v1/knowledge/:id/publish': 'confirm',
  'POST /api/v1/knowledge/:id/reject': 'confirm',
  'POST /api/v1/knowledge/:id/supersede': 'confirm',
  'POST /api/v1/lessons/:id/flags': 'confirm',
  'POST /api/v1/lessons/consolidate': 'confirm',
  'POST /api/v1/platform/agent-library': 'confirm',
  'POST /api/v1/platform/agent-library/:id/restore': 'confirm',
  'POST /api/v1/platform/agent-library/bulk-model': 'confirm',
  'POST /api/v1/platform/agent-library/bulk-model/preview': {
    read: 'a dry run of the bulk model change; stores nothing',
  },
  'POST /api/v1/platform/autonomy-policies': 'confirm',
  'POST /api/v1/platform/bundles/export': 'confirm',
  'POST /api/v1/platform/bundles/install': 'confirm',
  'POST /api/v1/platform/bundles/install-from-url': 'confirm',
  'POST /api/v1/platform/bundles/preview': 'confirm',
  'POST /api/v1/platform/config/consolidation/trigger': 'confirm',
  'POST /api/v1/platform/config/eval-schedule/trigger': 'confirm',
  'POST /api/v1/platform/config/figma/test': 'confirm',
  'POST /api/v1/platform/config/github/test': 'confirm',
  'POST /api/v1/platform/config/grants': { never: 'identity' },
  'POST /api/v1/platform/config/issue-tracker/detect-fields': 'confirm',
  'POST /api/v1/platform/config/issue-tracker/test': 'confirm',
  'POST /api/v1/platform/config/knowledge-base/test': 'confirm',
  'POST /api/v1/platform/config/revalidation/trigger': 'confirm',
  'POST /api/v1/platform/config/slack/test': 'confirm',
  'POST /api/v1/platform/credentials': { never: 'secret' },
  'POST /api/v1/platform/credentials/:id/test': { never: 'secret' },
  'POST /api/v1/platform/embedding-config/reembed': 'confirm',
  'POST /api/v1/platform/evals': 'confirm',
  'POST /api/v1/platform/evals/:id/cases/:caseId/rescreen': 'confirm',
  'POST /api/v1/platform/evals/:id/rescreen': 'confirm',
  'POST /api/v1/platform/evals/rubrics': 'confirm',
  'POST /api/v1/platform/evals/runs': 'confirm',
  'POST /api/v1/platform/github-host-credentials': { never: 'secret' },
  'POST /api/v1/platform/github-installations': 'confirm',
  'POST /api/v1/platform/github-webhook-secrets': { never: 'secret' },
  'POST /api/v1/platform/mcp-connections': { never: 'secret' },
  'POST /api/v1/platform/mcp-connections/:id/test': 'confirm',
  'POST /api/v1/platform/model-catalog': 'confirm',
  'POST /api/v1/platform/model-catalog/:id/reset': 'confirm',
  'POST /api/v1/platform/model-catalog/batch': 'confirm',
  'POST /api/v1/platform/model-catalog/discover': 'confirm',
  'POST /api/v1/platform/model-catalog/price-hints': 'confirm',
  'POST /api/v1/platform/model-catalog/price-hints/batch': 'confirm',
  'POST /api/v1/platform/model-catalog/suggestions/:id/dismiss': 'confirm',
  'POST /api/v1/platform/model-catalog/suggestions/:id/undismiss': 'confirm',
  'POST /api/v1/platform/organizations/:orgId/members': { never: 'identity' },
  'POST /api/v1/platform/organizations/:orgId/members/invite': { never: 'identity' },
  'POST /api/v1/platform/scanner-patterns': 'confirm',
  'POST /api/v1/platform/scanner-patterns/test': {
    read: 'runs a candidate pattern against samples and stores nothing',
  },
  'POST /api/v1/platform/sessions/revoke-user': { never: 'identity' },
  'POST /api/v1/platform/shell-audit/prune': { never: 'destructive' },
  'POST /api/v1/platform/skill-sources': 'confirm',
  'POST /api/v1/platform/skill-sources/:id/accept': 'confirm',
  'POST /api/v1/platform/skill-sources/:id/check': 'confirm',
  'POST /api/v1/platform/skill-sources/:id/install': 'confirm',
  'POST /api/v1/platform/skill-sources/preview': 'confirm',
  'POST /api/v1/platform/skills': 'confirm',
  'POST /api/v1/platform/skills/:id/revisions/:revision/restore': 'confirm',
  'POST /api/v1/platform/skills/:id/verify': 'confirm',
  'POST /api/v1/platform/slack-channels': 'confirm',
  'POST /api/v1/platform/slack-channels/:id/budget/reset': 'confirm',
  'POST /api/v1/platform/slack-channels/memory/erase-user': { never: 'destructive' },
  'POST /api/v1/prd-runs': 'confirm',
  'POST /api/v1/report-digests': 'confirm',
  'POST /api/v1/report-digests/:id/send-test': 'confirm',
  'POST /api/v1/report-digests/unsubscribe': { never: 'secret' },
  'POST /api/v1/repositories': 'confirm',
  'POST /api/v1/repositories/:id/dependencies': 'confirm',
  'POST /api/v1/repositories/:id/dependencies/infer': 'confirm',
  // Starts a workspace container on a candidate image — it may not be driven by a tool call.
  'POST /api/v1/repositories/:id/executor-image/probe': { never: 'runsWorkload' },
  'POST /api/v1/repositories/dependencies/scan': 'confirm',
  'POST /api/v1/scheduled-work-requests': 'confirm',
  'POST /api/v1/scheduled-work-requests/:id/fire': 'confirm',
  'POST /api/v1/teams': 'confirm',
  'POST /api/v1/teams/:id/agent-library': 'confirm',
  'POST /api/v1/teams/:id/credentials': { never: 'secret' },
  'POST /api/v1/teams/:id/members': { never: 'identity' },
  'POST /api/v1/teams/:teamId/callback-endpoints': { never: 'secret' },
  'POST /api/v1/teams/:teamId/callback-endpoints/:endpointId/deliveries/:deliveryId/redeliver':
    'confirm',
  'POST /api/v1/teams/:teamId/callback-endpoints/:endpointId/rotate-secret': { never: 'secret' },
  'POST /api/v1/teams/:teamId/event-endpoints': { never: 'secret' },
  'POST /api/v1/teams/:teamId/event-endpoints/:id/secret/rotate': { never: 'secret' },
  'POST /api/v1/teams/:teamId/service-principals': { never: 'secret' },
  'POST /api/v1/teams/:teamId/service-principals/:id/tokens': { never: 'secret' },
  'POST /api/v1/transcripts/:id/download-link': { never: 'secret' },
  'POST /api/v1/transcripts/:id/verify': { never: 'secret' },
  'POST /api/v1/users': { never: 'identity' },
  'POST /api/v1/users/invite': { never: 'identity' },
  'POST /api/v1/work-requests': 'confirm',
  'POST /api/v1/work-requests/:id/retry': 'confirm',
  'POST /api/v1/workflow-runs/:id/cancel': 'confirm',
  'POST /api/v1/workflow-templates': 'confirm',
  'POST /api/v1/workflow-templates/:id/explain': {
    read: 'describes a template and stores nothing',
  },
  'POST /api/v1/workflow-templates/:id/promote': 'confirm',
  'POST /api/v1/workflow-templates/:id/refine': 'confirm',
  'POST /api/v1/workflow-templates/:id/runs': 'confirm',
  'POST /api/v1/workflow-templates/:id/versions': 'confirm',
  'POST /api/v1/workflow-templates/:id/versions/:version/review': 'confirm',
  'POST /api/v1/workflow-templates/:id/webhook/regenerate': { never: 'secret' },
  'POST /api/v1/workflow-templates/:id/webhook/signing-secret/rotate': { never: 'secret' },
  'POST /api/v1/workflow-templates/generate': 'confirm',
  'POST /api/v1/workflow-templates/generate/jobs': 'confirm',
  'POST /api/v1/workflow-templates/validate': { read: 'checks a spec and stores nothing' },
  'PUT /api/v1/knowledge/:id': 'confirm',
  'PUT /api/v1/platform/agent-library/:id': 'confirm',
  'PUT /api/v1/platform/config/canary': 'confirm',
  'PUT /api/v1/platform/config/consolidation': 'confirm',
  'PUT /api/v1/platform/config/eval-schedule': 'confirm',
  'PUT /api/v1/platform/config/figma': { never: 'secret' },
  'PUT /api/v1/platform/config/github': { never: 'secret' },
  'PUT /api/v1/platform/config/issue-tracker': { never: 'secret' },
  'PUT /api/v1/platform/config/knowledge-base': { never: 'secret' },
  'PUT /api/v1/platform/config/revalidation': 'confirm',
  'PUT /api/v1/platform/config/settings/:key': 'confirm',
  'PUT /api/v1/platform/config/slack': { never: 'secret' },
  'PUT /api/v1/platform/config/workflow-defaults': 'confirm',
  'PUT /api/v1/platform/credentials/:id': { never: 'secret' },
  'PUT /api/v1/platform/embedding-config': { never: 'secret' },
  'PUT /api/v1/platform/model-catalog/:id': 'confirm',
  'PUT /api/v1/platform/scanner-patterns/:id': 'confirm',
  'PUT /api/v1/platform/skills/:id': 'confirm',
  'PUT /api/v1/repositories/:id/credential': { never: 'secret' },
  'PUT /api/v1/repositories/:id/pr-evaluation': { never: 'humanDecision' },
  'PUT /api/v1/repositories/:id/shares': 'confirm',
  'PUT /api/v1/teams/:id/agent-library/:agentId': 'confirm',
  'PUT /api/v1/teams/:id/credentials/:credId': { never: 'secret' },
  'PUT /api/v1/teams/:id/egress-allowlist': 'confirm',
  'PUT /api/v1/teams/:id/shell-image-allowlist': 'confirm',
  'PUT /api/v1/transcripts/:id/legal-hold': { never: 'destructive' },
  'PUT /api/v1/workflow-runs/:id/transcripts/legal-hold': { never: 'destructive' },
  'PUT /api/v1/workflow-templates/:id/webhook/require-signature': 'confirm',
};

/** The table key for a route: its method and its URL pattern as Fastify registered it. */
export function policyKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

/**
 * Whether the assistant may make this call, and how. `url` is the route's registered pattern
 * (`request.routeOptions.url`), never the request's own URL. HEAD is judged as the GET it mirrors.
 */
export function assistantAccess(method: string, url: string | undefined): AssistantAccess {
  const upper = method.toUpperCase();
  if (upper === 'DELETE' || !url) {
    return 'never';
  }
  const entry = ASSISTANT_ROUTE_POLICY[policyKey(upper === 'HEAD' ? 'GET' : upper, url)];
  if (entry === undefined || typeof entry === 'object') {
    return entry !== undefined && 'read' in entry ? 'read' : 'never';
  }
  return entry;
}

/**
 * The table pattern a concrete path matches for `method`, or undefined. A static segment beats a
 * parameter, as in Fastify's router, so `/workflow-templates/validate` is not read as `/:id`. Used
 * only to refuse a proposal the assistant could never carry out; the call itself is judged against
 * the route Fastify matched (`assistantAccess` with `request.routeOptions.url`).
 */
export function policyPatternFor(method: string, path: string): string | undefined {
  const prefix = `${method.toUpperCase()} `;
  const wanted = path.split('?')[0].split('/');
  let best: { pattern: string; staticSegments: number } | undefined;
  for (const key of Object.keys(ASSISTANT_ROUTE_POLICY)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const pattern = key.slice(prefix.length);
    const segments = pattern.split('/');
    if (segments.length !== wanted.length) {
      continue;
    }
    let staticSegments = 0;
    const matches = segments.every((segment, i) => {
      if (segment.startsWith(':')) {
        return wanted[i] !== '';
      }
      staticSegments += 1;
      return segment === wanted[i];
    });
    if (matches && (!best || staticSegments > best.staticSegments)) {
      best = { pattern, staticSegments };
    }
  }
  return best?.pattern;
}
