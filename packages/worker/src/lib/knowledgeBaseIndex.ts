import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { assertBudgetAvailable } from './costTracking.js';
import { generateEmbeddingWithSpec } from './embeddings.js';
import { memoryInjectionMatches } from './memoryGuard.js';
import { getScmProvider, toRepoRef } from './scm/index.js';

export type KnowledgeBaseSnapshot = Prisma.KnowledgeBaseSnapshotGetPayload<Record<string, never>>;

export const KNOWLEDGE_BASE_INDEX_LIMITS = {
  chunkCharacters: 4000,
  fileBytes: 100 * 1024,
  files: 500,
  totalBytes: 5 * 1024 * 1024,
} as const;
export const KNOWLEDGE_BASE_INDEX_ERROR = 'Knowledge base indexing failed';

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.markdown',
  '.txt',
  '.rst',
  '.adoc',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
]);
type FileFinding = { path: string; reason: string };

export function chunkKnowledgeBaseFile(
  content: string
): Array<{ heading: string | null; content: string }> {
  const chunks: Array<{ heading: string | null; content: string }> = [];
  let heading: string | null = null;
  let section = '';
  let fence: string | null = null;
  const flush = () => {
    const characters = Array.from(section.trim());
    for (let i = 0; i < characters.length; i += KNOWLEDGE_BASE_INDEX_LIMITS.chunkCharacters) {
      chunks.push({
        content: characters.slice(i, i + KNOWLEDGE_BASE_INDEX_LIMITS.chunkCharacters).join(''),
        heading,
      });
    }
    section = '';
  };
  for (const line of content.split('\n')) {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    const title = !fence && /^(#{1,6})\s+(.+)$/.exec(line);
    if (title) {
      flush();
      heading = Array.from(title[2]).slice(0, 500).join('');
    }
    if (delimiter) {
      if (!fence) {
        fence = delimiter;
      } else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) {
        fence = null;
      }
    }
    section += `${line}\n`;
  }
  flush();
  return chunks;
}

export async function indexKnowledgeBaseSnapshot(
  knowledgeBaseId: string,
  requestedSha?: string
): Promise<KnowledgeBaseSnapshot> {
  const kb = await prisma.knowledgeBase
    .findUnique({
      include: { connection: { include: { installation: true } } },
      where: { id: knowledgeBaseId },
    })
    .catch(() => {
      throw new Error(KNOWLEDGE_BASE_INDEX_ERROR);
    });
  if (!kb) {
    throw new Error(KNOWLEDGE_BASE_INDEX_ERROR);
  }
  let sha: string | undefined;
  let snapshotId: string | undefined;
  const skippedFiles: FileFinding[] = [];
  const flaggedFiles: FileFinding[] = [];
  try {
    if (kb.status !== 'OK' || !kb.connection.isActive || kb.connection.type !== 'git_repo') {
      throw new Error(KNOWLEDGE_BASE_INDEX_ERROR);
    }
    const repo = toRepoRef(kb.connection);
    const scm = getScmProvider(repo);
    sha =
      requestedSha ??
      (await scm.resolveRef(
        repo,
        kb.defaultRef ?? kb.connection.defaultBranch ?? (await scm.defaultBranch(repo))
      )) ??
      undefined;
    if (!sha || !/^[0-9a-f]{40,64}$/i.test(sha)) {
      throw new Error(KNOWLEDGE_BASE_INDEX_ERROR);
    }
    sha = sha.toLowerCase();
    const key = { knowledgeBaseId, path: kb.path, sha };
    const snapshot = await prisma.knowledgeBaseSnapshot.upsert({
      create: key,
      update: {},
      where: { knowledgeBaseId_sha_path: key },
    });
    snapshotId = snapshot.id;
    return await prisma.$transaction(
      async (tx) => {
        // CLAUDE.md §7 exception: serialize writers of the same immutable snapshot.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(key)}, 0))`;
        const current = await tx.knowledgeBaseSnapshot.findUniqueOrThrow({
          where: { id: snapshot.id },
        });
        if (current.status === 'READY') {
          await tx.knowledgeBase.update({
            data: { lastError: null },
            where: { id: knowledgeBaseId },
          });
          return current;
        }
        const tree = await scm.listTree(repo, sha);
        if (!tree || tree.truncated) {
          if (tree?.truncated) {
            skippedFiles.push({ path: kb.path, reason: 'truncated_tree' });
          }
          throw new Error(KNOWLEDGE_BASE_INDEX_ERROR);
        }
        const prefix = kb.path.replace(/\/+$/, '');
        if (
          prefix &&
          (prefix.startsWith('/') ||
            prefix.split('/').some((part) => !part || part === '.' || part === '..') ||
            prefix.includes('\\'))
        ) {
          throw new Error(KNOWLEDGE_BASE_INDEX_ERROR);
        }
        const chunks: Array<{
          path: string;
          chunkIndex: number;
          heading: string | null;
          content: string;
          contentDigest: string;
        }> = [];
        let files = 0;
        let fileCount = 0;
        let bytes = 0;
        for (const file of [...new Set(tree.paths)].sort()) {
          if (prefix && !file.startsWith(`${prefix}/`)) {
            continue;
          }
          let reason: string | undefined;
          if (
            file.startsWith('/') ||
            file.includes('\\') ||
            file.split('/').some((part) => !part || part === '.' || part === '..')
          ) {
            reason = 'unsafe_path';
          } else if (!TEXT_EXTENSIONS.has(path.posix.extname(file).toLowerCase())) {
            reason = 'unsupported_extension';
          } else if (files >= KNOWLEDGE_BASE_INDEX_LIMITS.files) {
            reason = 'file_limit';
          } else if (bytes >= KNOWLEDGE_BASE_INDEX_LIMITS.totalBytes) {
            reason = 'total_bytes_limit';
          }
          if (reason) {
            skippedFiles.push({ path: file, reason });
            continue;
          }
          files++;
          const content = await scm.fetchFileContent(repo, file, sha);
          const size = content === null ? 0 : Buffer.byteLength(content);
          if (content === null) {
            reason = 'unavailable_file';
          } else if (size > KNOWLEDGE_BASE_INDEX_LIMITS.fileBytes) {
            reason = 'file_bytes_limit';
          } else if (bytes + size > KNOWLEDGE_BASE_INDEX_LIMITS.totalBytes) {
            reason = 'total_bytes_limit';
          } else if (content.includes('\0') || content.includes('\uFFFD')) {
            reason = 'non_text_content';
          }
          if (reason || content === null) {
            skippedFiles.push({ path: file, reason: reason ?? 'unavailable_file' });
            continue;
          }
          bytes += size;
          const scan = await memoryInjectionMatches([content]);
          if (scan.loadFailed) {
            throw new Error(KNOWLEDGE_BASE_INDEX_ERROR);
          }
          if (scan.matches.length || scan.incomplete) {
            flaggedFiles.push({
              path: file,
              reason: scan.matches.length ? 'injection' : 'scan_incomplete',
            });
            continue;
          }
          fileCount++;
          for (const [chunkIndex, chunk] of chunkKnowledgeBaseFile(content).entries()) {
            chunks.push({
              ...chunk,
              chunkIndex,
              contentDigest: createHash('sha256').update(chunk.content).digest('hex'),
              path: file,
            });
          }
        }
        let embeddings: Array<{ embedding: number[]; spec: string }> = [];
        try {
          for (const chunk of chunks) {
            await assertBudgetAvailable('knowledge.embedding');
            embeddings.push(await generateEmbeddingWithSpec(chunk.content));
          }
          if (new Set(embeddings.map((item) => item.spec)).size > 1) {
            embeddings = [];
          }
        } catch {
          embeddings = [];
        }
        await tx.knowledgeBaseChunk.deleteMany({
          where: { snapshot: { knowledgeBase: { orgId: kb.orgId } }, snapshotId: snapshot.id },
        });
        for (const [index, chunk] of chunks.entries()) {
          const model = embeddings[index];
          const row = await tx.knowledgeBaseChunk.create({
            data: { ...chunk, embeddingModel: model?.spec ?? null, snapshotId: snapshot.id },
          });
          if (model) {
            await tx.$executeRaw`UPDATE knowledge_base_chunks SET embedding = ${JSON.stringify(model.embedding)}::vector WHERE id = ${row.id}::uuid`;
          }
        }
        const indexedAt = new Date();
        const ready = await tx.knowledgeBaseSnapshot.update({
          data: {
            bytes,
            chunkCount: chunks.length,
            embeddingModel: embeddings[0]?.spec ?? null,
            error: null,
            fileCount,
            flaggedFiles,
            indexedAt,
            skippedFiles,
            status: 'READY',
          },
          where: { id: snapshot.id },
        });
        await tx.knowledgeBase.update({
          data: { lastError: null, lastIndexedAt: indexedAt, lastIndexedSha: sha },
          where: { id: knowledgeBaseId },
        });
        return ready;
      },
      { maxWait: 30_000, timeout: 25 * 60 * 1000 }
    );
  } catch {
    try {
      let failed = true;
      if (snapshotId) {
        const result = await prisma.knowledgeBaseSnapshot.updateMany({
          data: { error: KNOWLEDGE_BASE_INDEX_ERROR, flaggedFiles, skippedFiles, status: 'FAILED' },
          where: { id: snapshotId, knowledgeBase: { orgId: kb.orgId }, status: { not: 'READY' } },
        });
        failed = result.count > 0;
      }
      if (failed) {
        await prisma.knowledgeBase.update({
          data: { lastError: KNOWLEDGE_BASE_INDEX_ERROR },
          where: { id: knowledgeBaseId },
        });
      }
    } catch {}
    throw new Error(KNOWLEDGE_BASE_INDEX_ERROR);
  }
}

export async function ensureKnowledgeBaseSnapshot(
  knowledgeBaseId: string,
  sha: string
): Promise<KnowledgeBaseSnapshot> {
  return indexKnowledgeBaseSnapshot(knowledgeBaseId, sha);
}
