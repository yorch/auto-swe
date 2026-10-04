import { createHash } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * Skill revisions: the immutable history behind `Skill.promptText`.
 *
 * `Skill.promptText`/`description` stay the live copy and always mirror the
 * revision numbered `Skill.currentRevision`. Every write path goes through the
 * two builders below, which return the fragment to spread into its own
 * `skill.create` / `skill.update` — the revision row is a nested create in the
 * same statement, so a skill can never exist without the revision it names and
 * no transaction is needed to keep the pair consistent.
 */

export interface SkillContent {
  promptText: string;
  description: string | null;
}

export interface SkillRevisionMeta {
  createdById?: string | null;
  /** Advisory `scanSkillContent` warnings for this exact text. */
  scanWarnings?: string[];
  sourceSha?: string | null;
  sourcePath?: string | null;
  referenceFiles?: Prisma.InputJsonValue | null;
}

/** sha256 over the content a revision records; equal hashes mean no new revision. */
export function skillContentHash(content: SkillContent): string {
  return createHash('sha256')
    .update(JSON.stringify([content.promptText, content.description ?? null]))
    .digest('hex');
}

/** Has the text or description a revision would record actually changed? */
export function skillContentChanged(existing: SkillContent, next: SkillContent): boolean {
  return skillContentHash(existing) !== skillContentHash(next);
}

function revisionCreate(
  revision: number,
  content: SkillContent,
  meta: SkillRevisionMeta
): Prisma.SkillRevisionCreateWithoutSkillInput {
  return {
    contentHash: skillContentHash(content),
    createdBy: meta.createdById ? { connect: { id: meta.createdById } } : undefined,
    description: content.description,
    promptText: content.promptText,
    referenceFiles: meta.referenceFiles ?? undefined,
    revision,
    scanWarnings: meta.scanWarnings ?? [],
    sourcePath: meta.sourcePath ?? null,
    sourceSha: meta.sourceSha ?? null,
  };
}

/**
 * Fragment for `skill.create({ data: { ...fields, ...initialRevision(...) } })`:
 * the skill's revision 1, written in the same statement.
 */
export function initialRevision(
  content: SkillContent,
  meta: SkillRevisionMeta = {}
): Pick<Prisma.SkillCreateInput, 'currentRevision' | 'revisions'> {
  return { currentRevision: 1, revisions: { create: revisionCreate(1, content, meta) } };
}

/**
 * Pieces of a content-changing `skill.update`: spread `data` into the caller's
 * own `data` and use `where` as the filter.
 *
 * `where` carries the revision number the caller read, so two concurrent edits
 * cannot both claim revision N+1: the loser matches no row and Prisma raises
 * P2025 ({@link isRevisionConflict}) instead of overwriting a revision it never
 * saw. (`@@unique([skillId, revision])` is the backstop.)
 */
export function nextRevision(
  existing: { id: string; currentRevision: number },
  content: SkillContent,
  meta: SkillRevisionMeta = {}
): {
  data: Pick<
    Prisma.SkillUpdateInput,
    'currentRevision' | 'description' | 'promptText' | 'revisions'
  >;
  where: { id: string; currentRevision: number };
} {
  const revision = existing.currentRevision + 1;
  return {
    data: {
      currentRevision: revision,
      description: content.description,
      promptText: content.promptText,
      revisions: { create: revisionCreate(revision, content, meta) },
    },
    where: { currentRevision: existing.currentRevision, id: existing.id },
  };
}

/** Did a `nextRevision` update lose a race to a concurrent edit? */
export function isRevisionConflict(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'P2025' || code === 'P2002';
}
