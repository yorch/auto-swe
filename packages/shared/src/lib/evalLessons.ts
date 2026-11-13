import { createHash } from 'node:crypto';

export interface EvalLessonInput {
  content: string;
  failureType?: string | null;
  tags?: string[];
  source?: 'AUTHORED' | 'IMPORTED';
  sourceMemoryItemId?: string;
}

export type EvalMemoryMode = 'ON' | 'SHADOW' | 'OFF';

export function evalCorpusHash(
  lessons: readonly { content: string; failureType?: string | null }[]
): string {
  const ordered = lessons
    .map((lesson) => JSON.stringify([lesson.content, lesson.failureType ?? null]))
    .sort();
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}
