import { prisma } from '@auto-swe/shared/db';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { LessonSummary } from '@auto-swe/shared/types/workflow';
import type { AgentTracer } from './agentTracer.js';
import { retrieveSimilarLessons } from './lessonRetrieval.js';
import { fenceRecalledMemory, memoryInjectionMatches } from './memoryGuard.js';

/**
 * Lesson recall for every agent that works on a repository: the block that is
 * put in a prompt, and what the `searchLessons` / `explainLesson` tools return.
 * All of it is scoped to one repository and passes the memory gate.
 */

/** Characters of query text a recall embeds; the start of a ticket or a failure says what it is about. */
const QUERY_LIMIT = 2_000;

/**
 * The fenced `## Lessons from Previous Workflows` block for `query`, or `''`
 * when nothing clears the threshold or recall fails — recall is optional
 * context and never fails its caller. Each lesson carries its id, so an agent
 * with the `explainLesson` tool can ask where it came from.
 */
export async function recallLessonsBlock(input: {
  repoId: string | null | undefined;
  query: string;
  tracer?: AgentTracer;
  /** Who is recalling, for the trace event. */
  recalledFor: string;
}): Promise<string> {
  const query = input.query.trim().slice(0, QUERY_LIMIT);
  if (!input.repoId || !query) {
    return '';
  }
  try {
    const defaults = await resolveWorkflowDefaults();
    const lessons = await retrieveSimilarLessons(
      query,
      input.repoId,
      defaults.lessonRetrievalLimit,
      defaults.lessonRetrievalThreshold
    );
    if (lessons.length === 0) {
      return '';
    }
    input.tracer?.addActivityEvent({
      name: 'lessons.retrieved',
      outputJson: {
        count: lessons.length,
        lessons: lessons.map((l) => ({ failureType: l.failureType, lessonId: l.lessonId })),
        recalledFor: input.recalledFor,
      },
    });
    return `\n\n${fenceRecalledMemory('## Lessons from Previous Workflows', lessons.map(lessonLine))}`;
  } catch {
    return '';
  }
}

/** One recalled lesson as a prompt bullet: kind, a low-confidence flag, its id, its text. */
export function lessonLine(l: LessonSummary): string {
  const tags = [
    l.failureType ?? 'GENERAL',
    ...(lowConfidence(l.confidence) ? ['low confidence'] : []),
  ];
  return `- [${tags.join(', ')}] (lesson ${l.lessonId}) ${l.summary}`;
}

/**
 * A lesson its writer graded as resting on little evidence. It is still
 * recalled — it may be the only one — but labelled, so the agent weighs it.
 */
export function lowConfidence(confidence: number | null | undefined): boolean {
  return confidence !== null && confidence !== undefined && confidence < 0.5;
}

/** What `searchLessons` returns: the same lessons recall would, for the agent's own query. */
export async function searchLessons(repoId: string, query: string, limit: number) {
  const defaults = await resolveWorkflowDefaults();
  const lessons = await retrieveSimilarLessons(
    query.slice(0, QUERY_LIMIT),
    repoId,
    Math.min(Math.max(1, limit), 10),
    defaults.lessonRetrievalThreshold
  );
  return lessons.map((l) => ({
    confidence: l.confidence,
    failureType: l.failureType,
    lessonId: l.lessonId,
    similarity: Number(l.similarity.toFixed(3)),
    summary: l.summary,
  }));
}

export interface LessonExplanation {
  lessonId: string;
  summary: string;
  rationale: string;
  failureType: string | null;
  confidence: number | null;
  createdAt: string;
  /** The run it was written from, when recorded. */
  workflowRunId: string | null;
  writtenBy: string | null;
  outcome: unknown;
  evidence: unknown;
  /** For a merged lesson: the lessons it was merged from. */
  mergedFrom: Array<{ lessonId: string; summary: string }>;
  /** Older lessons this one replaced. */
  replaced: Array<{ lessonId: string; summary: string }>;
  status: 'active' | 'consolidated' | 'superseded';
}

/**
 * Where a lesson came from, for an agent asking why it was recalled. Only a
 * lesson of `repoId` is explained — an id from another repository answers as
 * not found — and every text field passes the memory gate: a field that reads
 * as an instruction is withheld rather than handed to the agent.
 */
export async function explainLesson(
  repoId: string,
  lessonId: string
): Promise<LessonExplanation | null> {
  const row = await runUnscoped(
    "bounded to the run's own repository by the where clause",
    ['MemoryItem'],
    () =>
      prisma.memoryItem.findFirst({
        select: {
          agentKey: true,
          confidence: true,
          consolidatedAt: true,
          createdAt: true,
          failureType: true,
          id: true,
          lessonSummary: true,
          metadata: true,
          rationale: true,
          supersededAt: true,
          workflowRunId: true,
        },
        where: { id: lessonId, repoId, scope: 'swe-lessons' },
      })
  );
  if (!row) {
    return null;
  }
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const sourceIds = Array.isArray(metadata.consolidatedFrom)
    ? (metadata.consolidatedFrom as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const [sources, replaced] = await runUnscoped(
    "bounded to the run's own repository by the where clause",
    ['MemoryItem'],
    () =>
      Promise.all([
        prisma.memoryItem.findMany({
          select: { id: true, lessonSummary: true },
          where: { id: { in: sourceIds }, repoId },
        }),
        prisma.memoryItem.findMany({
          select: { id: true, lessonSummary: true },
          where: { repoId, supersededById: row.id },
        }),
      ])
  );
  // A read gates on the patterns that ran: a partial scan alone withholds
  // nothing, but a scan that throws, or whose pattern set could not load, withholds
  // the text.
  const gate = async (text: string) => {
    const scan = await memoryInjectionMatches([text]).catch(() => null);
    if (scan === null || scan.loadFailed) {
      return '[withheld: could not be scanned]';
    }
    return scan.matches.length > 0 ? '[withheld: matched an injection pattern]' : text;
  };
  const evidence = metadata.evidence as { quote?: unknown } | undefined;
  return {
    confidence: row.confidence,
    createdAt: row.createdAt.toISOString(),
    evidence:
      evidence && typeof evidence.quote === 'string'
        ? { ...evidence, quote: await gate(evidence.quote) }
        : (evidence ?? null),
    failureType: row.failureType,
    lessonId: row.id,
    mergedFrom: await Promise.all(
      sources.map(async (s) => ({ lessonId: s.id, summary: await gate(s.lessonSummary) }))
    ),
    outcome: metadata.outcome ?? null,
    rationale: await gate(row.rationale),
    replaced: await Promise.all(
      replaced.map(async (s) => ({ lessonId: s.id, summary: await gate(s.lessonSummary) }))
    ),
    status: row.supersededAt ? 'superseded' : row.consolidatedAt ? 'consolidated' : 'active',
    summary: await gate(row.lessonSummary),
    workflowRunId: row.workflowRunId,
    writtenBy: row.agentKey,
  };
}
