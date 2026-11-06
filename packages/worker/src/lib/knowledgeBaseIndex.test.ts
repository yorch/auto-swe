import { hasTenantPredicate } from '@auto-swe/shared/lib/tenantGuard';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { db, scm, scan, embed, budget } = vi.hoisted(() => ({
  budget: vi.fn(),
  db: {
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    knowledgeBase: { findUnique: vi.fn(), update: vi.fn() },
    knowledgeBaseChunk: { create: vi.fn(), deleteMany: vi.fn() },
    knowledgeBaseSnapshot: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
  embed: vi.fn(),
  scan: vi.fn(),
  scm: {
    defaultBranch: vi.fn(),
    fetchFileContent: vi.fn(),
    listTree: vi.fn(),
    resolveRef: vi.fn(),
  },
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma: db }));
vi.mock('./scm/index.js', () => ({
  getScmProvider: () => scm,
  toRepoRef: (connection: unknown) => connection,
}));
vi.mock('./embeddings.js', () => ({ generateEmbeddingWithSpec: embed }));
vi.mock('./memoryGuard.js', () => ({ memoryInjectionMatches: scan }));
vi.mock('./costTracking.js', () => ({ assertBudgetAvailable: budget }));

import {
  chunkKnowledgeBaseFile,
  ensureKnowledgeBaseSnapshot,
  indexKnowledgeBaseSnapshot,
  KNOWLEDGE_BASE_INDEX_ERROR,
  KNOWLEDGE_BASE_INDEX_LIMITS as limits,
} from './knowledgeBaseIndex.js';

const SHA = 'a'.repeat(40);
let status = 'INDEXING';
let kb: Record<string, unknown>;
let contents: Record<string, string | null>;
const snapshot = () => ({ id: 'snapshot', knowledgeBaseId: 'kb', path: 'docs', sha: SHA, status });

beforeEach(() => {
  vi.resetAllMocks();
  status = 'INDEXING';
  kb = {
    connection: { defaultBranch: 'main', isActive: true, type: 'git_repo' },
    defaultRef: null,
    id: 'kb',
    orgId: 'org',
    path: 'docs',
    status: 'OK',
  };
  contents = {
    'docs/readme.md': '# Intro\nUseful material\n## Setup\nSteps',
    'other.md': 'outside',
  };
  db.knowledgeBase.findUnique.mockImplementation(async () => kb);
  db.knowledgeBaseSnapshot.upsert.mockImplementation(async () => snapshot());
  db.knowledgeBaseSnapshot.findUniqueOrThrow.mockImplementation(async () => snapshot());
  db.knowledgeBaseSnapshot.update.mockImplementation(async ({ data }) => {
    status = data.status;
    return { ...snapshot(), ...data };
  });
  db.knowledgeBaseSnapshot.updateMany.mockResolvedValue({ count: 1 });
  db.knowledgeBaseChunk.create.mockResolvedValue({ id: 'chunk' });
  db.knowledgeBaseChunk.deleteMany.mockImplementation(async ({ where }) => {
    expect(hasTenantPredicate(where)).toBe(true);
    return { count: 0 };
  });
  db.$transaction.mockImplementation(async (fn) => fn(db));
  scm.resolveRef.mockResolvedValue(SHA);
  scm.defaultBranch.mockResolvedValue('trunk');
  scm.listTree.mockImplementation(async () => ({ paths: Object.keys(contents), truncated: false }));
  scm.fetchFileContent.mockImplementation(async (_repo, file) => contents[file] ?? null);
  scan.mockResolvedValue({ incomplete: false, loadFailed: false, matches: [] });
  embed.mockResolvedValue({ embedding: [0.1, 0.2], spec: 'openai:test' });
});

describe('knowledge base indexing', () => {
  it('pins reads to the resolved SHA, scopes paths, chunks headings and writes vectors', async () => {
    const result = await indexKnowledgeBaseSnapshot('kb');
    expect(scm.resolveRef).toHaveBeenCalledWith(kb.connection, 'main');
    expect(scm.listTree).toHaveBeenCalledWith(kb.connection, SHA);
    expect(scm.fetchFileContent).toHaveBeenCalledExactlyOnceWith(
      kb.connection,
      'docs/readme.md',
      SHA
    );
    expect(result).toMatchObject({
      chunkCount: 2,
      embeddingModel: 'openai:test',
      fileCount: 1,
      flaggedFiles: [],
      skippedFiles: [],
      status: 'READY',
    });
    expect(db.knowledgeBaseChunk.create.mock.calls.map(([arg]) => arg.data)).toEqual([
      expect.objectContaining({
        chunkIndex: 0,
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        heading: 'Intro',
        path: 'docs/readme.md',
      }),
      expect.objectContaining({ chunkIndex: 1, heading: 'Setup' }),
    ]);
    expect(db.$executeRaw).toHaveBeenCalledTimes(3);
    expect(db.knowledgeBase.update).toHaveBeenCalledWith({
      data: { lastError: null, lastIndexedAt: expect.any(Date), lastIndexedSha: SHA },
      where: { id: 'kb' },
    });
  });

  it('is idempotent for an existing READY snapshot and accepts an explicit pinned SHA', async () => {
    await ensureKnowledgeBaseSnapshot('kb', SHA);
    await ensureKnowledgeBaseSnapshot('kb', SHA);
    expect(scm.resolveRef).not.toHaveBeenCalled();
    expect(scm.listTree).toHaveBeenCalledTimes(1);
    expect(db.knowledgeBaseChunk.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.knowledgeBase.update).toHaveBeenLastCalledWith({
      data: { lastError: null },
      where: { id: 'kb' },
    });
    expect(db.knowledgeBaseSnapshot.upsert).toHaveBeenCalledWith({
      create: { knowledgeBaseId: 'kb', path: 'docs', sha: SHA },
      update: {},
      where: { knowledgeBaseId_sha_path: { knowledgeBaseId: 'kb', path: 'docs', sha: SHA } },
    });
  });

  it('uses the KB default ref before the connection default branch', async () => {
    kb.defaultRef = 'v1';
    await indexKnowledgeBaseSnapshot('kb');
    expect(scm.resolveRef).toHaveBeenCalledWith(kb.connection, 'v1');
  });

  it('excludes injection matches and incomplete scans from chunks and embeddings', async () => {
    contents = { 'docs/a.md': 'injection', 'docs/b.md': 'incomplete', 'docs/c.md': 'safe' };
    scan
      .mockResolvedValueOnce({ incomplete: false, loadFailed: false, matches: ['override'] })
      .mockResolvedValueOnce({ incomplete: true, loadFailed: false, matches: [] });
    const result = await indexKnowledgeBaseSnapshot('kb');
    expect(result).toMatchObject({
      chunkCount: 1,
      fileCount: 1,
      flaggedFiles: [
        { path: 'docs/a.md', reason: 'injection' },
        { path: 'docs/b.md', reason: 'scan_incomplete' },
      ],
      status: 'READY',
    });
    expect(embed).toHaveBeenCalledExactlyOnceWith('safe');
    expect(db.knowledgeBaseChunk.create.mock.calls[0][0].data.path).toBe('docs/c.md');
  });

  it('leaves every chunk unembedded when a later embedding fails', async () => {
    embed
      .mockResolvedValueOnce({ embedding: [1], spec: 'model' })
      .mockRejectedValueOnce(new Error('provider secret'));
    const result = await indexKnowledgeBaseSnapshot('kb');
    expect(result).toMatchObject({
      chunkCount: 2,
      embeddingModel: null,
      error: null,
      status: 'READY',
    });
    expect(
      db.knowledgeBaseChunk.create.mock.calls.every(([arg]) => arg.data.embeddingModel === null)
    ).toBe(true);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('does not mix model versions within a snapshot', async () => {
    embed
      .mockResolvedValueOnce({ embedding: [1], spec: 'model1' })
      .mockResolvedValueOnce({ embedding: [1], spec: 'model2' });
    expect((await indexKnowledgeBaseSnapshot('kb')).embeddingModel).toBeNull();
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('records unsupported, unavailable, binary, unsafe and oversized files as skipped', async () => {
    contents = {
      'docs/../bad.md': 'unsafe',
      'docs/a.png': 'image',
      'docs/b.txt': null,
      'docs/c.txt': '\0binary',
      'docs/d.txt': 'x'.repeat(limits.fileBytes + 1),
    };
    const result = await indexKnowledgeBaseSnapshot('kb');
    expect(result).toMatchObject({
      chunkCount: 0,
      embeddingModel: null,
      fileCount: 0,
      status: 'READY',
    });
    expect(result.skippedFiles).toEqual(
      expect.arrayContaining([
        { path: 'docs/a.png', reason: 'unsupported_extension' },
        { path: 'docs/b.txt', reason: 'unavailable_file' },
        { path: 'docs/c.txt', reason: 'non_text_content' },
        { path: 'docs/d.txt', reason: 'file_bytes_limit' },
        { path: 'docs/../bad.md', reason: 'unsafe_path' },
      ])
    );
    expect(scan).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it('enforces the file count cap before fetching excess files', async () => {
    contents = Object.fromEntries(
      Array.from({ length: limits.files + 1 }, (_, i) => [
        `docs/${String(i).padStart(3, '0')}.txt`,
        '',
      ])
    );
    const result = await indexKnowledgeBaseSnapshot('kb');
    expect(result.fileCount).toBe(limits.files);
    expect(scm.fetchFileContent).toHaveBeenCalledTimes(limits.files);
    expect(result.skippedFiles).toEqual([{ path: 'docs/500.txt', reason: 'file_limit' }]);
  });

  it('enforces the total-byte cap and counts flagged content against it', async () => {
    const count = Math.floor(limits.totalBytes / limits.fileBytes);
    contents = Object.fromEntries(
      Array.from({ length: count + 1 }, (_, i) => [
        `docs/${String(i).padStart(3, '0')}.txt`,
        'x'.repeat(limits.fileBytes),
      ])
    );
    scan.mockResolvedValue({ incomplete: false, loadFailed: false, matches: ['injection'] });
    const result = await indexKnowledgeBaseSnapshot('kb');
    expect(result.bytes).toBe(count * limits.fileBytes);
    expect(result.skippedFiles).toEqual([
      { path: `docs/${String(count).padStart(3, '0')}.txt`, reason: 'total_bytes_limit' },
    ]);
    expect(result.chunkCount).toBe(0);
  });

  it('handles an empty tree without embedding calls', async () => {
    contents = {};
    expect(await indexKnowledgeBaseSnapshot('kb')).toMatchObject({
      bytes: 0,
      chunkCount: 0,
      fileCount: 0,
      status: 'READY',
    });
    expect(embed).not.toHaveBeenCalled();
  });

  it.each(['truncated', 'unavailable', 'scm-error', 'scan-error', 'load-failed'])(
    'fails closed with fixed error text for %s',
    async (mode) => {
      if (mode === 'truncated') {
        scm.listTree.mockResolvedValue({ paths: [], truncated: true });
      }
      if (mode === 'unavailable') {
        scm.listTree.mockResolvedValue(null);
      }
      if (mode === 'scm-error') {
        scm.fetchFileContent.mockRejectedValue(new Error('provider credentials'));
      }
      if (mode === 'scan-error') {
        scan.mockRejectedValue(new Error('scanner internals'));
      }
      if (mode === 'load-failed') {
        scan.mockResolvedValue({ incomplete: true, loadFailed: true, matches: [] });
      }
      await expect(indexKnowledgeBaseSnapshot('kb')).rejects.toThrow(KNOWLEDGE_BASE_INDEX_ERROR);
      expect(db.knowledgeBaseSnapshot.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ error: KNOWLEDGE_BASE_INDEX_ERROR, status: 'FAILED' }),
        })
      );
      expect(db.knowledgeBase.update).toHaveBeenCalledWith({
        data: { lastError: KNOWLEDGE_BASE_INDEX_ERROR },
        where: { id: 'kb' },
      });
      expect(db.knowledgeBaseChunk.create).not.toHaveBeenCalled();
      if (mode === 'truncated') {
        expect(db.knowledgeBaseSnapshot.updateMany.mock.calls[0][0].data.skippedFiles).toEqual([
          { path: 'docs', reason: 'truncated_tree' },
        ]);
      }
    }
  );

  it('records ref-resolution failure without inventing a snapshot SHA', async () => {
    scm.resolveRef.mockResolvedValue(null);
    await expect(indexKnowledgeBaseSnapshot('kb')).rejects.toThrow(KNOWLEDGE_BASE_INDEX_ERROR);
    expect(db.knowledgeBaseSnapshot.upsert).not.toHaveBeenCalled();
    expect(db.knowledgeBase.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastError: KNOWLEDGE_BASE_INDEX_ERROR } })
    );
  });

  it('sanitizes errors even when failure metadata cannot be persisted', async () => {
    scm.resolveRef.mockRejectedValue(new Error('provider secret'));
    db.knowledgeBase.update.mockRejectedValue(new Error('database detail'));
    await expect(indexKnowledgeBaseSnapshot('kb')).rejects.toThrow(KNOWLEDGE_BASE_INDEX_ERROR);
  });
});

describe('chunkKnowledgeBaseFile', () => {
  it('bounds chunks, preserves unicode and ignores headings inside fenced blocks', () => {
    const text = `# One\n${'😀'.repeat(limits.chunkCharacters + 1)}\n\`\`\`md\n# Not a heading\n\`\`\`\n## Two\nbody`;
    const chunks = chunkKnowledgeBaseFile(text);
    expect(
      chunks.every((chunk) => Array.from(chunk.content).length <= limits.chunkCharacters)
    ).toBe(true);
    expect(chunks.map((chunk) => chunk.heading)).toEqual(['One', 'One', 'Two']);
    expect(chunks.map((chunk) => chunk.content).join('')).toContain('# Not a heading');
    expect(chunkKnowledgeBaseFile(' \n ')).toEqual([]);
  });
});
