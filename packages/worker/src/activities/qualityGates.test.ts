import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    repository: {
      findUniqueOrThrow: vi.fn(),
    },
  },
}));

import { prisma } from '@auto-swe/shared/db';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { __internal } from './qualityGates.js';

const baseRequest: RepoWorkRequest = {
  description: 'test',
  externalTicketId: 'TICK-1',
  repoId: 'repo-1',
  ticketSource: 'JIRA' as never,
  workRequestId: 'wr-1',
} as unknown as RepoWorkRequest;

const mockedFindUnique = vi.mocked(prisma.repository.findUniqueOrThrow);

afterEach(() => {
  mockedFindUnique.mockReset();
});

describe('resolveCommand precedence', () => {
  beforeEach(() => {
    mockedFindUnique.mockResolvedValue({ gateCommands: null } as never);
  });

  it('uses the step config override when present (highest precedence)', async () => {
    mockedFindUnique.mockResolvedValue({
      gateCommands: { runLint: 'repo-level-lint' },
    } as never);
    const cmd = await __internal.resolveCommand('runLint', baseRequest, 'step-level-lint');
    expect(cmd).toBe('step-level-lint');
    // Even though prisma is mocked, the function should not consult it once a
    // step-level override is supplied. The fact that it returned 'step-level'
    // confirms precedence; we don't assert call count to keep the test robust.
  });

  it('falls back to Repository.gateCommands when no step override', async () => {
    mockedFindUnique.mockResolvedValue({
      gateCommands: { runTests: 'pytest -xvs' },
    } as never);
    const cmd = await __internal.resolveCommand('runTests', baseRequest, undefined);
    expect(cmd).toBe('pytest -xvs');
  });

  it('falls back to the built-in default when neither override is set', async () => {
    mockedFindUnique.mockResolvedValue({ gateCommands: null } as never);
    const cmd = await __internal.resolveCommand('runLint', baseRequest, undefined);
    expect(cmd).toBe(__internal.DEFAULT_COMMANDS.runLint);
  });

  it('returns null for gates with no built-in default (runPerfBench)', async () => {
    mockedFindUnique.mockResolvedValue({ gateCommands: null } as never);
    const cmd = await __internal.resolveCommand('runPerfBench', baseRequest, undefined);
    expect(cmd).toBeNull();
  });

  it('treats an empty step-config override as missing and falls back', async () => {
    mockedFindUnique.mockResolvedValue({ gateCommands: null } as never);
    const cmd = await __internal.resolveCommand('runLint', baseRequest, '   ');
    expect(cmd).toBe(__internal.DEFAULT_COMMANDS.runLint);
  });
});

describe('truncate', () => {
  it('returns the input untouched when below the limit', () => {
    expect(__internal.truncate('hi', 10)).toBe('hi');
  });

  it('truncates with a marker when over the limit', () => {
    const big = 'x'.repeat(1000);
    const out = __internal.truncate(big, 200);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain('truncated');
  });
});
