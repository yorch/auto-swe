import type { KnowledgeEvidence } from '@auto-swe/shared';
import {
  resolveWorkflowKnowledgeEvidence,
  searchWorkflowKnowledge,
  submitWorkflowLearning,
} from '../lib/knowledgeRuntime.js';

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
  const result = await submitWorkflowLearning(input, resolveWorkflowKnowledgeEvidence);
  return { id: result.id, status: 'UNREVIEWED' as const, version: result.version };
}
