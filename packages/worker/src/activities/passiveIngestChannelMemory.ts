import { prisma } from '@auto-swe/shared/db';
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
import { accrueChannelUsage, isChannelOverBudgetNow } from './channelAssistant.js';

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
const DEDUP_THRESHOLD = 0.85;

// ── Prompt ───────────────────────────────────────────────────────────────────

const PASSIVE_INGEST_PROMPT = [
  'You are a silent fact-extractor for a Slack channel.',
  'You will receive a transcript of recent channel messages (human messages only).',
  'Your job is to silently extract at most 5 salient, durable facts worth',
  'remembering about this team, project, or domain — without generating any reply.',
  '',
  'A "salient fact" is something a future channel assistant would find useful when',
  'answering questions or providing context. Examples:',
  '  - "The team deploys every Monday at 9 AM UTC"',
  '  - "The codebase uses Prisma 7 with pgvector for semantic search"',
  '  - "Alice owns the billing module; Bob owns the auth module"',
  '  - "The v2 API migration is blocked on security review"',
  '',
  'Do NOT extract:',
  '  - Casual chit-chat, greetings, or reactions',
  '  - Facts already obvious from the topic/channel name',
  '  - Opinions or speculation without clear team consensus',
  '  - Anything that would be stale within hours',
  '',
  'If there are no salient facts in the transcript, return { "facts": [] }.',
  '',
  'For each fact:',
  '  - `summary`: A clear, concrete sentence (team-agnostic, reusable in future context).',
  '  - `rationale`: Why a future assistant would benefit from knowing this (1 sentence).',
  '',
  'Return valid JSON: { "facts": [ { "summary": "…", "rationale": "…" } ] }',
].join('\n');

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

    // Advance cursor to newest ts seen (even if there are no human messages, we
    // still move past bot-only traffic so we don't re-read it next time).
    if (messages.length > 0) {
      const newestTs = messages[messages.length - 1]?.ts ?? null;
      if (newestTs) {
        await prisma.slackChannel.update({
          data: { passiveIngestCursor: newestTs },
          where: { id: channelId },
        });
      }
    }

    if (humanMessages.length === 0) {
      return EMPTY;
    }

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
      ? `${PASSIVE_INGEST_PROMPT}\n\n${skillSuffix}`
      : PASSIVE_INGEST_PROMPT;

    const agent = new Agent({
      id: 'channel-passive-ingestor',
      instructions,
      model: await getModel('commitToMemory'),
      name: 'channel-passive-ingestor',
    });

    const tracer = new AgentTracer();
    let totalCostUsd = 0;
    let factsExtracted = 0;
    let factsWritten = 0;

    try {
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
      if (totalCostUsd > 0) {
        await accrueChannelUsage(channelId, totalCostUsd, { countRun: false });
      }
    }
  } catch {
    return EMPTY;
  }
}
