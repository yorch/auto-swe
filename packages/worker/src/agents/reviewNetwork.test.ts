import type { CodeResult } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));

const generateMock = vi.fn();
vi.mock('@mastra/core/agent', () => ({
  Agent: vi.fn().mockImplementation(function (this: Record<string, unknown>, config: unknown) {
    this.config = config;
    this.generate = generateMock;
  }),
}));

vi.mock('../lib/activityContext.js', () => ({
  currentWorkflowId: vi.fn().mockReturnValue('wf-1'),
}));

vi.mock('../lib/codeSecurityScanner.js', () => ({
  formatCodeSecurityFindings: vi.fn(() => ''),
}));

const { assertRolePricedMock } = vi.hoisted(() => ({
  assertRolePricedMock: vi.fn(async (_role: string) => {}),
}));
vi.mock('../lib/usdCapGuard.js', () => ({ assertRolePricedForUsdCap: assertRolePricedMock }));
const unpriced = () =>
  Object.assign(new Error('Model has no price in the model catalog'), { type: 'MODEL_UNPRICED' });

vi.mock('../lib/costTracking.js', () => ({
  assertBudgetAvailable: vi.fn(async () => {}),
  recordLlmUsage: vi
    .fn()
    .mockResolvedValue({ costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 }),
}));

vi.mock('../lib/models.js', () => ({
  getModel: vi.fn(async () => ({ sentinel: 'model' })),
  getModelSpec: vi.fn(async () => 'anthropic/claude-x'),
}));

import { Agent } from '@mastra/core/agent';
import { ApplicationFailure } from '@temporalio/activity';
import { ConfigMissingError } from '../lib/config/resolver.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { getModel } from '../lib/models.js';
import { runReviewNetwork } from './reviewNetwork.js';

const MockedAgent = vi.mocked(Agent);

const CODE_RESULT: CodeResult = {
  branch: 'auto/JIRA-1',
  diff: 'diff --git a/a.ts b/a.ts',
  filesChanged: [],
  headSha: 'abc',
  implementationNotes: 'notes',
  repoId: 'repo-1',
  testResults: { duration_ms: 1, failing: 0, passed: true, passing: 1, stdout: '', total: 1 },
};

/** System prompt each reviewer agent was constructed with, keyed by agent id. */
function instructionsById(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const call of MockedAgent.mock.calls) {
    const cfg = call[0] as unknown as { id: string; instructions: string };
    out[cfg.id] = cfg.instructions;
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  generateMock.mockImplementation(async () => ({
    object: { approved: true, findings: [], reviewer: 'SECURITY', severity: 'PASS' },
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
});

describe('runReviewNetwork USD-cap guard', () => {
  it('refuses an unpriced reviewer model before any reviewer runs', async () => {
    assertRolePricedMock.mockRejectedValueOnce(unpriced());
    await expect(runReviewNetwork(CODE_RESULT)).rejects.toMatchObject({ type: 'MODEL_UNPRICED' });
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('checks each reviewer persona once, and proceeds when priced', async () => {
    await runReviewNetwork(CODE_RESULT);
    expect(assertRolePricedMock.mock.calls.map((c) => c[0]).sort()).toEqual([
      'domainLogicReviewer',
      'performanceReviewer',
      'securityReviewer',
    ]);
    expect(generateMock).toHaveBeenCalledTimes(3);
  });
});

describe('runReviewNetwork cross-repo context', () => {
  const BLOCK = '\n\n## Cross-Repo Dependency Context\n- acme/api — kinds: code';

  it('appends the block to all three reviewer system prompts', async () => {
    await runReviewNetwork(CODE_RESULT, { crossRepoContext: BLOCK });

    const prompts = instructionsById();
    expect(Object.keys(prompts).sort()).toEqual([
      'domain_logic-reviewer',
      'performance-reviewer',
      'security-reviewer',
    ]);
    for (const prompt of Object.values(prompts)) {
      expect(prompt).toContain('## Cross-Repo Dependency Context');
      expect(prompt).toContain('- acme/api — kinds: code');
    }
  });

  it('leaves the prompts untouched when no block is supplied', async () => {
    await runReviewNetwork(CODE_RESULT);
    for (const prompt of Object.values(instructionsById())) {
      expect(prompt).not.toContain('Cross-Repo Dependency Context');
    }
  });

  it('keeps the block after the success criteria and skill suffixes', async () => {
    await runReviewNetwork(CODE_RESULT, {
      crossRepoContext: BLOCK,
      domainSkillSuffix: 'DOMAIN_SKILL',
      performanceSkillSuffix: 'PERF_SKILL',
      securitySkillSuffix: 'SEC_SKILL',
      successCriteria: ['criterion one'],
    });

    const prompts = instructionsById();
    const domain = prompts['domain_logic-reviewer'];
    expect(domain).toContain('criterion one');
    expect(domain.indexOf('DOMAIN_SKILL')).toBeLessThan(domain.indexOf('Cross-Repo'));
    expect(prompts['security-reviewer'].indexOf('SEC_SKILL')).toBeLessThan(
      prompts['security-reviewer'].indexOf('Cross-Repo')
    );
    expect(prompts['performance-reviewer'].indexOf('PERF_SKILL')).toBeLessThan(
      prompts['performance-reviewer'].indexOf('Cross-Repo')
    );
  });

  it('separates a block that carries no leading blank line', async () => {
    await runReviewNetwork(CODE_RESULT, {
      crossRepoContext: '## Cross-Repo Dependency Context',
    });
    for (const prompt of Object.values(instructionsById())) {
      expect(prompt).toContain('\n\n## Cross-Repo Dependency Context');
    }
  });
});

describe('runReviewNetwork per-persona configuration', () => {
  it("builds each reviewer from its own persona's prompt", async () => {
    await runReviewNetwork(CODE_RESULT, {
      domainLogicPrompt: 'DOMAIN ROW',
      performancePrompt: 'PERF ROW',
      securityPrompt: 'SECURITY ROW',
    });
    const prompts = instructionsById();
    expect(prompts['security-reviewer']?.startsWith('SECURITY ROW')).toBe(true);
    expect(prompts['domain_logic-reviewer']?.startsWith('DOMAIN ROW')).toBe(true);
    expect(prompts['performance-reviewer']?.startsWith('PERF ROW')).toBe(true);
  });

  it('falls back to the built-in persona prompts, which differ from one another', async () => {
    await runReviewNetwork(CODE_RESULT);
    const prompts = Object.values(instructionsById());
    expect(new Set(prompts).size).toBe(3);
  });

  it('lets a step-level override replace every persona prompt', async () => {
    await runReviewNetwork(CODE_RESULT, {
      securityPrompt: 'SECURITY ROW',
      systemPromptOverride: 'STEP PROMPT',
    });
    for (const prompt of Object.values(instructionsById())) {
      expect(prompt.startsWith('STEP PROMPT')).toBe(true);
    }
  });

  it("binds each reviewer's model and cost through its own persona key", async () => {
    await runReviewNetwork(CODE_RESULT);
    const modelKeys = vi.mocked(getModel).mock.calls.map((c) => c[0]);
    expect(modelKeys.sort()).toEqual([
      'domainLogicReviewer',
      'performanceReviewer',
      'securityReviewer',
    ]);
    const usageKeys = vi.mocked(recordLlmUsage).mock.calls.map((c) => c[1]);
    expect(usageKeys.sort()).toEqual([
      'domainLogicReviewer',
      'performanceReviewer',
      'securityReviewer',
    ]);
  });
});

describe('runReviewNetwork reviewer failures', () => {
  const ok = (severity = 'PASS', approved = true, findings: unknown[] = []) => ({
    object: { approved, findings, reviewer: 'SECURITY', severity },
    usage: { inputTokens: 1, outputTokens: 1 },
  });

  it('rethrows a non-retryable failure (budget) instead of a REVIEWER_CRASH verdict', async () => {
    generateMock
      .mockImplementationOnce(async () => ok())
      .mockImplementationOnce(async () => {
        throw ApplicationFailure.nonRetryable('Budget exhausted', 'BUDGET_EXCEEDED');
      })
      .mockImplementationOnce(async () => ok());
    await expect(runReviewNetwork(CODE_RESULT)).rejects.toMatchObject({
      nonRetryable: true,
      type: 'BUDGET_EXCEEDED',
    });
  });

  it('rethrows ConfigMissingError', async () => {
    vi.mocked(getModel).mockRejectedValueOnce(new ConfigMissingError('no reviewer row'));
    await expect(runReviewNetwork(CODE_RESULT)).rejects.toBeInstanceOf(ConfigMissingError);
  });

  it('throws a retryable failure when every reviewer crashed', async () => {
    generateMock.mockImplementation(async () => {
      throw new Error('provider 503');
    });
    const err = await runReviewNetwork(CODE_RESULT).catch((e) => e);
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect(err).toMatchObject({ nonRetryable: false, type: 'REVIEW_NETWORK_UNAVAILABLE' });
    expect(err.message).toContain('provider 503');
  });

  it('keeps the synthetic REVIEWER_CRASH verdict when only some reviewers crashed', async () => {
    generateMock
      .mockImplementationOnce(async () => ok())
      .mockImplementationOnce(async () => {
        throw new Error('provider 503');
      })
      .mockImplementationOnce(async () => ok());
    const result = await runReviewNetwork(CODE_RESULT);
    expect(result.approved).toBe(false);
    const crashed = result.verdicts.find((v) => v.reviewer === 'DOMAIN_LOGIC');
    expect(crashed?.findings[0]?.category).toBe('REVIEWER_CRASH');
    expect(result.rejectionSummary).toContain('provider 503');
  });

  it('treats a structured output that fails the schema as a reviewer failure', async () => {
    generateMock
      .mockImplementationOnce(async () => ok())
      .mockImplementationOnce(async () => ({ object: { approved: true }, usage: undefined }))
      .mockImplementationOnce(async () => ok());
    const result = await runReviewNetwork(CODE_RESULT);
    expect(result.approved).toBe(false);
    expect(result.rejectionSummary).toContain('did not return valid structured output');
  });
});

describe('runReviewNetwork verdict consistency and summary', () => {
  it('treats a CRITICAL verdict as a rejection even when approved is true', async () => {
    generateMock.mockImplementationOnce(async () => ({
      object: {
        approved: true,
        findings: [
          {
            category: 'INJECTION',
            description: 'SQL built by concatenation',
            file: 'a.ts',
            line: 3,
            suggestedFix: 'Use a parameterised query',
          },
        ],
        reviewer: 'SECURITY',
        severity: 'CRITICAL',
      },
      usage: undefined,
    }));
    const result = await runReviewNetwork(CODE_RESULT);
    expect(result.approved).toBe(false);
    expect(result.verdicts.find((v) => v.reviewer === 'SECURITY')?.approved).toBe(false);
    // The fixer sees the problem and its severity, not only the fix.
    expect(result.rejectionSummary).toBe(
      '[SECURITY/CRITICAL] [INJECTION] a.ts:3 — SQL built by concatenation — Suggested fix: Use a parameterised query'
    );
  });

  it('names a reviewer that rejected without findings', async () => {
    generateMock.mockImplementationOnce(async () => ({
      object: { approved: false, findings: [], reviewer: 'SECURITY', severity: 'WARNING' },
      usage: undefined,
    }));
    const result = await runReviewNetwork(CODE_RESULT);
    expect(result.approved).toBe(false);
    expect(result.rejectionSummary).toContain('rejected without findings: SECURITY');
  });
});
