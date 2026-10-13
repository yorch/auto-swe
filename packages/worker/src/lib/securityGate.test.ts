import { ApplicationFailure } from '@temporalio/activity';
import { describe, expect, it, vi } from 'vitest';
import type { AgentTracer } from './agentTracer.js';
import { runPostDiffSecurityGate, type SecurityGateScanners } from './securityGate.js';

function tracer() {
  const addActivityEvent = vi.fn();
  return { addActivityEvent, tracer: { addActivityEvent } as unknown as AgentTracer };
}

function scanners() {
  return {
    scanDiffForCodeIssues: vi.fn<SecurityGateScanners['scanDiffForCodeIssues']>(async () => []),
    scanDiffForSecurityIssues: vi.fn<SecurityGateScanners['scanDiffForSecurityIssues']>(
      async () => ({ findings: [], passed: true })
    ),
  };
}

async function failureOf(p: Promise<unknown>): Promise<ApplicationFailure> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApplicationFailure) return err;
    throw err;
  }
  throw new Error('expected the gate to fail');
}

describe('runPostDiffSecurityGate', () => {
  it('returns the advisory findings when the gate passes', async () => {
    const s = scanners();
    const finding = { file: 'a.ts', label: 'code-eval', line: 1, match: 'x' };
    s.scanDiffForCodeIssues.mockResolvedValue([finding]);
    const t = tracer();
    await expect(runPostDiffSecurityGate('diff', t.tracer, s)).resolves.toEqual([finding]);
    expect(s.scanDiffForSecurityIssues).toHaveBeenCalledWith('diff');
    expect(t.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'code_security.scan', outputJson: expect.anything() })
    );
  });

  it('degrades, rather than aborts, when the advisory code scanner throws', async () => {
    const s = scanners();
    s.scanDiffForCodeIssues.mockRejectedValue(new Error('pattern db down'));
    const t = tracer();
    await expect(runPostDiffSecurityGate('diff', t.tracer, s)).resolves.toEqual([]);
    expect(t.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'pattern db down', outputJson: { degraded: true } })
    );
    expect(s.scanDiffForSecurityIssues).toHaveBeenCalled();
  });

  it('turns a gate that throws into non-retryable SECURITY_GATE_UNAVAILABLE', async () => {
    const s = scanners();
    s.scanDiffForSecurityIssues.mockRejectedValue(new Error('provider 500'));
    const f = await failureOf(runPostDiffSecurityGate('diff', tracer().tracer, s));
    expect(f.type).toBe('SECURITY_GATE_UNAVAILABLE');
    expect(f.nonRetryable).toBe(true);
    expect(f.message).toBe('Security gate could not complete: provider 500');
  });

  it('passes a budget stop through as BUDGET_EXCEEDED', async () => {
    const s = scanners();
    const budget = ApplicationFailure.nonRetryable('over', 'BUDGET_EXCEEDED');
    s.scanDiffForSecurityIssues.mockRejectedValue(budget);
    expect(await failureOf(runPostDiffSecurityGate('diff', tracer().tracer, s))).toBe(budget);
  });

  it('turns a critical finding into SECURITY_GATE_FAILURE with the findings', async () => {
    const s = scanners();
    const findings = [
      {
        category: 'secrets',
        description: 'hardcoded key',
        file: 'src/a.ts',
        line: 3,
        severity: 'CRITICAL' as const,
        suggestedFix: 'remove',
      },
    ];
    s.scanDiffForSecurityIssues.mockResolvedValue({ findings, passed: false });
    const f = await failureOf(runPostDiffSecurityGate('diff', tracer().tracer, s));
    expect(f.type).toBe('SECURITY_GATE_FAILURE');
    expect(f.nonRetryable).toBe(true);
    expect(f.message).toBe(
      'Security scan failed with critical findings:\n[CRITICAL] src/a.ts:3 — secrets: hardcoded key'
    );
    expect(f.details).toEqual([{ findings }]);
  });
});
