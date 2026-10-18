/**
 * The Slack channel sync: re-asks Slack whether each channel is private, and records who is in
 * each private one.
 *
 * Two things depend on it, and both fail closed without it:
 *
 * - `SlackChannel.isPrivate` was read once, at provision. A channel converted to private in Slack
 *   afterwards kept its old value, so its memory stayed a cross-channel source and its content
 *   stayed readable by its whole team. The sync only ever turns the flag ON: an admin may have
 *   marked a public channel private on purpose, and nothing here may undo that.
 * - A private channel's content is shown in the dashboard to the members of its team who are also
 *   in the Slack channel, and only while `membersSyncedAt` is recent. A channel whose member list
 *   could not be read keeps its previous rows and its previous `membersSyncedAt`, which ages out;
 *   nothing is ever granted on a guess.
 *
 * Runs from a Schedule with no `WorkflowRun`, and Temporal persists the result and every log line,
 * so both carry ids, counts and Slack's error codes only — never member ids.
 */
import { prisma } from '@auto-swe/shared/db';
import { resolveSlackBotTokenForSlackChannel } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';

const SLACK_API = 'https://slack.com/api';
const SLACK_TIMEOUT_MS = 10_000;
/** Slack's own page-size ceiling for `conversations.members`. */
const MEMBERS_PAGE_SIZE = 200;
/**
 * A private channel with more members than this is not synced at all. A partial list would be
 * wrong in both directions — it would drop real members — so the channel ages out instead.
 */
export const MAX_SYNCED_MEMBERS = 10_000;

type SlackAnswer<T> = { ok: true; value: T } | { ok: false; error: string };

async function slackGet<T extends { ok?: boolean; error?: string }>(
  method: string,
  params: Record<string, string>,
  token: string
): Promise<SlackAnswer<T>> {
  try {
    const res = await fetch(`${SLACK_API}/${method}?${new URLSearchParams(params).toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { error: `http_${res.status}`, ok: false };
    }
    const data = (await res.json()) as T;
    return data.ok ? { ok: true, value: data } : { error: data.error ?? 'unknown', ok: false };
  } catch {
    // The fetch error's text can carry the URL; only a fixed code leaves this function.
    return { error: 'request_failed', ok: false };
  }
}

/** Whether Slack says the channel is private; an error when it cannot say. */
export async function fetchIsPrivate(
  slackChannelId: string,
  token: string
): Promise<SlackAnswer<boolean>> {
  const answer = await slackGet<{
    ok?: boolean;
    error?: string;
    channel?: { is_private?: unknown };
  }>('conversations.info', { channel: slackChannelId }, token);
  if (!answer.ok) {
    return answer;
  }
  const isPrivate = answer.value.channel?.is_private;
  return typeof isPrivate === 'boolean'
    ? { ok: true, value: isPrivate }
    : { error: 'no_privacy_field', ok: false };
}

/** Every member of the channel, or an error when the whole list could not be read. */
export async function fetchMembers(
  slackChannelId: string,
  token: string
): Promise<SlackAnswer<string[]>> {
  const members = new Set<string>();
  let cursor = '';
  do {
    const answer = await slackGet<{
      ok?: boolean;
      error?: string;
      members?: unknown;
      response_metadata?: { next_cursor?: string };
    }>(
      'conversations.members',
      {
        channel: slackChannelId,
        limit: String(MEMBERS_PAGE_SIZE),
        ...(cursor ? { cursor } : {}),
      },
      token
    );
    if (!answer.ok) {
      return answer;
    }
    if (!Array.isArray(answer.value.members)) {
      return { error: 'no_members_field', ok: false };
    }
    for (const id of answer.value.members) {
      if (typeof id === 'string' && id.length > 0) {
        members.add(id);
      }
    }
    if (members.size > MAX_SYNCED_MEMBERS) {
      return { error: 'too_many_members', ok: false };
    }
    cursor = answer.value.response_metadata?.next_cursor ?? '';
  } while (cursor);
  return { ok: true, value: [...members] };
}

export interface ChannelSyncOutcome {
  channelId: string;
  /** The flag went from public to private on this pass. */
  madePrivate: boolean;
  /** The member list was replaced on this pass. */
  membersSynced: boolean;
  /** Slack's error code for whichever call failed, when one did. */
  error?: string;
}

export interface SlackChannelSyncResult {
  checked: number;
  madePrivate: number;
  membersSynced: number;
  failed: number;
  /** Channels with no bot token to ask with. */
  skipped: number;
  channels: ChannelSyncOutcome[];
}

/** Sync one channel. Never throws for a Slack answer; a database failure propagates to the sweep. */
export async function syncSlackChannel(
  channel: { id: string; slackChannelId: string; isPrivate: boolean },
  token: string,
  now: Date
): Promise<ChannelSyncOutcome> {
  const outcome: ChannelSyncOutcome = {
    channelId: channel.id,
    madePrivate: false,
    membersSynced: false,
  };

  const privacy = await fetchIsPrivate(channel.slackChannelId, token);
  let isPrivate = channel.isPrivate;
  if (privacy.ok) {
    outcome.madePrivate = privacy.value && !channel.isPrivate;
    isPrivate = channel.isPrivate || privacy.value;
    await prisma.slackChannel.update({
      data: { privacyCheckedAt: now, ...(outcome.madePrivate ? { isPrivate: true } : {}) },
      where: { id: channel.id },
    });
    if (outcome.madePrivate) {
      // An audit row, like an admin's edit of the flag: it changes who can read the channel.
      await prisma.configAuditLog.create({
        data: {
          action: 'UPDATE',
          actorId: null,
          afterJson: { isPrivate: true, source: 'slack-channel-sync' },
          beforeJson: { isPrivate: false },
          entityId: channel.id,
          entityType: 'SlackChannel',
        },
      });
    }
  } else {
    outcome.error = privacy.error;
  }

  if (!isPrivate) {
    // A public channel's content does not depend on membership; drop any list it had.
    await prisma.slackChannelMember.deleteMany({ where: { channelId: channel.id } });
    return outcome;
  }

  const members = await fetchMembers(channel.slackChannelId, token);
  if (!members.ok) {
    // Keep the previous list and its timestamp: it ages out on its own.
    outcome.error ??= members.error;
    return outcome;
  }
  await prisma.$transaction([
    prisma.slackChannelMember.deleteMany({ where: { channelId: channel.id } }),
    prisma.slackChannelMember.createMany({
      data: members.value.map((slackUserId) => ({ channelId: channel.id, slackUserId })),
    }),
    prisma.slackChannel.update({ data: { membersSyncedAt: now }, where: { id: channel.id } }),
  ]);
  outcome.membersSynced = true;
  return outcome;
}

/** Sync every active channel, one at a time: the cost is Slack quota against one bot token. */
export async function syncSlackChannels(now = new Date()): Promise<SlackChannelSyncResult> {
  const channels = await runUnscoped(
    "the Slack channel sync checks every team's channels",
    ['SlackChannel'],
    () =>
      prisma.slackChannel.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, isPrivate: true, slackChannelId: true },
        where: { isActive: true },
      })
  );
  const result: SlackChannelSyncResult = {
    channels: [],
    checked: 0,
    failed: 0,
    madePrivate: 0,
    membersSynced: 0,
    skipped: 0,
  };
  for (const channel of channels) {
    const token = await resolveSlackBotTokenForSlackChannel(channel.slackChannelId);
    if (!token) {
      result.skipped++;
      continue;
    }
    let outcome: ChannelSyncOutcome;
    try {
      outcome = await syncSlackChannel(channel, token, now);
    } catch {
      // A database failure on one channel leaves that channel as it was, like a Slack one.
      outcome = {
        channelId: channel.id,
        error: 'database_error',
        madePrivate: false,
        membersSynced: false,
      };
    }
    result.checked++;
    result.madePrivate += outcome.madePrivate ? 1 : 0;
    result.membersSynced += outcome.membersSynced ? 1 : 0;
    result.failed += outcome.error ? 1 : 0;
    result.channels.push(outcome);
  }
  return result;
}
