import {
  resolveSlackBotTokenForWorkspace,
  resolveWorkflowDefaults,
} from '@auto-swe/shared/lib/systemConfig';
import type { ChannelAssistantTurnInput } from '@auto-swe/shared/types/workflow';
import type { FastifyInstance } from 'fastify';
import { getErrorName } from '../../plugins/auth.js';
import { isUniqueConstraintError } from '../prismaErrors.js';
import { fetchSlackChannelIsPrivate } from '../slack.js';

/**
 * Start a channel-assistant turn, swallowing the REJECT_DUPLICATE rejection.
 * Channel-turn workflow ids are deterministic (`chan-<id>-<ts>` for @mentions,
 * `chan-<id>-ask-<ts>` for the message shortcut) and started with
 * REJECT_DUPLICATE, so a Slack redelivery of the same event — or a double
 * shortcut click on the same message — is rejected here. That's the desired
 * idempotent behaviour: returns `true` when a fresh run started, `false` when it
 * was a duplicate (caller decides whether to log). Other errors propagate.
 */
export async function startChannelTurn(
  fastify: FastifyInstance,
  workflowId: string,
  input: ChannelAssistantTurnInput
): Promise<boolean> {
  try {
    await fastify.temporal.startChannelAssistant(workflowId, input);
    return true;
  } catch (err) {
    if (getErrorName(err) === 'WorkflowExecutionAlreadyStartedError') {
      return false;
    }
    throw err;
  }
}

/**
 * Resolve (or create) the `SlackWorkspace` + `SlackChannel` rows for an incoming
 * event. New workspaces/channels are mapped to the default team (and its org)
 * resolved from the workflow defaults. Returns null when the default team is
 * missing (deployment not seeded) — the caller logs and drops the turn.
 */
export async function provisionChannel(
  fastify: FastifyInstance,
  slackTeamId: string,
  slackChannelId: string,
  opts: { isPrivate?: boolean } = {}
): Promise<{
  id: string;
  teamId: string;
  orgId: string;
  followupSessionEnabled: boolean;
} | null> {
  // The overwhelming majority of events are for a channel that already exists.
  // Answer those from one joined read: everything below — the workflow defaults,
  // the team lookup, the workspace upsert (a write) and the Slack call — is only
  // needed to create a channel for the first time. `findFirst` is not a guarded
  // operation, and the query names the channel outright.
  const CHANNEL_FIELDS = {
    followupSessionEnabled: true,
    id: true,
    orgId: true,
    teamId: true,
  } as const;
  const existing = await fastify.prisma.slackChannel.findFirst({
    select: CHANNEL_FIELDS,
    where: { slackChannelId, workspace: { slackTeamId } },
  });
  if (existing) {
    return existing;
  }

  const { defaultTeamSlug } = await resolveWorkflowDefaults();
  const defaultTeam = await fastify.prisma.team.findUnique({ where: { slug: defaultTeamSlug } });
  if (!defaultTeam) {
    fastify.log.error(
      { defaultTeamSlug },
      'default team not found — cannot auto-provision Slack channel (run `yarn db:seed`)'
    );
    return null;
  }

  // Prisma `upsert` is find-then-create (not atomic), so two concurrent
  // first-mentions can both reach the create branch and one loses the race with
  // a P2002 on the unique constraint. Catch it and re-fetch the now-existing row
  // so a redelivered/concurrent first turn isn't dropped.
  const workspace = await fastify.prisma.slackWorkspace
    .upsert({
      create: { orgId: defaultTeam.orgId, slackTeamId },
      update: {},
      where: { slackTeamId },
    })
    .catch(async (err) => {
      if (isUniqueConstraintError(err)) {
        return fastify.prisma.slackWorkspace.findUnique({ where: { slackTeamId } });
      }
      throw err;
    });
  if (!workspace) {
    fastify.log.error({ slackTeamId }, 'failed to resolve Slack workspace after race');
    return null;
  }

  const channelWhere = {
    workspaceId_slackChannelId: { slackChannelId, workspaceId: workspace.id },
  };

  // Ask Slack rather than trusting the caller's heuristic. This flag decides
  // whether the channel's memory can ever be read by another channel, and it is
  // written on create only — so neither source can undo a later admin override,
  // and the round-trip is paid once per channel rather than once per mention.
  const token = (await resolveSlackBotTokenForWorkspace(slackTeamId)) ?? undefined;
  const authoritative = await fetchSlackChannelIsPrivate(slackChannelId, token);
  const isPrivate = authoritative ?? opts.isPrivate ?? false;
  if (authoritative === null && token) {
    // Falling back to the payload heuristic is the old behaviour, but silently:
    // a missing `groups:read` scope or a flaky call would mark a private channel
    // public *permanently*, since the flag is written on create only.
    fastify.log.warn(
      { isPrivate, slackChannelId },
      'could not read is_private from Slack — provisioning the channel from the payload heuristic'
    );
  }

  // A plain create, since the existence check above already ran. Two concurrent
  // first-mentions can still both get here; the loser re-reads.
  return await fastify.prisma.slackChannel
    .create({
      data: {
        isPrivate,
        orgId: workspace.orgId,
        slackChannelId,
        teamId: defaultTeam.id,
        workspaceId: workspace.id,
      },
      select: CHANNEL_FIELDS,
    })
    .catch(async (err) => {
      if (isUniqueConstraintError(err)) {
        return fastify.prisma.slackChannel.findUnique({
          select: CHANNEL_FIELDS,
          where: channelWhere,
        });
      }
      throw err;
    });
}
