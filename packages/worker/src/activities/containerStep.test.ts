import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: { connection: { findUnique: vi.fn() } },
}));
vi.mock('@auto-swe/shared/workflow', () => ({ assertShellImageAllowed: vi.fn() }));
vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));
vi.mock('../lib/ephemeralContainer.js', () => ({
  runEphemeralContainer: vi.fn(),
  runSidecarContainer: vi.fn(),
}));
vi.mock('../lib/execUtils.js', () => ({ execShellAsync: vi.fn().mockResolvedValue({}) }));

import { prisma } from '@auto-swe/shared/db';
import { assertShellImageAllowed } from '@auto-swe/shared/workflow';
import { runEphemeralContainer, runSidecarContainer } from '../lib/ephemeralContainer.js';
import { runContainerStep } from './containerStep.js';

const findUnique = vi.mocked(prisma.connection.findUnique);
const mockedRun = vi.mocked(runEphemeralContainer);
const mockedSidecar = vi.mocked(runSidecarContainer);
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

  describe('ndjson transport', () => {
    // Drive the streaming callback with the given lines, then resolve cleanly.
    function streamLines(lines: string[]) {
      mockedRun.mockImplementation(async (inp: { onStdoutLine?: (l: string) => void }) => {
        for (const l of lines) {
          inp.onStdoutLine?.(l);
        }
        return { exitCode: 0, stderr: '', stdout: lines.join('\n') } as never;
      });
    }

    it('collects streamed events and returns the last result event', async () => {
      streamLines([
        '{"type":"log","msg":"starting"}',
        '{"type":"progress","pct":50}',
        '{"type":"result","result":{"ok":true}}',
      ]);
      const res = await runContainerStep({ ...base, command: 'x', transport: 'ndjson' });
      expect(res.result).toEqual({ ok: true });
      expect(res.events).toHaveLength(3);
    });

    it('falls back to the last bare JSON line when no result event is present', async () => {
      streamLines(['{"type":"log","msg":"hi"}', '{"value":42}']);
      const res = await runContainerStep({ ...base, command: 'x', transport: 'ndjson' });
      expect(res.result).toEqual({ value: 42 });
    });

    it('keeps non-JSON lines as log events without failing', async () => {
      streamLines(['plain text progress', '{"type":"result","result":7}']);
      const res = await runContainerStep({ ...base, command: 'x', transport: 'ndjson' });
      expect(res.result).toBe(7);
      expect(res.events?.[0]).toEqual({ log: 'plain text progress', type: 'log' });
    });
  });

  describe('sidecar transport', () => {
    it('POSTs inputs to the sidecar and binds the JSON response as the result', async () => {
      mockedSidecar.mockResolvedValue({ result: { ok: true }, status: 200 } as never);
      const res = await runContainerStep({
        ...base,
        inputs: { q: 'x' },
        sidecar: { port: 8080, requestPath: '/run' },
        transport: 'sidecar',
      });
      expect(res.result).toEqual({ ok: true });
      expect(mockedSidecar).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { q: 'x' },
          network: 'egress',
          port: 8080,
          requestPath: '/run',
        })
      );
      // No command is required for a sidecar.
      expect(mockedRun).not.toHaveBeenCalled();
    });

    it('throws when transport is sidecar but no sidecar config is given', async () => {
      await expect(runContainerStep({ ...base, transport: 'sidecar' })).rejects.toThrow(
        /requires a sidecar config/
      );
    });
  });
});
