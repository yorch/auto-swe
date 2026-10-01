import type { AgentRunLimits } from '@auto-swe/shared/types/api';
import { describe, expect, it } from 'vitest';
import {
  AGENT_RUN_MAX_PROMPT_CHARS,
  type AgentRunFormValues,
  buildAgentRef,
  buildLaunchBody,
  classifyAgentRunFailure,
  describeLaunchError,
  idempotencyFor,
  isAgentRunTemplate,
  parseAgentRunOutcome,
  validateAgentRunForm,
} from './agentRun';
import { ApiError } from './api';

const LIMITS: AgentRunLimits = {
  concurrency: { global: 4, perTeam: 2 },
  enabled: true,
  maxSteps: { ceiling: 50, max: 500, min: 1 },
  maxWallClockSeconds: { ceiling: 1800, max: 14400, min: 60 },
};

const OK: AgentRunFormValues = {
  agentKey: 'contentWriter',
  deliver: 'none',
  maxSteps: '',
  maxWallClockSeconds: '',
  pinnedVersion: null,
  prompt: 'fix the typo',
  repoId: 'repo-1',
};

describe('buildAgentRef', () => {
  it('floats without a pin and pins with one', () => {
    expect(buildAgentRef('contentWriter', null)).toBe('contentWriter');
    expect(buildAgentRef('contentWriter', 3)).toBe('contentWriter@3');
  });
});

describe('validateAgentRunForm', () => {
  it('accepts a minimal form', () => {
    expect(validateAgentRunForm(OK, LIMITS)).toEqual({});
  });

  it('requires an agent, a repository and a prompt', () => {
    const e = validateAgentRunForm({ ...OK, agentKey: '', prompt: '  ', repoId: '' }, LIMITS);
    expect(Object.keys(e).sort()).toEqual(['agentKey', 'prompt', 'repoId']);
  });

  it('bounds the prompt length', () => {
    const long = 'x'.repeat(AGENT_RUN_MAX_PROMPT_CHARS + 1);
    expect(validateAgentRunForm({ ...OK, prompt: long }, LIMITS).prompt).toMatch(/at most/);
    expect(
      validateAgentRunForm({ ...OK, prompt: 'x'.repeat(AGENT_RUN_MAX_PROMPT_CHARS) }, LIMITS)
    ).toEqual({});
  });

  it('lets a cap lower the ceiling, equal it, and refuses one above it', () => {
    expect(validateAgentRunForm({ ...OK, maxSteps: '10' }, LIMITS)).toEqual({});
    expect(validateAgentRunForm({ ...OK, maxSteps: '50' }, LIMITS)).toEqual({});
    expect(validateAgentRunForm({ ...OK, maxSteps: '51' }, LIMITS).maxSteps).toMatch(
      /ceiling of 50/
    );
    expect(
      validateAgentRunForm({ ...OK, maxWallClockSeconds: '1801' }, LIMITS).maxWallClockSeconds
    ).toMatch(/ceiling of 1800/);
  });

  it('enforces the minimum wall clock', () => {
    expect(
      validateAgentRunForm({ ...OK, maxWallClockSeconds: '59' }, LIMITS).maxWallClockSeconds
    ).toMatch(/at least 60/);
  });

  it.each(['0', '-3', '1.5', '1e3', 'abc', '07'])('refuses %s as a cap', (raw) => {
    expect(validateAgentRunForm({ ...OK, maxSteps: raw }, LIMITS).maxSteps).toBeDefined();
  });

  it('falls back to the hard bounds when the limits did not load', () => {
    expect(validateAgentRunForm({ ...OK, maxSteps: '500' }, undefined)).toEqual({});
    expect(validateAgentRunForm({ ...OK, maxSteps: '501' }, undefined).maxSteps).toBeDefined();
  });
});

describe('buildLaunchBody', () => {
  it('omits blank caps and builds the ref', () => {
    expect(buildLaunchBody({ ...OK, pinnedVersion: 2 })).toEqual({
      agent: 'contentWriter@2',
      deliver: 'none',
      maxSteps: undefined,
      maxWallClockSeconds: undefined,
      prompt: 'fix the typo',
      repoId: 'repo-1',
    });
  });

  it('sends caps as numbers', () => {
    const b = buildLaunchBody({ ...OK, maxSteps: ' 12 ', maxWallClockSeconds: '300' });
    expect(b.maxSteps).toBe(12);
    expect(b.maxWallClockSeconds).toBe(300);
  });
});

describe('idempotencyFor', () => {
  it('reuses the key for an identical resubmission and mints a new one when anything changes', () => {
    let n = 0;
    const mint = () => `k${++n}`;
    const a = idempotencyFor(null, { p: 1 }, mint);
    const again = idempotencyFor(a, { p: 1 }, mint);
    expect(again).toBe(a);
    const changed = idempotencyFor(a, { p: 2 }, mint);
    expect(changed.key).toBe('k2');
  });
});

describe('describeLaunchError', () => {
  const e = (status: number, code: string | null, message = 'm') =>
    new ApiError(message, status, code);

  it.each([
    ['AGENT_RUN_CONCURRENCY_EXCEEDED', 429, /in flight/, true],
    ['AGENT_RUNS_DISABLED', 403, /turned off/, false],
    ['CAP_EXCEEDS_CEILING', 400, /ceiling/, false],
    ['AGENT_PIN_SHADOWED', 400, /cannot be pinned/, false],
    ['AGENT_NOT_LAUNCHABLE', 400, /cannot be launched/, false],
    ['AGENT_NOT_FOUND', 404, /not found/i, false],
    ['REPO_HOST_NOT_ALLOWED', 422, /host/i, false],
  ])('explains %s', (code, status, title, retryable) => {
    const v = describeLaunchError(e(status, code));
    expect(v.title).toMatch(title);
    expect(v.retryable).toBe(retryable);
    expect(v.message).toBe('m');
  });

  it('marks RUN_CONFLICT as a possible duplicate, not a failure to retry', () => {
    const v = describeLaunchError(e(409, 'RUN_CONFLICT'));
    expect(v.duplicate).toBe(true);
    expect(v.retryable).toBe(false);
  });

  it('falls back on the status for uncoded errors and on a retry for a plain Error', () => {
    expect(describeLaunchError(e(402, null)).title).toMatch(/budget/i);
    expect(describeLaunchError(e(403, 'FORBIDDEN')).title).toBe('Not allowed');
    expect(describeLaunchError(new Error('Failed to fetch'))).toMatchObject({
      message: 'Failed to fetch',
      retryable: true,
    });
  });
});

describe('isAgentRunTemplate', () => {
  it('matches the reserved template name only', () => {
    expect(isAgentRunTemplate('Agent Run')).toBe(true);
    expect(isAgentRunTemplate('Channel Task')).toBe(false);
    expect(isAgentRunTemplate(null)).toBe(false);
  });
});

describe('parseAgentRunOutcome', () => {
  it('reads the terminate result', () => {
    const o = parseAgentRunOutcome({
      branch: 'auto/agent-1',
      deliver: 'draft_pr',
      diff: 'diff --git a b',
      diffTruncated: true,
      diffVerified: true,
      filesChanged: [{ linesAdded: 2, linesRemoved: 1, operation: 'MODIFY', path: 'a.md' }],
      gate: 'passed',
      headSha: 'abc',
      prNumber: 7,
      prUrl: 'https://github.com/o/r/pull/7',
      stoppedReason: 'max_steps',
      text: 'done',
    });
    expect(o).toMatchObject({
      branch: 'auto/agent-1',
      deliver: 'draft_pr',
      diffTruncated: true,
      diffVerified: true,
      gate: 'passed',
      prNumber: 7,
      stoppedReason: 'max_steps',
    });
    expect(o?.filesChanged).toEqual([
      { linesAdded: 2, linesRemoved: 1, operation: 'MODIFY', path: 'a.md' },
    ]);
  });

  it('treats an absent diffVerified as unverified and tolerates a sparse result', () => {
    const o = parseAgentRunOutcome({ text: 'hi' });
    expect(o).toMatchObject({
      deliver: 'none',
      diff: '',
      diffVerified: false,
      filesChanged: [],
      gate: null,
      prUrl: null,
    });
    expect(parseAgentRunOutcome(null)).toBeNull();
    expect(parseAgentRunOutcome('x')).toBeNull();
  });
});

describe('classifyAgentRunFailure', () => {
  it.each([
    ['Security scan failed with critical findings:\n[CRITICAL] a.ts', 'SECURITY_GATE_FAILURE'],
    ['Security gate could not complete: boom', 'SECURITY_GATE_UNAVAILABLE'],
    ['Push policy refused this change:\n- .env', 'AGENT_RUN_PUSH_POLICY'],
    [
      'The diff is 400000 characters, over the 300000 the security gate can scan.',
      'AGENT_RUN_DIFF_TOO_LARGE',
    ],
    [
      'This repository does not support draft pull requests. The branch x was pushed',
      'DRAFT_PR_UNSUPPORTED',
    ],
    ['AGENT_RUN_CONCURRENCY_EXCEEDED', 'AGENT_RUN_CONCURRENCY_EXCEEDED'],
    ['BUDGET_EXCEEDED: out', 'BUDGET_EXCEEDED'],
  ])('recognises %s', (error, code) => {
    expect(classifyAgentRunFailure(error)?.code).toBe(code);
  });

  it('says nothing about an unrecognised or missing error', () => {
    expect(classifyAgentRunFailure('socket hang up')).toBeNull();
    expect(classifyAgentRunFailure(null)).toBeNull();
  });
});
