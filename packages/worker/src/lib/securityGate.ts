import type { CodeSecurityFinding } from '@auto-swe/shared/types/workflow';
import { ApplicationFailure } from '@temporalio/activity';
import type { SecurityScanResult } from '../agents/securityReviewProcessor.js';
import type { AgentTracer } from './agentTracer.js';

/** The two scanners the post-diff gate runs; injected so each caller keeps its own seam. */
export interface SecurityGateScanners {
  scanDiffForCodeIssues: (diff: string) => Promise<CodeSecurityFinding[]>;
  scanDiffForSecurityIssues: (diff: string) => Promise<SecurityScanResult>;
}

/**
 * The post-diff security gate every implementation, fix, merge-resolution and
 * agent-run path runs on the change it produced.
 *
 *  1. The advisory code scanner. A scanner that cannot run degrades to no
 *     findings — it costs findings, never the run.
 *  2. The LLM gate. Every failure is non-retryable and fails closed:
 *     - gate cannot complete -> SECURITY_GATE_UNAVAILABLE. A retry would re-run
 *       the whole paid session (and, after a push, leave the pushed commit
 *       unscanned in the meantime), so a gate that errors is never retried.
 *       A budget stop keeps its own BUDGET_EXCEEDED type: it is the more
 *       specific truth.
 *     - CRITICAL finding     -> SECURITY_GATE_FAILURE, with the findings as details.
 *
 * Returns the advisory findings for the caller's result.
 */
export async function runPostDiffSecurityGate(
  diff: string,
  tracer: AgentTracer,
  scanners: SecurityGateScanners
): Promise<CodeSecurityFinding[]> {
  let codeSecurityFindings: CodeSecurityFinding[] = [];
  try {
    codeSecurityFindings = await scanners.scanDiffForCodeIssues(diff);
  } catch (err) {
    tracer.addActivityEvent({
      error: err instanceof Error ? err.message : String(err),
      name: 'code_security.scan',
      outputJson: { degraded: true },
    });
  }
  if (codeSecurityFindings.length > 0) {
    tracer.addActivityEvent({
      name: 'code_security.scan',
      outputJson: { count: codeSecurityFindings.length, findings: codeSecurityFindings },
    });
  }

  let securityResult: SecurityScanResult;
  try {
    securityResult = await scanners.scanDiffForSecurityIssues(diff);
  } catch (err) {
    if (err instanceof ApplicationFailure && err.type === 'BUDGET_EXCEEDED') {
      throw err;
    }
    throw ApplicationFailure.nonRetryable(
      `Security gate could not complete: ${err instanceof Error ? err.message : String(err)}`,
      'SECURITY_GATE_UNAVAILABLE'
    );
  }
  if (!securityResult.passed) {
    const findingsSummary = securityResult.findings
      .map(
        (f) =>
          `[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.category}: ${f.description}`
      )
      .join('\n');
    throw ApplicationFailure.nonRetryable(
      `Security scan failed with critical findings:\n${findingsSummary}`,
      'SECURITY_GATE_FAILURE',
      { findings: securityResult.findings }
    );
  }
  return codeSecurityFindings;
}
