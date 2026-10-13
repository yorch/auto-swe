import {
  createWorkflowKnowledgeRepositoryCapability,
  getKnowledgeWorkflowEligibilityWhere,
  KnowledgeAccessError,
  type KnowledgeEvidence,
  type KnowledgeRepositoryGateCapability,
  listKnowledgeForWorkflow,
  Prisma,
  resolveKnowledgeWorkflowPrincipal,
  submitKnowledgeLearning,
  type TrustedKnowledgeWorkflowPrincipal,
  toKnowledgeScalarProjection,
} from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { resolveRepoAccessGateOrLastKnown } from '@auto-swe/shared/lib/repoAccessGate';
import { MEMORY_SECURITY_EVENTS } from '@auto-swe/shared/lib/scannerCache';
import { activityInfo } from '@temporalio/activity';
import { currentNodeTag } from './activityNodeTag.js';
import { assertBudgetAvailable } from './costTracking.js';
import { currentEmbeddingSpec, generateEmbeddingWithSpec } from './embeddings.js';
import {
  assertMemoryContentAllowed,
  MemoryContentRefusedError,
  memoryWriteRefusalEvent,
  withoutFlaggedMemory,
} from './memoryGuard.js';
import { recordMemorySecurityEvent } from './memorySecurityEvent.js';

const MAX_RESULTS = 10;
const MAX_CANDIDATES = 500;
const MAX_INDEX_BATCH = 10;
const MAX_INDEX_TEXT_CHARS = 1_800;
const MAX_RESULT_CHARS = 8_000;
const MAX_ITEM_CHARS = 1_600;

type TrustedGateEvidenceRecord = {
  activityAttempt: number;
  artifactId: string | null;
  evidenceCorrelation: string;
  gateName: string;
  id: string;
  recordingId: string;
  specNodeId: string;
  stepAttempt: number;
  summary: string;
};

type TrustedEvidenceDelegate = {
  findMany(args: unknown): Promise<TrustedGateEvidenceRecord[]>;
};

export interface KnowledgeSearchResult {
  id: string;
  title: string;
  content: string;
  type: string;
  trustLabel: string;
  version: number;
  citation: string;
  similarity?: number;
}

export interface KnowledgeExecutionScope {
  principal: TrustedKnowledgeWorkflowPrincipal;
  repositoryCapability: KnowledgeRepositoryGateCapability;
  sourceAuthorized: boolean;
}

/** Resolve exact Temporal execution identity and freshly gate its stored source repository. */
export async function resolveKnowledgeExecutionScope(): Promise<KnowledgeExecutionScope> {
  const execution = activityInfo().workflowExecution;
  if (!execution?.workflowId || !execution.runId) {
    throw new KnowledgeAccessError();
  }
  const principal = await resolveKnowledgeWorkflowPrincipal(prisma, {
    temporalRunId: execution.runId,
    workflowId: execution.workflowId,
  });
  const gate = await resolveRepoAccessGateOrLastKnown();
  if (!gate) {
    throw new KnowledgeAccessError('Repository access policy is unavailable');
  }
  let sourceAuthorized = false;
  const repositoryCapability = await createWorkflowKnowledgeRepositoryCapability(
    prisma,
    principal,
    async (repoId, actor) => {
      if (actor.kind !== 'workflow' || repoId !== principal.repoId) {
        return false;
      }
      if (!actor.launchedById) {
        sourceAuthorized = gate.mode !== 'enforce';
        return sourceAuthorized;
      }
      const user = await prisma.user.findUnique({
        select: { isActive: true, role: true },
        where: { id: actor.launchedById },
      });
      if (!user?.isActive) {
        return false;
      }
      if (user.role === 'ADMIN') {
        sourceAuthorized = true;
        return true;
      }
      if (gate.mode !== 'enforce') {
        sourceAuthorized = true;
        return true;
      }
      const permission = await prisma.repoAccess.findUnique({
        select: { checkedAt: true, permission: true },
        where: { userId_connectionId: { connectionId: repoId, userId: actor.launchedById } },
      });
      const freshAfter = Date.now() - gate.staleAfterHours * 60 * 60 * 1000;
      sourceAuthorized = Boolean(
        permission &&
          permission.checkedAt.getTime() >= freshAfter &&
          ['READ', 'WRITE', 'ADMIN'].includes(permission.permission)
      );
      return sourceAuthorized;
    }
  );
  return { principal, repositoryCapability, sourceAuthorized };
}

/**
 * Retrieve only records admitted by the shared scope policy, then rank the bounded eligible set.
 * The semantic path excludes vectors whose digest or model no longer matches current content.
 */
export async function searchWorkflowKnowledge(
  query: string,
  options: { limit?: number; maxChars?: number } = {}
): Promise<{ results: KnowledgeSearchResult[]; mode: 'semantic' | 'text' }> {
  const text = query.trim();
  if (!text || text.length > 2_000) {
    throw new RangeError('query must be 1..2000 characters');
  }
  const scope = await resolveKnowledgeExecutionScope();
  const configuredLimit = await resolveSetting('memory.knowledgeMaxResults', {
    orgId: scope.principal.orgId ?? undefined,
    teamId: scope.principal.teamId ?? undefined,
  });
  const limit = options.limit ?? configuredLimit;
  const maxChars = options.maxChars ?? MAX_RESULT_CHARS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new RangeError('limit must be 1..10');
  }
  if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > MAX_RESULT_CHARS) {
    throw new RangeError('maxChars must be 100..8000');
  }
  const { principal, repositoryCapability } = scope;
  const where = await getKnowledgeWorkflowEligibilityWhere(principal, repositoryCapability);
  try {
    const currentSpec = await currentEmbeddingSpec();
    const { embedding, spec } = await generateEmbeddingWithSpec(text);
    if (spec !== currentSpec) {
      throw new Error('Embedding configuration changed during query');
    }
    const candidates = await prisma.knowledgeItem.findMany({
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      select: {
        content: true,
        contentDigest: true,
        embeddingDigest: true,
        embeddingModel: true,
        id: true,
        status: true,
        title: true,
        version: true,
      },
      take: MAX_CANDIDATES,
      where: { AND: [where, { contentDigest: { not: '' } }] },
    });
    await indexKnowledgeCandidates(candidates, currentSpec);
    const ids = candidates.map((candidate) => candidate.id);
    if (ids.length) {
      const ranked = await prisma.$queryRaw<Array<{ id: string; similarity: number }>>(Prisma.sql`
        SELECT id, 1 - (embedding <=> ${JSON.stringify(embedding)}::vector) AS similarity
        FROM knowledge_items
        WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
          AND embedding IS NOT NULL
          AND embedding_digest = content_digest
          AND embedding_model = ${spec}
        ORDER BY embedding <=> ${JSON.stringify(embedding)}::vector ASC, id ASC
        LIMIT ${limit}
      `);
      const byId = new Map(ranked.map((row) => [row.id, row.similarity]));
      const rows = await prisma.knowledgeItem.findMany({
        select: {
          content: true,
          createdAt: true,
          id: true,
          status: true,
          title: true,
          type: true,
          version: true,
          visibility: true,
        },
        where: { AND: [where, { id: { in: ranked.map((row) => row.id) } }] },
      });
      const result = rows
        .map((row) => ({ row, similarity: byId.get(row.id) ?? 0 }))
        .sort((a, b) => b.similarity - a.similarity || a.row.id.localeCompare(b.row.id));
      const results = boundedProjection(
        await withoutFlaggedKnowledge(
          result.map(({ row, similarity }) => ({
            ...toKnowledgeScalarProjection(row),
            similarity,
          }))
        ),
        limit,
        maxChars
      );
      if (results.length) {
        return { mode: 'semantic', results };
      }
    }
  } catch {
    // Embedding/provider failure degrades to bounded authorized text search only.
  }
  const fallback = await listKnowledgeForWorkflow(prisma, principal, repositoryCapability, 100);
  const matches = fallback.filter((item) =>
    `${item.title}\n${item.content}`.toLocaleLowerCase().includes(text.toLocaleLowerCase())
  );
  return {
    mode: 'text',
    // Scan only what can be returned: up to 100 candidates of 12k characters each
    // would otherwise all pass through the single regex worker on every search.
    results: boundedProjection(
      await withoutFlaggedKnowledge(matches.slice(0, limit)),
      limit,
      maxChars
    ),
  };
}

/**
 * Knowledge is replayed into later runs exactly as memory is, and an
 * UNREVIEWED learning reaches them before anyone has read it, so recall drops
 * an item matching an injection pattern before it can reach a prompt (see
 * `memoryGuard.ts`). Items can be shared across teams, so the drop event
 * records only a count, never ids.
 */
function withoutFlaggedKnowledge<T extends { id: string; title: string; content: string }>(
  rows: T[]
): Promise<T[]> {
  return withoutFlaggedMemory(rows, (row) => `${row.title}\n${row.content}`, {
    idOf: (row) => row.id,
    recordIds: false,
  });
}

export async function indexKnowledgeCandidates(
  candidates: Array<{
    content: string;
    contentDigest: string;
    embeddingDigest: string | null;
    embeddingModel: string | null;
    id: string;
    status: string;
    title: string;
    version: number;
  }>,
  expectedSpec: string
): Promise<void> {
  const missing = candidates
    .filter(
      (item) =>
        (item.status === 'UNREVIEWED' || item.status === 'APPROVED') &&
        (item.embeddingDigest !== item.contentDigest || item.embeddingModel !== expectedSpec)
    )
    .slice(0, MAX_INDEX_BATCH);
  for (const item of missing) {
    if (!item.contentDigest || item.contentDigest.length > 128) {
      continue;
    }
    try {
      await assertBudgetAvailable('knowledge.embedding');
      const text = `${item.title}\n${item.content}`.slice(0, MAX_INDEX_TEXT_CHARS);
      const { embedding, spec } = await generateEmbeddingWithSpec(text);
      if (spec !== expectedSpec || (await currentEmbeddingSpec()) !== expectedSpec) {
        continue;
      }
      // UUID and vector values are explicitly cast by PostgreSQL; content digest and
      // version CAS prevents a late embedding from reviving edited or withdrawn text.
      await prisma.$executeRaw(Prisma.sql`
        UPDATE knowledge_items
        SET embedding = ${JSON.stringify(embedding)}::vector,
            embedding_model = ${spec},
            embedding_digest = ${item.contentDigest}
        WHERE id = ${item.id}::uuid
          AND content_digest = ${item.contentDigest}
          AND version = ${item.version}
          AND status IN ('UNREVIEWED', 'APPROVED')
      `);
    } catch {
      // Indexing is opportunistic. Authorized text retrieval remains available.
      return;
    }
  }
}

function boundedProjection(
  rows: Array<{
    id: string;
    title: string;
    content: string;
    type: string;
    trustLabel: string;
    version: number;
    similarity?: number;
  }>,
  limit: number,
  maxChars: number
): KnowledgeSearchResult[] {
  const results: KnowledgeSearchResult[] = [];
  let used = 0;
  for (const row of rows.slice(0, limit)) {
    const title = row.title.slice(0, 200);
    const content = row.content.slice(0, MAX_ITEM_CHARS);
    const citation = `knowledge:${row.id}:v${row.version}`;
    const cost = title.length + content.length + citation.length;
    if (used + cost > maxChars) {
      continue;
    }
    used += cost;
    results.push({
      citation,
      content,
      id: row.id,
      title,
      trustLabel: row.trustLabel,
      type: row.type,
      version: row.version,
      ...(row.similarity === undefined ? {} : { similarity: row.similarity }),
    });
  }
  return results;
}

/** Submit local learning with a run/node key; scope and actor attribution come only from Temporal/DB. */
export async function submitWorkflowLearning(
  input: unknown,
  resolveEvidence: Parameters<typeof submitKnowledgeLearning>[3]
) {
  const tag = currentNodeTag();
  if (!tag?.recordingId || !Number.isInteger(tag.stepAttempt) || tag.stepAttempt < 1) {
    throw new KnowledgeAccessError('Learning capture requires a trusted current workflow node');
  }
  if (
    !input ||
    typeof input !== 'object' ||
    !('nodeId' in input) ||
    input.nodeId !== tag.specNodeId
  ) {
    throw new KnowledgeAccessError('Learning node does not match the current workflow node');
  }
  const { principal, sourceAuthorized } = await resolveKnowledgeExecutionScope();
  if (principal.repoId && !sourceAuthorized) {
    throw new KnowledgeAccessError('Source repository access required to capture learning');
  }
  // A learning is model-written text that later runs recall, so it passes the
  // same fail-closed injection gate as every memory write.
  const { title, content } = input as { title?: unknown; content?: unknown };
  try {
    await assertMemoryContentAllowed([
      typeof title === 'string' ? title : '',
      typeof content === 'string' ? content : '',
    ]);
  } catch (err) {
    if (err instanceof MemoryContentRefusedError) {
      const event = memoryWriteRefusalEvent(err, MEMORY_SECURITY_EVENTS.KNOWLEDGE_LEARNING_REFUSED, {
        nodeId: tag.specNodeId,
      });
      await recordMemorySecurityEvent(event.name, event.outputJson);
    }
    throw err;
  }
  return submitKnowledgeLearning(prisma, principal, input, resolveEvidence, {
    recordingId: tag.recordingId,
    specNodeId: tag.specNodeId,
    stepAttempt: tag.stepAttempt,
  });
}

/** Resolve evidence only from worker-recorded, passed quality-gate provenance for this execution. */
export async function resolveStepProducerTrace(
  _runId: string,
  _recordingId: string,
  _specNodeId: string,
  _stepAttempt: number
): Promise<null> {
  // Agent traces are persisted after generation, while submitLearning may run
  // inside generation. Resettable stepAttempt plus Temporal retry attempt cannot
  // distinguish a prior visit, so historical attribution is intentionally omitted.
  return null;
}

export async function resolveWorkflowKnowledgeEvidence(
  refs: KnowledgeEvidence[],
  execution: { runId: string; requestedNodeId: string }
) {
  const { principal, sourceAuthorized } = await resolveKnowledgeExecutionScope();
  const temporalRunId = activityInfo().workflowExecution?.runId;
  const currentTag = currentNodeTag();
  if (
    !currentTag ||
    currentTag.specNodeId !== execution.requestedNodeId ||
    principal.runId !== execution.runId ||
    principal.temporalRunId !== temporalRunId ||
    refs.length === 0 ||
    (principal.repoId !== null && !sourceAuthorized)
  ) {
    throw new KnowledgeAccessError('Evidence belongs to another execution');
  }
  const requestedReferences = [...new Set(refs.map((ref) => ref.reference))];
  // SAFETY: the Prisma schema and generated client define this worker-owned provenance delegate.
  const trustedEvidence = (
    prisma as unknown as {
      trustedKnowledgeEvidence: TrustedEvidenceDelegate;
    }
  ).trustedKnowledgeEvidence;
  const records = await trustedEvidence.findMany({
    select: {
      activityAttempt: true,
      artifactId: true,
      evidenceCorrelation: true,
      gateName: true,
      id: true,
      recordingId: true,
      specNodeId: true,
      stepAttempt: true,
      summary: true,
    },
    where: {
      OR: [{ artifactId: { in: requestedReferences } }, { id: { in: requestedReferences } }],
      outcome: 'PASSED',
      producer: 'QUALITY_GATE',
      runId: principal.runId,
      temporalRunId: principal.temporalRunId,
    },
  });
  if (records.length !== refs.length || records.some((record) => !record.artifactId)) {
    throw new KnowledgeAccessError('Evidence is not a persisted trusted producer result');
  }
  const attachedArtifacts = await prisma.workflowArtifact.findMany({
    select: { id: true },
    where: {
      id: { in: records.map((record) => record.artifactId as string) },
      runId: principal.runId,
    },
  });
  if (attachedArtifacts.length !== records.length) {
    throw new KnowledgeAccessError('Evidence artifact is not attached to this execution');
  }
  const steps = await prisma.workflowStep.findMany({
    select: {
      attempt: true,
      nodeId: true,
      nodeType: true,
      outputs: true,
      specNodeId: true,
      status: true,
      stepName: true,
    },
    where: {
      OR: records.map((record) => ({
        attempt: record.stepAttempt,
        nodeId: record.recordingId,
      })),
      runId: principal.runId,
      status: 'PASSED',
    },
  });
  const currentBranch = branchPath(currentTag.recordingId, currentTag.specNodeId);
  if (currentBranch === null) {
    throw new KnowledgeAccessError('Current workflow node identity is malformed');
  }
  const normalizedEvidence: KnowledgeEvidence[] = [];
  for (const ref of refs) {
    const record = records.find(
      (candidate) => candidate.id === ref.reference || candidate.artifactId === ref.reference
    );
    if (
      !record ||
      branchPath(record.recordingId, record.specNodeId) !== currentBranch ||
      !steps.some(
        (step) =>
          step.nodeId === record.recordingId &&
          step.specNodeId === record.specNodeId &&
          step.nodeType === 'step' &&
          step.stepName === record.gateName &&
          step.attempt === record.stepAttempt &&
          step.status === 'PASSED' &&
          isExactPassedGateResult(step.outputs, record)
      ) ||
      (ref.kind !== 'artifact' && !(ref.kind === 'test' && record.gateName === 'runTests'))
    ) {
      throw new KnowledgeAccessError(
        'Evidence does not match a passed gate for this exact node attempt'
      );
    }
    normalizedEvidence.push({
      kind: record.gateName === 'runTests' ? 'test' : 'artifact',
      note: record.summary,
      reference: record.artifactId as string,
    });
  }
  return {
    evidence: normalizedEvidence,
    modelSpec: null,
    nodeId: currentTag.specNodeId,
    producerAgentKey: null,
  };
}

function branchPath(recordingId: string, specNodeId: string): string | null {
  if (!recordingId || !specNodeId) {
    return null;
  }
  if (recordingId === specNodeId) {
    return '';
  }
  const suffix = `/${specNodeId}`;
  if (!recordingId.endsWith(suffix)) {
    return null;
  }
  const prefix = recordingId.slice(0, -suffix.length);
  if (
    !prefix ||
    prefix.startsWith('/') ||
    prefix.endsWith('/') ||
    prefix.includes('//') ||
    !/(?:^|\/)[^/]*\[\d+\]$/.test(prefix)
  ) {
    return null;
  }
  return prefix;
}

function isExactPassedGateResult(outputs: unknown, record: TrustedGateEvidenceRecord): boolean {
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) {
    return false;
  }
  const result = outputs as Record<string, unknown>;
  return (
    result.passed === true &&
    result.exitCode === 0 &&
    result.artifactId === record.artifactId &&
    result.evidenceCorrelation === record.evidenceCorrelation &&
    result.activityAttempt === record.activityAttempt &&
    result.gateName === record.gateName
  );
}
