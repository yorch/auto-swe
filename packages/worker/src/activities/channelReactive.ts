import { resolveSettings } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { type ChannelMemoryItem, retrieveChannelMemory } from '../lib/channelMemory.js';
import { resolvePersonaPrompt } from '../lib/channelPersona.js';
import {
  fetchChannelHistory,
  postSlackChannelMessage,
  type SlackChannelMessage,
} from '../lib/slackNotify.js';
import {
  DEFAULT_CHANNEL_AGENT_KEY,
  isChannelOverBudgetNow,
  runHeldChannelTurn,
} from './channelAssistant.js';
import { SKIP_SENTINEL } from './channelConstants.js';

/** Input for the reactive-interjection activity (mirrors the workflow arg). */
export interface ChannelReactiveInput {
  channelId: string;
}

/** Outcome of one reactive tick — returned for observability + tests. */
export interface ChannelReactiveResult {
  posted: boolean;
  /** Why the tick did (or didn't) post — drives the run record + debugging. */
  reason: 'disabled' | 'no-new-messages' | 'over-budget' | 'cooldown' | 'skip' | 'posted' | 'error';
}

// History depth, memory-item count, lookback window and interjection cooldown
// are registry settings (`channel.*`), resolved per channel through the config
// cascade. The nullable `SlackChannel` columns still win where they are set —
// the registry supplies the default they fall back to, which is what those
// columns' "null = built-in default" contract always meant.

/** Below this length an "interjection" is a trivial ack not worth posting. */
const MIN_INTERJECTION_LENGTH = 12;

/** Per-message char cap when building the transcript (defensive against a huge paste). */
const MAX_MESSAGE_CHARS = 500;

/** Convert a `Date` to a Slack ts string (`"<epoch-seconds>.<micros>"`). */
function dateToSlackTs(date: Date): string {
  return (date.getTime() / 1000).toFixed(6);
}

/**
 * Decide whether a generated interjection should be posted. Mirrors the ambient
 * digest's `shouldPostDigest`: `false` for an empty/trivial reply or one whose
 * trimmed text begins with the `skip` sentinel — keeping reactive mode noise-averse.
 */
export function shouldPostInterjection(reply: string): boolean {
  const trimmed = reply.trim();
  if (trimmed.length < MIN_INTERJECTION_LENGTH) {
    return false;
  }
  return !SKIP_SENTINEL.test(trimmed);
}

/**
 * Build the reactive-interjection prompt from recent channel messages + relevant
 * memory. Pure (no I/O) so it's directly unit-testable. The agent is told to
 * proactively chime in ONLY when it has something genuinely useful to add, and to
 * reply with exactly `SKIP` otherwise — the high bar that keeps the bot from
 * becoming a firehose responder.
 */
export function buildReactivePrompt(
  messages: SlackChannelMessage[],
  memory: ChannelMemoryItem[],
  memoryItemLimit: number
): string {
  const transcript = messages
    .filter((m) => m.text.trim().length > 0)
    .map((m) => {
      const who = m.isBot ? 'assistant' : m.user ? `<@${m.user}>` : 'someone';
      return `${who}: ${m.text.trim().slice(0, MAX_MESSAGE_CHARS)}`;
    })
    .join('\n');

  const memoryBlock =
    memory.length > 0
      ? `\nRelevant context from this channel's memory:\n${memory
          .slice(0, memoryItemLimit)
          .map((m) => `- ${m.summary}`)
          .join('\n')}\n`
      : '';

  return [
    "You are this Slack channel's resident teammate, reading the recent conversation",
    'WITHOUT being directly mentioned. Decide whether to proactively chime in — only',
    'when you can clearly help: answer a question nobody has answered, correct a',
    'stale or wrong fact, or surface directly-relevant context the channel seems to',
    'have forgotten. Hold a HIGH bar: most conversations do not need you.',
    '',
    'Do NOT chime in to agree, acknowledge, chat, or restate what was already said,',
    'and never repeat a point the assistant already made in the transcript below.',
    '',
    'If you have something genuinely useful to add, reply with a brief, friendly',
    'message (a few lines at most). If not — which is the common case — reply with',
    'exactly: SKIP',
    memoryBlock,
    'Recent conversation (oldest first):',
    transcript,
  ].join('\n');
}

/**
 * Reactive interjection (Gap A). Started by the per-channel reactive Temporal
 * Schedule (managed by the gateway on the channel's `reactiveCron`) via the
 * {@link ChannelReactiveWorkflow}. Polls recent channel history and lets the
 * assistant proactively chime in — the difference between "a bot you summon" and
 * "a teammate paying attention."
 *
 * Cost-bounded + noise-averse + best-effort (it never throws — a flaky tick must
 * not spam the channel or crash the schedule):
 *  - **New-message gate:** the LLM fires ONLY when there are human messages newer
 *    than the channel's `lastReactiveCheckAt` cursor (advanced every tick). A quiet
 *    channel costs one cheap Slack read and zero tokens.
 *  - **Budget gate:** over the monthly cap ⇒ no LLM, no post (same gate as the turn).
 *  - **Cooldown:** at most one interjection per `channel.reactiveCooldownMinutes`
 *    (`lastReactiveAt`); on cooldown we skip the LLM entirely (couldn't post anyway).
 *  - **SKIP-aware:** a `SKIP` / empty / trivial reply is not posted.
 *
 * Cost accrues to `ChannelMonthlyUsage`; `countRun` is true only when we actually
 * post (a SKIP is not a user-facing run).
 */
export async function evaluateReactiveInterjection(
  input: ChannelReactiveInput
): Promise<ChannelReactiveResult> {
  try {
    const channel = await prisma.slackChannel.findUnique({
      select: {
        agentKey: true,
        id: true,
        isActive: true,
        lastReactiveAt: true,
        lastReactiveCheckAt: true,
        monthlyBudgetUsdCents: true,
        orgId: true,
        personaPrompt: true,
        reactiveCooldownMinutes: true,
        reactiveEnabled: true,
        reactiveLookbackMinutes: true,
        slackChannelId: true,
        team: { select: { defaultPersonaPrompt: true } },
        teamId: true,
      },
      where: { id: input.channelId },
    });

    // Channel gone, or the schedule is stale (reactive turned off / archived).
    if (!channel?.reactiveEnabled || !channel.isActive) {
      return { posted: false, reason: 'disabled' };
    }

    const tuning = await resolveSettings(
      [
        'channel.historyMessageLimit',
        'channel.memoryContextItems',
        'channel.reactiveCooldownMinutes',
        'channel.reactiveLookbackMinutes',
      ],
      { channelId: channel.id, orgId: channel.orgId, teamId: channel.teamId }
    );
    const reactiveCooldownMs =
      (channel.reactiveCooldownMinutes ?? tuning['channel.reactiveCooldownMinutes']) * 60_000;
    const reactiveLookbackMs =
      (channel.reactiveLookbackMinutes ?? tuning['channel.reactiveLookbackMinutes']) * 60_000;

    const now = new Date();
    // Read messages since the cursor, but never further back than the lookback
    // window (caps the first run / a long-idle channel).
    const lookbackFloor = new Date(now.getTime() - reactiveLookbackMs);
    const cursor =
      channel.lastReactiveCheckAt && channel.lastReactiveCheckAt > lookbackFloor
        ? channel.lastReactiveCheckAt
        : lookbackFloor;

    const messages = await fetchChannelHistory(channel.slackChannelId, {
      limit: tuning['channel.historyMessageLimit'],
      oldestTs: dateToSlackTs(cursor),
    });
    const humanMessages = messages.filter((m) => !m.isBot && m.text.trim().length > 0);

    // Advance the cursor to the newest *fetched* message ts, not `now`. Using
    // `now` would silently drop any messages that arrived between the last
    // fetched ts and the activity-start instant when a gate (budget/cooldown)
    // fires — they would never be re-evaluated on the next tick.
    const newestMsgDate =
      messages.length > 0 ? new Date(parseFloat(messages[messages.length - 1].ts) * 1000) : now;
    const advanceCursor = () =>
      prisma.slackChannel.update({
        data: { lastReactiveCheckAt: newestMsgDate },
        where: { id: channel.id },
      });

    // New-message gate: nothing new from a human → no LLM spend.
    // Only advance the cursor when Slack actually returned messages (even bot-only);
    // an empty fetch may indicate a timeout — don't skip past unseen messages.
    if (humanMessages.length === 0) {
      if (messages.length > 0) {
        await advanceCursor();
      }
      return { posted: false, reason: 'no-new-messages' };
    }

    // Cheap pre-LLM bail: over the cap ⇒ no LLM, no post (still advance the
    // cursor). The hold taken around the model call below is what enforces it.
    if (await isChannelOverBudgetNow(channel.id, channel.monthlyBudgetUsdCents)) {
      await advanceCursor();
      return { posted: false, reason: 'over-budget' };
    }

    // Cooldown: don't interject more than once per window. Skip the LLM entirely
    // (we couldn't post anyway) to keep cost down on a busy channel.
    if (
      channel.lastReactiveAt &&
      now.getTime() - channel.lastReactiveAt.getTime() < reactiveCooldownMs
    ) {
      await advanceCursor();
      return { posted: false, reason: 'cooldown' };
    }

    // Retrieve channel (+ cross-channel team) memory relevant to the recent
    // conversation. Best-effort — a retrieval failure must not block the tick.
    let memory: ChannelMemoryItem[] = [];
    const query = humanMessages
      .map((m) => m.text)
      .join('\n')
      .slice(0, 2000);
    try {
      memory = await retrieveChannelMemory(query, {
        channelId: channel.id,
        teamId: channel.teamId,
      });
    } catch (err) {
      console.error(
        `[channelReactive] memory retrieval failed for ${channel.id}:`,
        err instanceof Error ? err.message : err
      );
    }

    const agentKey = channel.agentKey || DEFAULT_CHANNEL_AGENT_KEY;
    const personaPrompt = await resolvePersonaPrompt(
      channel.personaPrompt,
      channel.team?.defaultPersonaPrompt
    );
    // Holds budget across the model call, so concurrent ticks and turns can't
    // all pass the read above and blow past the cap together.
    const turn = await runHeldChannelTurn(
      {
        agentKey,
        id: channel.id,
        monthlyBudgetUsdCents: channel.monthlyBudgetUsdCents,
        orgId: channel.orgId,
        personaPrompt,
        teamId: channel.teamId,
      },
      buildReactivePrompt(messages, memory, tuning['channel.memoryContextItems']),
      'llm.channel_reactive'
    );
    if (!turn) {
      await advanceCursor();
      return { posted: false, reason: 'over-budget' };
    }
    const { reply, costUsd } = turn;

    const posted = shouldPostInterjection(reply);

    // Settle the LLM cost (it happened). Count a run only when we actually post —
    // a SKIP is a no-op evaluation, not a user-facing turn.
    await turn.hold.settle(costUsd, { countRun: posted });

    // Write cursor + cooldown anchor BEFORE the Slack call (at-most-once semantics):
    // a transient Slack failure after this write can't cause a duplicate post on
    // the next tick. Trade-off: if the Slack call fails we stamp the cooldown for
    // a post that never landed; that's acceptable for a proactive interjection.
    await prisma.slackChannel.update({
      data: {
        lastReactiveCheckAt: newestMsgDate,
        ...(posted ? { lastReactiveAt: now } : {}),
      },
      where: { id: channel.id },
    });

    if (posted) {
      await postSlackChannelMessage(channel.slackChannelId, reply);
    }

    return { posted, reason: posted ? 'posted' : 'skip' };
  } catch (err) {
    // Reactive must never throw loudly / spam: log and report a no-op.
    console.error(
      `[channelReactive] tick failed for ${input.channelId}:`,
      err instanceof Error ? err.message : err
    );
    return { posted: false, reason: 'error' };
  }
}
