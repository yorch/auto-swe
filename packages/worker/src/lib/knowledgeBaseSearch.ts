import { Prisma } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { MAX_DEPENDENCY_CHECKOUTS } from '@auto-swe/shared/lib/knowledgeBaseResolution';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { logWarn } from './activityLog.js';
import { currentEmbeddingSpec, generateEmbeddingWithSpec } from './embeddings.js';
import {
  type KnowledgeSearchResult,
  resolveKnowledgeExecutionScope,
  searchWorkflowKnowledge,
} from './knowledgeRuntime.js';
import { withoutFlaggedMemory } from './memoryGuard.js';

export interface KnowledgeBaseSearchResult extends KnowledgeSearchResult {
  sourceKind: 'knowledge_base';
  snapshotId: string;
  path: string;
  heading: string | null;
}

export async function searchKnowledgeBaseChunks(
  query: string,
  snapshotIds: readonly string[],
  limit = 5
): Promise<{
  results: KnowledgeBaseSearchResult[];
  mode: 'semantic' | 'text';
  injectionDropped: number;
}> {
  const text = query.trim();
  if (
    !text ||
    text.length > 2000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 10 ||
    snapshotIds.length > MAX_DEPENDENCY_CHECKOUTS
  ) {
    throw new RangeError('invalid knowledge base search bounds');
  }
  const ids = [...new Set(snapshotIds)];
  if (!ids.length) {
    return { injectionDropped: 0, mode: 'text', results: [] };
  }
  let mode: 'semantic' | 'text' = 'text';
  let ranked: Array<{ id: string; similarity: number }> | undefined;
  let model: string | undefined;
  try {
    model = await currentEmbeddingSpec();
    const { embedding, spec } = await generateEmbeddingWithSpec(text);
    if (spec !== model) {
      throw new Error('embedding configuration changed');
    }
    ranked = await prisma.$queryRaw<Array<{ id: string; similarity: number }>>(Prisma.sql`
      SELECT id, 1 - (embedding <=> ${JSON.stringify(embedding)}::vector) AS similarity
      FROM knowledge_base_chunks
      WHERE snapshot_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
        AND embedding IS NOT NULL AND embedding_model = ${model}
      ORDER BY embedding <=> ${JSON.stringify(embedding)}::vector ASC, id ASC
      LIMIT ${limit}
    `);
    mode = ranked.length ? 'semantic' : 'text';
  } catch {
    model = undefined;
  }
  const rows = await runUnscoped(
    'scoped to explicitly authorized run snapshot ids',
    ['KnowledgeBaseChunk'],
    () =>
      prisma.knowledgeBaseChunk.findMany({
        orderBy: [{ path: 'asc' }, { chunkIndex: 'asc' }, { id: 'asc' }],
        select: {
          content: true,
          embeddingModel: true,
          heading: true,
          id: true,
          path: true,
          snapshot: {
            select: {
              knowledgeBase: {
                select: { connection: { select: { organizationName: true, repoName: true } } },
              },
              sha: true,
            },
          },
          snapshotId: true,
        },
        take: limit,
        where: {
          snapshot: { status: 'READY' },
          snapshotId: { in: ids },
          ...(mode === 'semantic'
            ? { embeddingModel: model, id: { in: (ranked ?? []).map((row) => row.id) } }
            : {
                OR: [
                  { content: { contains: text, mode: 'insensitive' } },
                  { heading: { contains: text, mode: 'insensitive' } },
                  { path: { contains: text, mode: 'insensitive' } },
                ],
              }),
        },
      })
  );
  const similarities = new Map((ranked ?? []).map((row) => [row.id, row.similarity]));
  const scoped = rows.filter(
    (row) =>
      ids.includes(row.snapshotId) &&
      (mode === 'text' || (row.embeddingModel === model && similarities.has(row.id)))
  );
  if (mode === 'semantic') {
    scoped.sort(
      (a, b) =>
        (similarities.get(b.id) ?? 0) - (similarities.get(a.id) ?? 0) || a.id.localeCompare(b.id)
    );
  }
  const clean = await withoutFlaggedMemory(
    scoped,
    (row) => `${row.heading ?? ''}\n${row.content}`,
    { idOf: (row) => row.id, recordIds: false }
  );
  const label = (value: string) => value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 500);
  return {
    injectionDropped: scoped.length - clean.length,
    mode,
    results: clean.map((row) => ({
      citation: `kb:${label(row.snapshot.knowledgeBase.connection.organizationName ?? '')}/${label(row.snapshot.knowledgeBase.connection.repoName ?? '')}@${row.snapshot.sha.slice(0, 7)} ${label(row.path)}${row.heading ? ` # ${label(row.heading).slice(0, 200)}` : ''}`,
      content: row.content.slice(0, 1600),
      heading: row.heading ? label(row.heading).slice(0, 200) : null,
      id: row.id,
      path: label(row.path),
      snapshotId: row.snapshotId,
      sourceKind: 'knowledge_base',
      title: label(row.heading ?? row.path).slice(0, 200),
      trustLabel: 'UNTRUSTED_THIRD_PARTY_REFERENCE',
      type: 'REFERENCE',
      version: 0,
      ...(mode === 'semantic' ? { similarity: similarities.get(row.id) } : {}),
    })),
  };
}

export async function searchRunKnowledge(
  query: string,
  options: { limit?: number; snapshotIds?: readonly string[] } = {}
) {
  const governed = await searchWorkflowKnowledge(query, { limit: options.limit });
  if (!options.snapshotIds?.length) {
    return { ...governed, injectionDropped: 0 };
  }
  const scope = await resolveKnowledgeExecutionScope();
  if (scope.principal.repoId && !scope.sourceAuthorized) {
    return { ...governed, injectionDropped: 0 };
  }
  const limit =
    options.limit ??
    (await resolveSetting('memory.knowledgeMaxResults', {
      orgId: scope.principal.orgId ?? undefined,
      teamId: scope.principal.teamId ?? undefined,
    }));
  let kb: Awaited<ReturnType<typeof searchKnowledgeBaseChunks>>;
  try {
    kb = await searchKnowledgeBaseChunks(query, options.snapshotIds, limit);
  } catch {
    logWarn('knowledge base search failed; continuing without reference material');
    return { ...governed, injectionDropped: 0 };
  }
  const results: KnowledgeSearchResult[] = [
    ...governed.results.map((row) => ({ ...row, sourceKind: 'governed' as const })),
    ...kb.results,
  ];
  results.sort(
    (a, b) =>
      (b.similarity ?? -1) - (a.similarity ?? -1) ||
      (a.sourceKind === b.sourceKind
        ? a.id.localeCompare(b.id)
        : a.sourceKind === 'governed'
          ? -1
          : 1)
  );
  let used = 0;
  return {
    injectionDropped: kb.injectionDropped,
    mode:
      governed.mode === 'text' || kb.mode === 'text' ? ('text' as const) : ('semantic' as const),
    results: results
      .filter((row) => {
        const cost = row.title.length + row.content.length + row.citation.length;
        if (used + cost > 8000) {
          return false;
        }
        used += cost;
        return true;
      })
      .slice(0, limit),
  };
}
