import { type EvalMemoryMode, evalCorpusHash } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { z } from 'zod';
import type { AgentTracer } from './agentTracer.js';
import { generateEmbeddingWithSpec } from './embeddings.js';
import { fenceRecalledMemory, withoutFlaggedMemory } from './memoryGuard.js';

export interface EvalCorpusLesson {
  id: string;
  content: string;
  failureType: string | null;
  embedding: number[];
  embeddingModel: string;
}
export interface EvalMemoryContext {
  mode: EvalMemoryMode;
  corpus: EvalCorpusLesson[];
}
export interface EvalLessonTool {
  name: string;
  description: string;
  schema: z.ZodObject;
  call: (args: unknown) => Promise<unknown>;
}

export async function loadEvalCorpus(datasetId: string): Promise<EvalCorpusLesson[]> {
  const rows = await prisma.$queryRaw<(Omit<EvalCorpusLesson, 'embedding'> & { vector: string })[]>`
    SELECT id, content, failure_type AS "failureType", embedding::text AS vector, embedding_model AS "embeddingModel"
    FROM eval_lessons WHERE dataset_id = ${datasetId}::uuid ORDER BY content, failure_type, id LIMIT 51
  `;
  if (rows.length > 50) {
    throw new Error('Eval corpus exceeds 50 lessons');
  }
  return rows.map(({ vector, ...row }) => ({ ...row, embedding: JSON.parse(vector) as number[] }));
}

export function verifyEvalCorpus(
  corpus: EvalCorpusLesson[],
  hash: string | null,
  modes: EvalMemoryMode[]
): void {
  if (hash !== null && evalCorpusHash(corpus) !== hash) {
    throw new Error('Eval lesson corpus changed since launch; start a new eval run');
  }
  if (modes.some((mode) => mode !== 'OFF') && (!hash || corpus.length === 0)) {
    throw new Error('Eval memory requires a pinned, nonempty corpus');
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] ** 2;
    bb += b[i] ** 2;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

export function evalLessonRecall(
  memory: EvalMemoryContext,
  caseId: string,
  ref: string,
  tracer: AgentTracer
) {
  let exposed = false;
  const event = (
    lessons: { lessonId: string; failureType: string | null; similarity: number }[],
    recalledFor: string
  ) => {
    exposed ||= lessons.length > 0;
    tracer.addActivityEvent({
      name: memory.mode === 'SHADOW' ? 'lessons.shadow_retrieved' : 'lessons.retrieved',
      outputJson: {
        arm: memory.mode,
        caseId,
        count: lessons.length,
        lessonIds: lessons.map((l) => l.lessonId),
        lessons,
        promptInjected: recalledFor === 'implementer' && memory.mode === 'ON' && lessons.length > 0,
        recalledFor,
        ref,
        result: lessons.length ? 'matched' : 'no_match',
      },
    });
  };
  const search = async (query: string, limit?: number) => {
    const defaults = await resolveWorkflowDefaults();
    const vector = await generateEmbeddingWithSpec(query.slice(0, 2000));
    if (memory.corpus.some((l) => l.embeddingModel !== vector.spec)) {
      throw new Error(
        'Eval corpus embedding model changed; replace the corpus and launch a new run'
      );
    }
    const safe = await withoutFlaggedMemory(memory.corpus, (lesson) => lesson.content);
    const lessons = safe
      .map((lesson) => ({
        ...lesson,
        lessonId: lesson.id,
        similarity: cosine(vector.embedding, lesson.embedding),
      }))
      .filter((l) => l.similarity >= defaults.lessonRetrievalThreshold)
      .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))
      .slice(0, limit ?? defaults.lessonRetrievalLimit);
    return lessons;
  };
  return {
    get exposed() {
      return exposed;
    },
    async prompt(query: string): Promise<string> {
      if (memory.mode === 'OFF') {
        return '';
      }
      const lessons = await search(query);
      event(lessons, 'implementer');
      return memory.mode === 'ON' && lessons.length
        ? `\n\n${fenceRecalledMemory(
            '## Lessons from Previous Workflows',
            lessons.map((l) => `- [${l.failureType ?? 'GENERAL'}] (lesson ${l.id}) ${l.content}`)
          )}`
        : '';
    },
    tools:
      memory.mode === 'ON'
        ? ([
            {
              async call(args: unknown) {
                const { query, limit } = z
                  .object({
                    limit: z.number().int().min(1).max(10).optional(),
                    query: z.string().min(1).max(2000),
                  })
                  .parse(args);
                const lessons = await search(query, limit);
                event(lessons, 'searchLessons');
                return {
                  lessons: lessons.map((l) => ({
                    failureType: l.failureType,
                    lessonId: l.id,
                    similarity: l.similarity,
                    summary: l.content,
                  })),
                };
              },
              description: 'Search this eval dataset’s fixed lesson corpus.',
              name: 'searchLessons',
              schema: z.object({
                limit: z.number().int().min(1).max(10).optional(),
                query: z.string().min(1).max(2000),
              }),
            },
            {
              async call(args: unknown) {
                const { lessonId } = z.object({ lessonId: z.string().uuid() }).parse(args);
                const safe = await withoutFlaggedMemory(
                  memory.corpus.filter((l) => l.id === lessonId),
                  (lesson) => lesson.content
                );
                const lesson = safe[0];
                event(
                  lesson
                    ? [{ failureType: lesson.failureType, lessonId: lesson.id, similarity: 1 }]
                    : [],
                  'explainLesson'
                );
                return {
                  found: Boolean(lesson),
                  lesson: lesson
                    ? {
                        failureType: lesson.failureType,
                        lessonId: lesson.id,
                        summary: lesson.content,
                      }
                    : null,
                };
              },
              description: 'Read one lesson from this eval dataset’s fixed corpus.',
              name: 'explainLesson',
              schema: z.object({ lessonId: z.string().uuid() }),
            },
          ] as EvalLessonTool[])
        : [],
  };
}
