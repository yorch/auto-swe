import type { FastifyInstance } from 'fastify';
import { ApiCatalog } from '../lib/apiCatalog.js';
import { activityAdminRoutes, activityUiRoutes } from './activity.js';
import { adminRoutes } from './admin.js';
import { agentLibraryRoutes, teamAgentLibraryRoutes } from './agentLibrary.js';
import { agentRunRoutes } from './agentRuns.js';
import { agentVersionRoutes } from './agentVersions.js';
import { assistantActionRoutes } from './assistantActions.js';
import { assistantConversationRoutes } from './assistantConversations.js';
import { assistantDiagnosticsRoutes } from './assistantDiagnostics.js';
import { automationRoutes } from './automations.js';
import { autonomyPolicyRoutes } from './autonomyPolicies.js';
import { bundleRoutes } from './bundles.js';
import { callbackEndpointRoutes, runCallbackDeliveryRoutes } from './callbackEndpoints.js';
import { configSettingsRoutes } from './configSettings.js';
import { connectionCredentialRoutes } from './connectionCredentials.js';
import { epicRoutes } from './epics.js';
import { evalRoutes } from './evals.js';
import { eventEndpointRoutes } from './eventEndpoints.js';
import { githubHostCredentialRoutes } from './githubHostCredentials.js';
import { githubInstallationRoutes } from './githubInstallations.js';
import { githubWebhookSecretRoutes } from './githubWebhookSecrets.js';
import { humanErrorBaselineRoutes } from './humanErrorBaselines.js';
import { humanStepRoutes } from './humanSteps.js';
import { inboundEventRoutes } from './inboundEvents.js';
import { knowledgeRoutes } from './knowledge.js';
import { lessonRoutes, runLessonRoutes } from './lessons.js';
import { mcpConnectionRoutes } from './mcpConnections.js';
import { meRoutes } from './me.js';
import { modelCatalogRoutes } from './modelCatalog.js';
import { modelConfigRoutes } from './modelConfig.js';
import { organizationRoutes } from './organizations.js';
import { orgBudgetRoutes } from './orgBudget.js';
import { orgMembersRoutes } from './orgMembers.js';
import { packageRegistryRoutes } from './packageRegistries.js';
import { prdRunRoutes } from './prdRuns.js';
import { prEvaluationRoutes } from './prEvaluation.js';
import { pullRequestRoutes } from './pullRequests.js';
import { readinessRoutes } from './readiness.js';
import { repoDependencyRoutes } from './repoDependencies.js';
import { reportDigestRoutes } from './reportDigests.js';
import { reportsRoutes } from './reports.js';
import { repositoryRoutes } from './repositories.js';
import { scannerPatternRoutes } from './scannerPatterns.js';
import { scheduledWorkRequestRoutes } from './scheduledWorkRequests.js';
import { securityEventRoutes } from './securityEvents.js';
import { servicePrincipalRoutes } from './servicePrincipals.js';
import { skillRevisionRoutes } from './skillRevisions.js';
import { skillSourceRoutes } from './skillSources.js';
import { skillsRoutes, teamAgentSkillRoutes } from './skills.js';
import { slackRoutes } from './slack.js';
import { slackChannelRoutes } from './slackChannels.js';
import { systemConfigRoutes } from './systemConfig.js';
import { teamRoutes } from './teams.js';
import { ticketRoutes } from './tickets.js';
import { tokenRoutes } from './tokens.js';
import { transcriptRoutes } from './transcripts.js';
import { usageRoutes } from './usage.js';
import { userRoutes } from './users.js';
import { webhookRoutes } from './webhooks.js';
import { stepRegistryRoutes, workflowRunRoutes } from './workflowRuns.js';
import { workflowRoutes } from './workflows.js';
import { workflowTemplateRoutes } from './workflowTemplates.js';
import { workRequestRoutes } from './workRequests.js';

/**
 * Register the `/api/v1` route plugins: the authenticated API, plus the webhook and Slack receivers
 * mounted beside it. Kept out of `index.ts` so a test can build the route table production serves
 * (`assistantPolicy.test.ts` walks it).
 */
export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  // Every route registered below, as the assistant's `describeApi` tool lists it.
  const catalog = new ApiCatalog();
  app.addHook('onRoute', (route) => catalog.add(route));

  // ── Personal access tokens (auth required, but self-service for engineers+) ──
  await app.register(tokenRoutes, { prefix: '/api/v1/auth/tokens' });

  // ── Protected routes ──
  await app.register(workRequestRoutes, { prefix: '/api/v1/work-requests' });
  await app.register(agentRunRoutes, { prefix: '/api/v1/agent-runs' });
  await app.register(scheduledWorkRequestRoutes, { prefix: '/api/v1/scheduled-work-requests' });
  await app.register(workflowRoutes, { prefix: '/api/v1/workflows' });
  await app.register(pullRequestRoutes, { prefix: '/api/v1/pull-requests' });
  await app.register(ticketRoutes, { prefix: '/api/v1/tickets' });
  await app.register(workflowTemplateRoutes, { prefix: '/api/v1/workflow-templates' });
  await app.register(reportsRoutes, { prefix: '/api/v1/reports' });
  await app.register(reportDigestRoutes, { prefix: '/api/v1/report-digests' });
  await app.register(humanErrorBaselineRoutes, { prefix: '/api/v1/human-error-baselines' });
  await app.register(organizationRoutes, { prefix: '/api/v1/platform/organizations' });
  // Deprecated alias — kept for one release.
  await app.register(organizationRoutes, { prefix: '/api/v1/admin/organizations' });
  await app.register(workflowRunRoutes, { prefix: '/api/v1/workflow-runs' });
  await app.register(runCallbackDeliveryRoutes, { prefix: '/api/v1/workflow-runs' });
  await app.register(runLessonRoutes, { prefix: '/api/v1/workflow-runs' });
  await app.register(transcriptRoutes);
  await app.register(stepRegistryRoutes, { prefix: '/api/v1/workflow-steps' });
  await app.register(webhookRoutes, { prefix: '/api/v1/webhooks' });
  // Signed events from other services; reads bodies as bytes in its own plugin.
  await app.register(inboundEventRoutes, { prefix: '/api/v1/webhooks/events' });
  await app.register(teamRoutes, { prefix: '/api/v1/teams' });
  await app.register(callbackEndpointRoutes, { prefix: '/api/v1/teams' });
  await app.register(servicePrincipalRoutes, { prefix: '/api/v1/teams' });
  await app.register(eventEndpointRoutes, { prefix: '/api/v1/teams' });
  await app.register(userRoutes, { prefix: '/api/v1/users' });
  await app.register(meRoutes, { prefix: '/api/v1/me' });
  await app.register(prEvaluationRoutes, { prefix: '/api/v1' });
  await app.register(repositoryRoutes, { prefix: '/api/v1/repositories' });
  await app.register(repoDependencyRoutes, { prefix: '/api/v1/repositories' });
  await app.register(automationRoutes, { prefix: '/api/v1/automations' });
  await app.register(connectionCredentialRoutes, { prefix: '/api/v1/repositories' });
  await app.register(lessonRoutes, { prefix: '/api/v1/lessons' });
  await app.register(knowledgeRoutes, { prefix: '/api/v1/knowledge' });
  await app.register(slackRoutes, { prefix: '/api/v1/auth/slack' });
  await app.register(slackChannelRoutes, { prefix: '/api/v1/platform/slack-channels' });
  // Deprecated alias — kept for one release.
  await app.register(slackChannelRoutes, { prefix: '/api/v1/admin/slack-channels' });
  await app.register(epicRoutes, { prefix: '/api/v1/epics' });
  await app.register(prdRunRoutes, { prefix: '/api/v1/prd-runs' });
  await app.register(adminRoutes, { prefix: '/api/v1/platform' });
  await app.register(activityAdminRoutes, { prefix: '/api/v1/platform' });
  await app.register(activityUiRoutes, { prefix: '/api/v1/activity' });
  // Deprecated alias — kept for one release.
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(modelConfigRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(modelConfigRoutes, { prefix: '/api/v1/admin' });
  await app.register(modelCatalogRoutes, { prefix: '/api/v1/platform' });
  await app.register(systemConfigRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(systemConfigRoutes, { prefix: '/api/v1/admin' });
  await app.register(scannerPatternRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(scannerPatternRoutes, { prefix: '/api/v1/admin' });
  await app.register(configSettingsRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(configSettingsRoutes, { prefix: '/api/v1/admin' });
  await app.register(autonomyPolicyRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(autonomyPolicyRoutes, { prefix: '/api/v1/admin' });
  await app.register(githubInstallationRoutes, { prefix: '/api/v1/platform' });
  await app.register(githubInstallationRoutes, { prefix: '/api/v1/admin' });
  await app.register(githubWebhookSecretRoutes, { prefix: '/api/v1/platform' });
  await app.register(githubHostCredentialRoutes, { prefix: '/api/v1/platform' });
  await app.register(packageRegistryRoutes, { prefix: '/api/v1/admin' });
  await app.register(mcpConnectionRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(mcpConnectionRoutes, { prefix: '/api/v1/admin' });
  await app.register(bundleRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(bundleRoutes, { prefix: '/api/v1/admin' });
  await app.register(securityEventRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(securityEventRoutes, { prefix: '/api/v1/admin' });
  await app.register(usageRoutes, { prefix: '/api/v1/platform' });
  await app.register(assistantDiagnosticsRoutes, { prefix: '/api/v1/platform' });
  await app.register(readinessRoutes, { prefix: '/api/v1/platform' });
  await app.register(orgMembersRoutes, { prefix: '/api/v1/platform/organizations' });
  // Deprecated alias — kept for one release.
  await app.register(orgMembersRoutes, { prefix: '/api/v1/admin/organizations' });
  await app.register(orgBudgetRoutes, { prefix: '/api/v1/platform/organizations' });
  // Deprecated alias — kept for one release.
  await app.register(orgBudgetRoutes, { prefix: '/api/v1/admin/organizations' });
  await app.register(skillsRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(skillsRoutes, { prefix: '/api/v1/admin' });
  await app.register(skillSourceRoutes, { prefix: '/api/v1/platform' });
  await app.register(agentLibraryRoutes, { prefix: '/api/v1/platform' });
  await app.register(agentVersionRoutes, { prefix: '/api/v1/platform' });
  await app.register(skillRevisionRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(agentLibraryRoutes, { prefix: '/api/v1/admin' });
  await app.register(evalRoutes, { prefix: '/api/v1/platform' });
  // Deprecated alias — kept for one release.
  await app.register(evalRoutes, { prefix: '/api/v1/admin' });
  await app.register(teamAgentSkillRoutes, { prefix: '/api/v1/teams' });
  await app.register(teamAgentLibraryRoutes, { prefix: '/api/v1/teams' });
  await app.register(humanStepRoutes, { prefix: '/api/v1/human-steps' });
  await app.register(assistantActionRoutes, { prefix: '/api/v1/assistant/actions' });
  await app.register(assistantConversationRoutes, { catalog, prefix: '/api/v1/assistant' });
  // Deprecated alias — kept for one release so existing CLI tokens and bookmarks keep working.
  await app.register(humanStepRoutes, { prefix: '/api/v1/inbox' });
}
