import { formatCost, formatDuration, formatTokens } from '@/lib/utils';

interface RunMetaFacts {
  startedAt: string | null;
  endedAt: string | null;
  costUsdAccrued: number;
  tokensInputTotal: number;
  tokensOutputTotal: number;
}

/**
 * The few facts the details panel shows on its collapsed header (a phone, where the panel
 * starts closed): how long the run took, what it cost and how many tokens it used. A fact the
 * run has no value for is left out rather than shown as zero.
 */
export function runMetaSummary(run: RunMetaFacts): string[] {
  const parts: string[] = [];
  if (run.startedAt && run.endedAt) {
    parts.push(formatDuration(new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()));
  }
  if (run.costUsdAccrued > 0) {
    parts.push(formatCost(run.costUsdAccrued));
  }
  const tokens = run.tokensInputTotal + run.tokensOutputTotal;
  if (tokens > 0) {
    parts.push(`${formatTokens(tokens)} tokens`);
  }
  return parts;
}
