import type { KnowledgeEvidence } from '@auto-swe/shared';
import { ApplicationFailure } from '@temporalio/activity';
import { LEARNING_REFUSED_MESSAGE } from '../agents/knowledgeTools.js';
import {
  resolveWorkflowKnowledgeEvidence,
  searchWorkflowKnowledge,
  submitWorkflowLearning,
} from '../lib/knowledgeRuntime.js';
import { MemoryContentRefusedError } from '../lib/memoryGuard.js';

export async function retrieveKnowledge(input: { query: string; limit?: number }) {
  const result = await searchWorkflowKnowledge(input.query, { limit: input.limit });
  return { mode: result.mode, results: result.results };
}

export async function captureLearning(input: {
  title: string;
  content: string;
  nodeId: string;
  idempotencyKey: string;
  evidence: KnowledgeEvidence[];
}) {
  let result: Awaited<ReturnType<typeof submitWorkflowLearning>>;
  try {
    result = await submitWorkflowLearning(input, resolveWorkflowKnowledgeEvidence);
  } catch (err) {
    // The same text will match again on a retry; only an incomplete scan is worth one.
    if (err instanceof MemoryContentRefusedError && err.reason === 'matched') {
      throw ApplicationFailure.nonRetryable(LEARNING_REFUSED_MESSAGE, 'MEMORY_CONTENT_REFUSED');
    }
    throw err;
  }
  return { id: result.id, status: 'UNREVIEWED' as const, version: result.version };
}
