import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: { connection: { findUnique: vi.fn() } },
}));
vi.mock('@auto-swe/shared/workflow', () => ({ assertShellImageAllowed: vi.fn() }));
vi.mock('../lib/ephemeralContainer.js', () => ({ runEphemeralContainer: vi.fn() }));
vi.mock('../lib/execUtils.js', () => ({ execShellAsync: vi.fn().mockResolvedValue({}) }));

import { prisma } from '@auto-swe/shared/db';
import { assertShellImageAllowed } from '@auto-swe/shared/workflow';
import { runEphemeralContainer } from '../lib/ephemeralContainer.js';
import { runContainerStep } from './containerStep.js';

const findUnique = vi.mocked(prisma.connection.findUnique);
const mockedRun = vi.mocked(runEphemeralContainer);
const mockedAssert = vi.mocked(assertShellImageAllowed);

const REQUEST = { repoId: 'r1' } as unknown as RepoWorkRequest;
const base = { image: 'node:24-alpine', request: REQUEST };

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({
    team: { egressAllowlist: [], shellImageAllowlist: ['node:24-alpine'] },
  } as never);
});

describe('runContainerStep', () => {
  it('runs the image with JSON input env and parses stdout JSON as the result', async () => {
    mockedRun.mockResolvedValue({ exitCode: 0, stderr: '', stdout: '{"ok":1}' } as never);
    const res = await runContainerStep({ ...base, command: 'node run.js', inputs: { q: 'x' } });
    expect(res).toEqual({ result: { ok: 1 } });
    expect(mockedAssert).toHaveBeenCalledWith('node:24-alpine', ['node:24-alpine']);
    expect(mockedRun).toHaveBeenCalledWith(
      expect.objectContaining({ env: { CONTAINER_STEP_INPUT: JSON.stringify({ q: 'x' }) } })
    );
  });

  it('throws when no command is provided', async () => {
    await expect(runContainerStep(base)).rejects.toThrow(/requires a command/);
  });

  it('throws when the image is not allowed (propagates the allowlist error)', async () => {
    mockedAssert.mockImplementationOnce(() => {
      throw new Error('image not allowed');
    });
    await expect(runContainerStep({ ...base, command: 'x' })).rejects.toThrow(/not allowed/);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('throws on a non-zero exit', async () => {
    mockedRun.mockResolvedValue({ exitCode: 1, stderr: 'boom', stdout: '' } as never);
    await expect(runContainerStep({ ...base, command: 'x' })).rejects.toThrow(/exited 1/);
  });

  it('throws when stdout is not valid JSON', async () => {
    mockedRun.mockResolvedValue({ exitCode: 0, stderr: '', stdout: 'not json' } as never);
    await expect(runContainerStep({ ...base, command: 'x' })).rejects.toThrow(/valid JSON/);
  });
});
