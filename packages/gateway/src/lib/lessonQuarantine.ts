import type { Prisma } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';

export const LESSON_QUARANTINE_SELECT = {
  quarantinedAt: true,
  quarantinedById: true,
  quarantineReason: true,
  quarantineSource: true,
} as const;

export const RESTORED_LESSON = {
  quarantinedAt: null,
  quarantinedById: null,
  quarantineReason: null,
  quarantineSource: null,
} as const;

export async function lockLesson(tx: Prisma.TransactionClient, id: string) {
  // CLAUDE.md §7 exception: per-lesson transaction advisory lock; it returns void, so execute.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`lesson-quarantine:${id}`}, 0))`;
}

export async function lessonFlagThreshold(tx: Prisma.TransactionClient, repoId: string | null) {
  const repo = repoId
    ? await tx.connection.findUnique({
        select: { team: { select: { orgId: true } }, teamId: true },
        where: { id: repoId },
      })
    : null;
  return resolveSetting('memory.lessonFlagQuarantineThreshold', {
    orgId: repo?.team?.orgId,
    teamId: repo?.teamId ?? undefined,
  });
}

/** Called while holding the lesson lock, after changing its flags. */
export async function syncFlagQuarantine(
  tx: Prisma.TransactionClient,
  id: string
): Promise<{
  before: Prisma.MemoryItemGetPayload<{
    select: typeof LESSON_QUARANTINE_SELECT & { repoId: true };
  }>;
  after: Prisma.MemoryItemGetPayload<{ select: typeof LESSON_QUARANTINE_SELECT }> & {
    event: string;
    flagCount: number;
    threshold: number;
  };
} | null> {
  const lesson = await tx.memoryItem.findFirst({
    select: { ...LESSON_QUARANTINE_SELECT, repoId: true },
    where: { id, scope: 'swe-lessons' },
  });
  if (!lesson) {
    return null;
  }
  const threshold = await lessonFlagThreshold(tx, lesson.repoId);
  const count = await tx.lessonFlag.count({ where: { memoryItemId: id } });
  const shouldQuarantine = threshold > 0 && count >= threshold;
  const data =
    !lesson.quarantinedAt && shouldQuarantine
      ? {
          quarantinedAt: new Date(),
          quarantinedById: null,
          quarantineReason: `${count} distinct flags reached the quarantine threshold of ${threshold}.`,
          quarantineSource: 'FLAG_THRESHOLD' as const,
        }
      : lesson.quarantinedAt && lesson.quarantineSource === 'FLAG_THRESHOLD' && !shouldQuarantine
        ? RESTORED_LESSON
        : null;
  if (!data) {
    return null;
  }
  await tx.memoryItem.update({ data, where: { id } });
  return {
    after: {
      ...data,
      event: data.quarantinedAt ? 'lesson.quarantined' : 'lesson.restored',
      flagCount: count,
      threshold,
    },
    before: lesson,
  };
}
