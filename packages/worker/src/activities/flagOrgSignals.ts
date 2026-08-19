import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import {
  type OrgChannelMemoryItem,
  recentChannelMemory,
  searchOrgChannelMemory,
} from '../lib/channelMemory.js';
import { generateEmbeddingWithSpec } from '../lib/embeddings.js';
import { postSlackChannelMessage } from '../lib/slackNotify.js';
import { isChannelOverBudgetNow, runHeldChannelTurn } from './channelAssistant.js';
import { SKIP_SENTINEL } from './channelConstants.js';

/** Input for the org-flagging activity (mirrors the workflow arg). */
export interface FlagOrgSignalsInput {
  channelId: string;
}

/** Outcome of one org-flagging pass — returned for observability + tests. */
export interface FlagOrgSignalsResult {
  posted: boolean;
  reason:
    | 'disabled'
    | 'no-interest'
    | 'over-budget'
    | 'cooldown'
    | 'no-signals'
    | 'skip'
    | 'posted'
    | 'error';
}

const DEFAULT_CHANNEL_AGENT_KEY = 'channelAssistant';

/** How much of this channel's recent memory to use as the "what this channel cares about" query. */
const MAX_INTEREST_ITEMS = 10;

/** Cap on cross-org candidate signals injected into the prompt. */
const MAX_ORG_CANDIDATES = 8;

/** Org-wide matches must clear a high similarity bar — flags should be strong, not chatty. */
/** Org flags are digest-level: at most one per this window keeps them rare + signal-rich. */
const DEFAULT_ORG_FLAG_COOLDOWN_MS = 20 * 60 * 60 * 1000; // 20 hours

/** Below this length a "flag" is a trivial reply not worth posting. */
const MIN_FLAG_LENGTH = 12;

/** Cap per candidate summary in the prompt (defensive). */
const MAX_SUMMARY_CHARS = 300;

/**
 * Decide whether a generated org-flag should be posted. Mirrors the ambient
 * digest / reactive `shouldPost*`: `false` for an empty/trivial reply or one whose
 * trimmed text begins with the `skip` sentinel — keeping org flagging noise-averse.
 */
export function shouldPostOrgFlag(reply: string): boolean {
  const trimmed = reply.trim();
  if (trimmed.length < MIN_FLAG_LENGTH) {
    return false;
  }
  return !SKIP_SENTINEL.test(trimmed);
}

/**
 * Build the org-flagging prompt. Pure (no I/O) so it's directly unit-testable.
 * The agent is told to flag cross-org activity ONLY when it is genuinely relevant
 * to this channel's focus, and to reply with exactly `SKIP` otherwise (high bar).
 */
export function buildOrgFlagPrompt(
  interestSummaries: string[],
  candidates: OrgChannelMemoryItem[]
): string {
  const focus = interestSummaries.map((s) => `- ${s}`).join('\n');
  const signals = candidates
    .map((c) => {
      const where = c.sourceChannelName ? `#${c.sourceChannelName}` : 'another channel';
      return `- [${where}] ${c.summary.slice(0, MAX_SUMMARY_CHARS)}`;
    })
    .join('\n');

  return [
    "You are this Slack channel's resident teammate with visibility across the",
    'organization. Below is what THIS channel has been focused on, and some recent',
    'activity from OTHER channels in the org. Decide whether anything in the other',
    'channels is worth proactively flagging here — a connection this channel would',
    'want to know about (related work, a decision elsewhere that affects them, a',
    'duplicated effort). Hold a HIGH bar: most cross-channel activity is NOT worth',
    'interrupting this channel for.',
    '',
    'If you flag something, write a brief, friendly heads-up (a couple of lines) and',
    'name the source channel. If nothing is genuinely worth flagging — the common',
    'case — reply with exactly: SKIP',
    '',
    "This channel's recent focus:",
    focus,
    '',
    'Recent activity in other org channels:',
    signals,
  ].join('\n');
}

/**
 * Channel assistant (Gap B): org-wide proactive flagging. Runs as a best-effort
 * activity on the ambient fire when a channel opts in (`orgFlaggingEnabled`).
 * Surfaces notable activity from OTHER (non-private) channels in the same org into
 * this channel — "flags things from across the organization."
 *
 * Isolation-respecting by construction:
 *  - **Opt-in:** no-op unless `orgFlaggingEnabled` (default off).
 *  - **Private-channel exclusion (Gap G):** `searchOrgChannelMemory` JOINs
 *    `slack_channels` and excludes `is_private = true` SOURCE channels, so a
 *    private channel's content is never flagged elsewhere.
 *  - **Cooldown:** at most one *evaluation* per {@link DEFAULT_ORG_FLAG_COOLDOWN_MS}.
 *    `lastOrgFlagCheckAt` is advanced once the embedding + org search have run —
 *    for the no-signals, skip, AND posted outcomes alike — so a channel that
 *    rarely (or never) flags doesn't re-pay the embedding + pgvector search on
 *    every ambient fire. (The field is a "last checked" anchor, not "last posted".)
 *  - **Budget-gated + SKIP-aware + best-effort:** over budget ⇒ no spend; a
 *    SKIP/empty reply is not posted; never throws.
 *
 * Cost accrues to `ChannelMonthlyUsage` with `countRun: false` (proactive
 * maintenance, not a user-facing run).
 */
export async function flagOrgSignals(input: FlagOrgSignalsInput): Promise<FlagOrgSignalsResult> {
  try {
    const channel = await prisma.slackChannel.findUnique({
      select: {
        agentKey: true,
        id: true,
        isActive: true,
        lastOrgFlagCheckAt: true,
        monthlyBudgetUsdCents: true,
        orgFlagCooldownHours: true,
        orgFlaggingEnabled: true,
        orgId: true,
        personaPrompt: true,
        slackChannelId: true,
        teamId: true,
      },
      where: { id: input.channelId },
    });

    if (!channel?.orgFlaggingEnabled || !channel.isActive) {
      return { posted: false, reason: 'disabled' };
    }

    const orgFlagCooldownMs =
      channel.orgFlagCooldownHours != null
        ? channel.orgFlagCooldownHours * 3_600_000
        : DEFAULT_ORG_FLAG_COOLDOWN_MS;

    const now = new Date();

    // Cooldown first — cheapest gate, skips the embedding + org search + LLM.
    if (
      channel.lastOrgFlagCheckAt &&
      now.getTime() - channel.lastOrgFlagCheckAt.getTime() < orgFlagCooldownMs
    ) {
      return { posted: false, reason: 'cooldown' };
    }

    // Cheap pre-LLM bail. The hold taken around the model call below enforces it.
    if (await isChannelOverBudgetNow(channel.id, channel.monthlyBudgetUsdCents)) {
      return { posted: false, reason: 'over-budget' };
    }

    // What this channel cares about — its recent memory. No memory ⇒ nothing to
    // match cross-org activity against, so skip cheaply.
    const interest = await recentChannelMemory(channel.id, MAX_INTEREST_ITEMS);
    if (interest.length === 0) {
      return { posted: false, reason: 'no-interest' };
    }

    // Embed the channel's focus ONCE and search org-wide (non-private) channels.
    const interestSummaries = interest.map((i) => i.lessonSummary);
    const queryEmbedding = await generateEmbeddingWithSpec(interestSummaries.join('\n'));
    const candidates = await searchOrgChannelMemory({
      excludeChannelId: channel.id,
      limit: MAX_ORG_CANDIDATES,
      orgId: channel.orgId,
      precomputed: queryEmbedding,
      similarityThreshold: await resolveSetting('memory.orgSimilarityThreshold', {
        channelId: channel.id,
        orgId: channel.orgId,
        teamId: channel.teamId,
      }),
    });

    // We've now paid the real cost — the embedding + the org pgvector search — so
    // advance the cooldown for EVERY outcome below (no-signals, skip, posted), not
    // just when we post. Stamping only on a post (or even only on an LLM verdict)
    // would let the common no-signals / SKIP cases re-pay the embedding + search on
    // every ambient fire. Written here (before the LLM + the post) so neither a SKIP
    // nor a Slack-post failure can trigger a re-spend next fire. The field is a
    // "last checked" anchor — see the rename to `lastOrgFlagCheckAt`.
    await prisma.slackChannel.update({
      data: { lastOrgFlagCheckAt: now },
      where: { id: channel.id },
    });

    if (candidates.length === 0) {
      return { posted: false, reason: 'no-signals' };
    }

    const agentKey = channel.agentKey || DEFAULT_CHANNEL_AGENT_KEY;
    // Holds budget across the model call, so concurrent fires can't all pass
    // the read above and blow past the cap together.
    const turn = await runHeldChannelTurn(
      {
        agentKey,
        id: channel.id,
        monthlyBudgetUsdCents: channel.monthlyBudgetUsdCents,
        orgId: channel.orgId,
        personaPrompt: channel.personaPrompt,
        teamId: channel.teamId,
      },
      buildOrgFlagPrompt(interestSummaries, candidates),
      'llm.channel_org_flag'
    );
    if (!turn) {
      return { posted: false, reason: 'over-budget' };
    }
    const { reply, costUsd } = turn;

    const posted = shouldPostOrgFlag(reply);

    // Settle the LLM cost (it happened); count a run only when we actually post.
    await turn.hold.settle(costUsd, { countRun: posted });

    if (posted) {
      // Best-effort: the cost + cooldown are already committed, so a delivery
      // hiccup must not bubble out and cause a re-evaluation next fire.
      try {
        await postSlackChannelMessage(channel.slackChannelId, reply);
      } catch (err) {
        console.error(
          `[flagOrgSignals] post failed for ${channel.id} (flag already accounted):`,
          err instanceof Error ? err.message : err
        );
      }
    }

    return { posted, reason: posted ? 'posted' : 'skip' };
  } catch (err) {
    // Proactive ⇒ quiet on failure: log + report a no-op, never throw/spam. Use a
    // dedicated `error` reason so observability/tests don't conflate a genuine
    // failure with the `disabled` (opted-out) no-op path.
    console.error(
      `[flagOrgSignals] pass failed for ${input.channelId}:`,
      err instanceof Error ? err.message : err
    );
    return { posted: false, reason: 'error' };
  }
}
