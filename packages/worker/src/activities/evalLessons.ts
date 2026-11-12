import type { EvalLessonInput } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { generateEmbeddingWithSpec } from '../lib/embeddings.js';
import { ownerOfDataset, withSpendOwner } from '../lib/spendOwner.js';

export async function replaceEvalLessons(input: {
  datasetId: string;
  lessons: EvalLessonInput[];
}): Promise<number> {
  if (
    input.lessons.length > 50 ||
    input.lessons.some((lesson) => !lesson.content.trim() || lesson.content.length > 5000)
  ) {
    throw new Error('Eval corpus allows at most 50 lessons of 1–5000 characters');
  }
  return withSpendOwner(ownerOfDataset(input.datasetId), async () => {
    const rows: (EvalLessonInput & {
      vector: Awaited<ReturnType<typeof generateEmbeddingWithSpec>>;
    })[] = [];
    for (const lesson of input.lessons) {
      const vector = await generateEmbeddingWithSpec(lesson.content);
      rows.push({ ...lesson, vector });
    }
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`eval-corpus:${input.datasetId}`}, 0))`;
      await tx.evalLesson.deleteMany({ where: { datasetId: input.datasetId } });
      for (const row of rows) {
        await tx.$executeRaw`
          INSERT INTO eval_lessons (dataset_id, content, failure_type, tags, embedding, embedding_model, source, source_memory_item_id)
          VALUES (${input.datasetId}::uuid, ${row.content}, ${row.failureType ?? null}, ${row.tags ?? []}::text[],
            ${JSON.stringify(row.vector.embedding)}::vector, ${row.vector.spec},
            ${row.source ?? 'AUTHORED'}::"EvalLessonSource", ${row.sourceMemoryItemId ?? null}::uuid)
        `;
      }
    });
    return rows.length;
  });
}
