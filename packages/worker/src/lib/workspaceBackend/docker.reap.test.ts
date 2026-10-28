import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execShellAsync, spawnCaptureAsync } = vi.hoisted(() => ({
  execShellAsync: vi.fn(),
  spawnCaptureAsync: vi.fn(),
}));
vi.mock('../execUtils.js', () => ({
  execShellAsync,
  spawnCaptureAsync,
  spawnToFileCapped: vi.fn(),
  spawnWithStdinAsync: vi.fn(),
}));

import { dockerWorkspaceBackend, ephemeralArgs } from './docker.js';
import {
  DOCKER_WORKSPACE_CREATED_LABEL,
  DOCKER_WORKSPACE_MARKER_LABEL,
  DOCKER_WORKSPACE_MAX_AGE_MS,
  MAX_REAPED_PER_SWEEP,
} from './orphans.js';

const NOW = new Date('2026-01-10T12:00:00Z');
const created = (ageMs: number) => Math.floor((NOW.getTime() - ageMs) / 1000);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('workspace labels', () => {
  it('labels the workspace container at creation', async () => {
    execShellAsync.mockResolvedValue('7\n');
    await dockerWorkspaceBackend().create({
      cpus: 1,
      dns: [],
      image: 'img:1',
      memory: '1g',
      name: 'workspace-abc',
      pidsLimit: 10,
      reachWorker: false,
    });
    const run = String(execShellAsync.mock.calls[0]?.[0]);
    expect(run).toContain(`--label ${DOCKER_WORKSPACE_MARKER_LABEL}=true`);
    expect(run).toMatch(new RegExp(`--label ${DOCKER_WORKSPACE_CREATED_LABEL}=\\d{10}\\b`));
  });

  it('labels ephemeral step containers and sidecars', () => {
    for (const detached of [false, true]) {
      const args = ephemeralArgs({ image: 'img' }, detached);
      expect(args).toContain(`${DOCKER_WORKSPACE_MARKER_LABEL}=true`);
      expect(args.some((a) => a.startsWith(`${DOCKER_WORKSPACE_CREATED_LABEL}=`))).toBe(true);
      // Flags precede the `--` that ends docker's options.
      expect(args.indexOf(`${DOCKER_WORKSPACE_MARKER_LABEL}=true`)).toBeLessThan(
        args.indexOf('--')
      );
    }
  });
});

describe('reapOrphans', () => {
  const listing = (rows: [string, string, number | string][]) =>
    rows.map(([id, name, at]) => `${id}|${name}|${at}`).join('\n');

  it('lists only marker-labelled containers and removes only the expired ones', async () => {
    spawnCaptureAsync.mockImplementation(async (_bin: string, args: string[]) =>
      args[0] === 'ps'
        ? {
            exitCode: 0,
            stderr: '',
            stdout: listing([
              ['dead1', 'workspace-old', created(DOCKER_WORKSPACE_MAX_AGE_MS + 3_600_000)],
              ['live1', 'workspace-other-worker', created(60_000)],
              ['nolabel', 'workspace-x', ''],
            ]),
          }
        : { exitCode: 0, stderr: '', stdout: '' }
    );
    const result = await dockerWorkspaceBackend().reapOrphans(NOW);

    const ps = spawnCaptureAsync.mock.calls[0]?.[1] as string[];
    expect(ps).toEqual(
      expect.arrayContaining([
        'ps',
        '--all',
        '--filter',
        `label=${DOCKER_WORKSPACE_MARKER_LABEL}=true`,
      ])
    );
    const removals = spawnCaptureAsync.mock.calls
      .filter((c) => (c[1] as string[])[0] === 'rm')
      .map((c) => c[1]);
    expect(removals).toEqual([['rm', '-f', '--', 'dead1']]);
    expect(result).toEqual({ failed: [], removed: ['dead1'], scanned: 3 });
  });

  it('records a failed removal and carries on with the next container', async () => {
    const old = created(DOCKER_WORKSPACE_MAX_AGE_MS + 3_600_000);
    spawnCaptureAsync.mockImplementation(async (_bin: string, args: string[]) => {
      if (args[0] === 'ps') {
        return {
          exitCode: 0,
          stderr: '',
          stdout: listing([
            ['a', 'w-a', old],
            ['b', 'w-b', old],
          ]),
        };
      }
      return args.includes('a')
        ? { exitCode: 1, stderr: 'permission denied', stdout: '' }
        : { exitCode: 0, stderr: '', stdout: '' };
    });
    const result = await dockerWorkspaceBackend().reapOrphans(NOW);
    expect(result.removed).toEqual(['b']);
    expect(result.failed).toEqual([{ error: 'permission denied', id: 'a' }]);
  });

  it('treats a container that is already gone as removed', async () => {
    const old = created(DOCKER_WORKSPACE_MAX_AGE_MS + 3_600_000);
    spawnCaptureAsync.mockImplementation(async (_bin: string, args: string[]) =>
      args[0] === 'ps'
        ? { exitCode: 0, stderr: '', stdout: listing([['a', 'w-a', old]]) }
        : { exitCode: 1, stderr: 'Error: No such container: a', stdout: '' }
    );
    const result = await dockerWorkspaceBackend().reapOrphans(NOW);
    expect(result).toMatchObject({ failed: [], removed: ['a'] });
  });

  it('reports, never throws, when the daemon cannot be listed', async () => {
    spawnCaptureAsync.mockResolvedValue({ exitCode: 1, stderr: 'cannot connect', stdout: '' });
    const result = await dockerWorkspaceBackend().reapOrphans(NOW);
    expect(result).toEqual({
      failed: [{ error: 'cannot connect', id: '(list)' }],
      removed: [],
      scanned: 0,
    });
    spawnCaptureAsync.mockRejectedValue(new Error('spawn docker ENOENT'));
    await expect(dockerWorkspaceBackend().reapOrphans(NOW)).resolves.toMatchObject({
      failed: [{ id: '(list)' }],
    });
  });

  it('removes at most the per-sweep cap, oldest first', async () => {
    const total = MAX_REAPED_PER_SWEEP + 5;
    const base = DOCKER_WORKSPACE_MAX_AGE_MS + 3_600_000;
    // Listed youngest first, so list order is the opposite of age order.
    const rows = Array.from({ length: total }, (_, i): [string, string, number] => [
      `c${i}`,
      `w${i}`,
      created(base + (i + 1) * 1000),
    ]);
    spawnCaptureAsync.mockImplementation(async (_bin: string, args: string[]) =>
      args[0] === 'ps'
        ? { exitCode: 0, stderr: '', stdout: listing(rows) }
        : { exitCode: 0, stderr: '', stdout: '' }
    );
    const result = await dockerWorkspaceBackend().reapOrphans(NOW);
    // c{total-1} is the oldest; the five newest (c0..c4) wait for the next sweep.
    const expected = Array.from({ length: MAX_REAPED_PER_SWEEP }, (_, k) => `c${total - 1 - k}`);
    expect(result.removed).toEqual(expected);
    expect(result.scanned).toBe(total);
  });
});
