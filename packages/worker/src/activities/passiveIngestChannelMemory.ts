import { prisma } from '@auto-swe/shared/db';
import { CHANNEL_PASSIVE_INGEST_PROMPT } from '@auto-swe/shared/lib/agentPrompts';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { loadAgentSkills } from '../lib/config/agentSkills.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { generateEmbeddingWithSpec } from '../lib/embeddings.js';
import { insertMemoryItem, searchMemoryItemsByVector } from '../lib/memoryStore.js';
import { getModel } from '../lib/models.js';
import { fetchChannelHistory } from '../lib/slackNotify.js';
import { isChannelOverBudgetNow, reserveChannelTurn } from './channelAssistant.js';
import { DEFAULT_MEMORY_DEDUP_THRESHOLD } from './channelConstants.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PassiveIngestChannelMemoryInput {
  channelId: string;
}

export interface PassiveIngestChannelMemoryResult {
  messagesRead: number;
  factsExtracted: number;
  factsWritten: number;
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const ExtractedFactSchema = z.object({
  rationale: z.string(),
  summary: z.string(),
});

const PassiveIngestOutputSchema = z.object({
  facts: z.array(ExtractedFactSchema).max(5),
});

// ── Constants ────────────────────────────────────────────────────────────────

const PASSIVE_INGEST_LIMIT = 50;
const DEDUP_THRESHOLD = DEFAULT_MEMORY_DEDUP_THRESHOLD;

// ── Activity ─────────────────────────────────────────────────────────────────

/**
 * Channel assistant passive memory ingestion (Gap G).
 *
 * Runs as the 4th best-effort activity in `ChannelAmbientWorkflow` on each
 * ambient fire. Silently extracts salient facts from recent human messages
 * and writes them to channel memory — no Slack reply is ever posted.
 *
 * Cursor: `SlackChannel.passiveIngestCursor` is a raw Slack `ts` string
 * (e.g. `"1700000000.123456"`). On each fire we fetch messages AFTER this
 * cursor (exclusive), process them, then advance the cursor to the newest ts
 * seen. When the cursor is null we start from the last PASSIVE_INGEST_LIMIT
 * messages (no unbounded catch-up on first enable).
 *
 * De-dup: before writing each fact we embed it and call
 * `searchMemoryItemsByVector` at threshold 0.85. If a highly-similar memory
 * already exists in this channel we skip writing — `consolidateChannelMemory`
 * later handles near-duplicate merging.
 *
 * Budget: honours the channel's monthly budget cap (same gate as the digest).
 * Cost is accrued with `countRun: false` — passive ingest is maintenance.
 */
export async function passiveIngestChannelMemory(
  input: PassiveIngestChannelMemoryInput
): Promise<PassiveIngestChannelMemoryResult> {
  const { channelId } = input;

  const EMPTY: PassiveIngestChannelMemoryResult = {
    factsExtracted: 0,
    factsWritten: 0,
    messagesRead: 0,
  };

  try {
    const channel = await prisma.slackChannel.findUnique({
      select: {
        monthlyBudgetUsdCents: true,
        orgId: true,
        passiveIngestCursor: true,
        passiveIngestEnabled: true,
        slackChannelId: true,
        teamId: true,
      },
      where: { id: channelId },
    });

    if (!channel?.passiveIngestEnabled) {
      return EMPTY;
    }

    if (await isChannelOverBudgetNow(channelId, channel.monthlyBudgetUsdCents ?? null)) {
      return EMPTY;
    }

    // Fetch messages since cursor (exclusive). Returns [] on any Slack API error.
    const messages = await fetchChannelHistory(channel.slackChannelId, {
      limit: PASSIVE_INGEST_LIMIT,
      oldestTs: channel.passiveIngestCursor ?? undefined,
    });

    // Only process human top-level messages with non-empty text.
    const humanMessages = messages.filter((m) => !m.isBot && m.text.trim().length > 0);

    /** Move past everything just read, so the next fire doesn't re-read it. */
    const advanceCursor = async () => {
      const newestTs = messages.at(-1)?.ts;
      if (newestTs) {
        await prisma.slackChannel.update({
          data: { passiveIngestCursor: newestTs },
          where: { id: channelId },
        });
      }
    };

    // Nothing to ingest — advance past the bot-only traffic and stop before
    // holding budget for a pass that will never call a model.
    if (humanMessages.length === 0) {
      await advanceCursor();
      return EMPTY;
    }

    // Hold budget before the cursor moves. A refused ingest must leave the
    // cursor where it was: advancing first and then bailing would skip this
    // window of messages permanently, and a hold is refused more readily than
    // the read above because it consumes headroom.
    const hold = await reserveChannelTurn(channelId, channel.monthlyBudgetUsdCents ?? null, {
      agentKey: 'commitToMemory',
      orgId: channel.orgId,
      teamId: channel.teamId,
    });
    if (hold.overBudget) {
      return EMPTY;
    }
    await advanceCursor();

    const tracer = new AgentTracer();
    let totalCostUsd = 0;
    let factsExtracted = 0;
    let factsWritten = 0;

    // Everything that can throw between here and the settle sits inside the
    // try, so the hold is given back even when agent construction fails — the
    // outer catch would otherwise swallow the throw and strand it.
    try {
      // Build transcript for the LLM (oldest → newest, human only).
      const transcript = humanMessages
        .map((m) => `[${m.user ?? 'unknown'}]: ${m.text.trim()}`)
        .join('\n');

      // Resolve skills + build agent.
      const skills = await loadAgentSkills('commitToMemory');
      const skillSuffix = skills
        .map((s) => s.promptText)
        .filter(Boolean)
        .join('\n\n');
      const instructions = skillSuffix
        ? `${CHANNEL_PASSIVE_INGEST_PROMPT}\n\n${skillSuffix}`
        : CHANNEL_PASSIVE_INGEST_PROMPT;

      const agent = new Agent({
        id: 'channel-passive-ingestor',
        instructions,
        model: await getModel('commitToMemory'),
        name: 'channel-passive-ingestor',
      });

      const start = Date.now();
      const result = await agent.generate([{ content: transcript, role: 'user' }], {
        structuredOutput: { schema: PassiveIngestOutputSchema },
      });

      let attribution = { costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 };
      if (result.usage) {
        attribution = await recordLlmUsage(
          'passiveIngestChannelMemory',
          'commitToMemory',
          result.usage,
          'llm.passive_ingest'
        );
      }
      totalCostUsd += attribution.costUsd;

      if (!result.object) {
        return { ...EMPTY, messagesRead: humanMessages.length };
      }

      const { facts } = PassiveIngestOutputSchema.parse(result.object);
      factsExtracted = facts.length;

      tracer.addLlmResponse({
        costUsd: attribution.costUsd,
        durationMs: Date.now() - start,
        inputJson: { systemPrompt: instructions, userMessage: transcript },
        inputTokens: attribution.inputTokens,
        model: attribution.modelSpec || undefined,
        outputJson: { factsExtracted: facts.length },
        outputTokens: attribution.outputTokens,
        role: 'commitToMemory',
      });

      // Write each fact, skipping near-duplicates.
      for (const fact of facts) {
        try {
          const { embedding, spec } = await generateEmbeddingWithSpec(fact.summary);
          const similar = await searchMemoryItemsByVector({
            limit: 1,
            precomputed: { embedding, spec },
            queryText: fact.summary,
            scopeColumn: 'channel_id',
            scopeId: channelId,
            selectColumns: ['id'],
            similarityThreshold: DEDUP_THRESHOLD,
          });
          if (similar.length > 0) {
            continue;
          }
          await insertMemoryItem({
            agentKey: 'channelAssistant',
            channelId,
            lessonSummary: fact.summary,
            metadata: { source: 'passive-ingest' },
            orgId: channel.orgId,
            rationale: fact.rationale,
            scope: 'channel-memory',
            teamId: channel.teamId,
          });
          factsWritten++;
        } catch {
          // Best-effort per-fact: a failed embedding or DB insert skips this fact
          // but doesn't abort the rest.
        }
      }

      tracer.addActivityEvent({
        name: 'channel_memory.passive_ingest',
        outputJson: { factsExtracted, factsWritten, messagesRead: humanMessages.length },
      });

      return { factsExtracted, factsWritten, messagesRead: humanMessages.length };
    } finally {
      await persistActivityTrace(tracer, 'commitToMemory');
      // Unconditional: an ingest that spent nothing still has to give its hold back.
      await hold.settle(totalCostUsd, { countRun: false });
    }
  } catch {
    return EMPTY;
  }
}
