import crypto from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { isLaunchableAgentKey } from '@auto-swe/shared/lib/agentRun';
import {
  SLACK_RUN_PLAN_TOKEN_TTL_MS,
  signSlackRunPlanToken,
  slackRunPlanIntentHash,
} from '@auto-swe/shared/lib/slackRunPlanToken';
import { resolveSlackConfig } from '@auto-swe/shared/lib/systemConfig';
import { RUN_PLAN_INTENT_MAX_CHARS, runPlanIntentIssue } from '@auto-swe/shared/workflow/runPlan';
import {
  buildProposal,
  explain,
  goalFromSlackMessage,
  PROPOSAL_TEXT,
  type ProposalMessage,
  SLACK_RAW_GOAL_MAX_CHARS,
} from '../lib/channelRunPlanProposal.js';
import {
  decideChannelRepoAccess,
  resolveChannelRepo,
  SLACK_TASK_REFUSAL_MESSAGE,
} from './channelTask.js';

/**
 * Channel assistant: the fixed-code half of the `proposeRun` tool.
 *
 * The tool records only a mode, an agent key and a repository hint. This activity, which runs after
 * the turn, decides everything else: the goal is the invoking person's own message, the repository
 * is one this channel's team may use and the person may reach, and the person must be a linked,
 * active ENGINEER. It then signs a single-use, expiring token binding all of that to the person,
 * the channel and the thread, and returns the Slack message that carries it. It creates no plan,
 * starts no workflow and approves nothing: clicking the button asks the gateway to start
 * generation as the clicker, and a plan is approved only in the dashboard.
 *
 * Nothing here logs the goal text.
 */

export interface ProposeRunIntent {
  mode: 'delivering' | 'output-only';
  agentKey?: string | undefined;
  repoHint?: string | undefined;
}

export interface ProposeChannelRunPlanInput {
  /** SlackChannel.id (our row). */
  channelId: string;
  /** The Slack channel id (`C…`) the proposal is posted in. */
  slackChannelId: string;
  threadTs: string;
  /** The Slack user who wrote the message: the only person who may click the button. */
  userSlackId: string;
  /** That user's message, as the gateway received it (the bot mention already stripped). */
  userText: string;
  intent: ProposeRunIntent;
}

/** What the plan access refusals say when the plan, not a code task, is what was refused. */
const PLAN_REFUSAL_OVERRIDES = {
  'gate-unreadable':
    "I can't offer a plan right now: the access policy could not be read. Try again shortly.",
  'no-linked-account': PROPOSAL_TEXT.linkAccount,
  'repo-unreadable':
    "I can't offer a plan right now: that repository could not be read. Try again shortly.",
} as const;

export async function proposeChannelRunPlan(
  input: ProposeChannelRunPlanInput
): Promise<ProposalMessage> {
  // Over-length text is refused before any parsing, and a goal still over the limit once the
  // markup is gone gets the same reply.
  if (input.userText.length > SLACK_RAW_GOAL_MAX_CHARS) {
    return explain(PROPOSAL_TEXT.tooLong);
  }
  const goal = goalFromSlackMessage(input.userText);
  if (goal.length > RUN_PLAN_INTENT_MAX_CHARS) {
    return explain(PROPOSAL_TEXT.tooLong);
  }
  if (!goal || runPlanIntentIssue(goal) !== null) {
    return explain(PROPOSAL_TEXT.emptyGoal);
  }

  const { agentKey, mode } = input.intent;
  if ((mode === 'output-only') !== (typeof agentKey === 'string' && agentKey.length > 0)) {
    return explain(PROPOSAL_TEXT.incoherentMode);
  }
  if (agentKey !== undefined && !isLaunchableAgentKey(agentKey)) {
    return explain(PROPOSAL_TEXT.agentNotLaunchable);
  }

  // Who is asking: a linked, active platform user. The gateway checks this again when the button
  // is clicked; asking now saves the person a click that cannot work.
  const user = await prisma.user.findFirst({
    select: { id: true },
    where: { isActive: true, slackId: input.userSlackId },
  });
  if (!user) {
    return explain(PROPOSAL_TEXT.linkAccount);
  }

  // The repository comes from the channel's own binding rules. A model's hint is honoured only
  // when the person's own message names it, so a model cannot steer the plan to a repository the
  // person did not mention; otherwise the default (the team's one repository) applies.
  const hint = input.intent.repoHint?.trim();
  const honouredHint = hint && goal.toLowerCase().includes(hint.toLowerCase()) ? hint : undefined;
  const repo = await resolveChannelRepo(input.channelId, honouredHint);
  if (!repo) {
    return explain(PROPOSAL_TEXT.noRepo);
  }

  const verdict = await decideChannelRepoAccess(input.userSlackId, repo.repoId);
  if (!verdict.allowed) {
    const override = (PLAN_REFUSAL_OVERRIDES as Record<string, string>)[verdict.reason];
    return explain(`:lock: ${override ?? SLACK_TASK_REFUSAL_MESSAGE[verdict.reason]}`);
  }

  const connection = await prisma.connection.findUnique({
    select: { organizationName: true, repoName: true },
    where: { id: repo.repoId },
  });
  if (!connection) {
    return explain(PROPOSAL_TEXT.noRepo);
  }

  const { signingSecret } = await resolveSlackConfig();
  if (!signingSecret) {
    return explain(PROPOSAL_TEXT.signingUnavailable);
  }

  const token = signSlackRunPlanToken(
    {
      agentKey: agentKey ?? null,
      channelId: input.slackChannelId,
      exp: Date.now() + SLACK_RUN_PLAN_TOKEN_TTL_MS,
      intent: goal,
      intentHash: slackRunPlanIntentHash(goal),
      jti: crypto.randomBytes(16).toString('hex'),
      mode,
      repoId: repo.repoId,
      slackUserId: input.userSlackId,
      threadTs: input.threadTs,
    },
    signingSecret
  );
  const proposal = buildProposal({
    agentKey: agentKey ?? null,
    goal,
    mode,
    repoLabel: `${connection.organizationName}/${connection.repoName}`,
    token,
  });
  return proposal ?? explain(PROPOSAL_TEXT.tooLong);
}
