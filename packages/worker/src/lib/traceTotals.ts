import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';

/** The agent key `generateEmbedding` records its usage rows under. */
export const EMBEDDING_AGENT_KEY = 'embedding';

/**
 * A run's spend as summed from its AgentTrace rows — the record for runs that
 * keep no ActiveWorkflow ledger.
 *
 * Embedding rows count toward cost but not tokens, matching what the ledger
 * does for runs that have one: run token totals mean chat tokens on every path,
 * which is what the per-tier budgets are measured in.
 */
export async function sumRunTraceUsage(
  runId: string
): Promise<{ costUsd: number; inputTokens: bigint; outputTokens: bigint }> {
  const [cost, tokens] = await runUnscoped('scoped by one run', ['AgentTrace'], () =>
    Promise.all([
      prisma.agentTrace.aggregate({ _sum: { costUsd: true }, where: { runId } }),
      prisma.agentTrace.aggregate({
        _sum: { inputTokens: true, outputTokens: true },
        where: { agentKey: { not: EMBEDDING_AGENT_KEY }, runId },
      }),
    ])
  );
  return {
    costUsd: cost._sum.costUsd ?? 0,
    inputTokens: BigInt(tokens._sum.inputTokens ?? 0),
    outputTokens: BigInt(tokens._sum.outputTokens ?? 0),
  };
}
