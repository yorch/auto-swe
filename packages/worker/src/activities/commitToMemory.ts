import { Agent } from '@mastra/core/agent';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import { prisma } from '@auto-swe/shared/db';
import { generateEmbedding } from '../lib/embeddings.js';
import { MEMORY_SUMMARIZER_PROMPT } from '../agents/prompts.js';

const LessonOutputSchema = z.object({
  rationale: z.string(),
  lessonSummary: z.string(),
  failureType: z.enum(['CI_FAILURE', 'REVIEW_REJECTION', 'SECURITY_VIOLATION', 'MERGE_CONFLICT']).nullable(),
  metadata: z.record(z.unknown()).nullable(),
});

/**
 * Summarizes a completed workflow into a reusable lesson and persists it
 * with a vector embedding for future semantic search.
 */
export async function commitToMemory(
  temporalWorkflowId: string,
  repoId: string,
): Promise<string> {
  const workflow = await prisma.activeWorkflow.findFirst({
    where: { temporalWorkflowId },
    include: {
      pullRequests: true,
      workRequest: true,
    },
  });

  if (!workflow) {
    throw new Error(`Workflow not found: ${temporalWorkflowId}`);
  }

  // Use Memory Agent to summarize the workflow
  const memoryAgent = new Agent({
    id: 'memory-summarizer',
    name: 'memory-summarizer',
    model: anthropic('claude-opus-4-6'),
    instructions: MEMORY_SUMMARIZER_PROMPT,
  });

  const result = await memoryAgent.generate(
    [
      {
        role: 'user',
        content: JSON.stringify({
          workflowId: workflow.id,
          temporalWorkflowId: workflow.temporalWorkflowId,
          status: workflow.currentStatus,
          externalTicketId: workflow.workRequest?.externalTicketId,
          description: workflow.workRequest?.description,
          pullRequests: workflow.pullRequests.map((pr) => ({
            prNumber: pr.prNumber,
            status: pr.status,
            ciStatus: pr.ciStatus,
          })),
        }),
      },
    ],
    { structuredOutput: { schema: LessonOutputSchema } },
  );

  if (!result.object) {
    throw new Error('Memory summarizer agent did not return structured output');
  }
  const lesson = result.object as z.infer<typeof LessonOutputSchema>;

  // Generate embedding for the lesson summary
  const embedding = await generateEmbedding(lesson.lessonSummary);

  // Persist with embedding via raw SQL (Prisma doesn't support vector type natively)
  const lessonRows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO agent_lessons (id, workflow_id, repo_id, rationale, lesson_summary, embedding, failure_type, metadata, created_at)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5::vector, $6, $7::jsonb, now())
     RETURNING id`,
    workflow.id,
    repoId,
    lesson.rationale,
    lesson.lessonSummary,
    JSON.stringify(embedding),
    lesson.failureType,
    JSON.stringify(lesson.metadata ?? {}),
  );

  return lessonRows[0]?.id ?? '';
}
