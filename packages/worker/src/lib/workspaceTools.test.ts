import { ToolInstallError } from '@auto-swe/shared/lib/toolCatalog';
import { ApplicationFailure } from '@temporalio/activity';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectionFindUnique, teamFindUnique, resolveSettingsMock, persistMock } = vi.hoisted(
  () => ({
    connectionFindUnique: vi.fn(),
    persistMock: vi.fn(async () => true),
    resolveSettingsMock: vi.fn(),
    teamFindUnique: vi.fn(async () => null),
  })
);
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: { findUnique: connectionFindUnique },
    team: { findUnique: teamFindUnique },
  },
}));
vi.mock('@auto-swe/shared/config', () => ({ resolveSettings: resolveSettingsMock }));
vi.mock('./activityContext.js', () => ({ persistActivityTrace: persistMock }));

import {
  installLateTools,
  installResolvedTools,
  planWorkspaceTools,
  readToolsFileFromBase,
  recordToolInstallEvent,
  ToolRefusal,
  toToolInstallFailure,
} from './workspaceTools.js';

const settings = (enabled: boolean, maxTools = 8) => {
  resolveSettingsMock.mockResolvedValue({
    'workspace.toolInstall.enabled': enabled,
    'workspace.toolInstall.maxTools': maxTools,
  });
};
const connection = (over: Record<string, unknown> = {}) => {
  connectionFindUnique.mockResolvedValue({
    tools: null,
    toolsDeny: [],
    toolsFileEnabled: false,
    ...over,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  teamFindUnique.mockResolvedValue(null);
});

describe('readToolsFileFromBase', () => {
  it('reads the file from the named ref with git show, never the working tree', async () => {
    const exec = vi.fn(async () => 'present\nversion: 1\n');
    const text = await readToolsFileFromBase({ exec, ref: 'HEAD' });
    expect(text).toBe('version: 1\n');
    const script = (exec.mock.calls[0] as unknown as [string])[0];
    expect(script).toContain("git show 'HEAD:.auto-swe/tools.yml'");
    expect(script).toContain("git cat-file -s 'HEAD:.auto-swe/tools.yml'");
    expect(script).not.toMatch(/\bcat\b\s|<\s*\S*tools\.yml/);
  });

  it('returns null when the file is absent at the ref', async () => {
    await expect(
      readToolsFileFromBase({ exec: async () => 'absent\n', ref: 'HEAD' })
    ).resolves.toBeNull();
  });

  it('refuses a file over the size cap', async () => {
    await expect(
      readToolsFileFromBase({ exec: async () => 'toolarge\n', ref: 'HEAD' })
    ).rejects.toThrow(/larger than 8192 bytes/);
  });

  it('refuses a ref that could be read as an option, and unexpected output', async () => {
    const exec = vi.fn(async () => 'present\n');
    await expect(readToolsFileFromBase({ exec, ref: '--output=x' })).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
    await expect(readToolsFileFromBase({ exec: async () => '', ref: 'HEAD' })).rejects.toThrow(
      /could not be read/
    );
  });

  it('runs prepare before reading', async () => {
    const order: string[] = [];
    await readToolsFileFromBase({
      exec: async () => {
        order.push('read');
        return 'absent\n';
      },
      prepare: async () => {
        order.push('prepare');
      },
      ref: 'FETCH_HEAD',
    });
    expect(order).toEqual(['prepare', 'read']);
  });
});

describe('planWorkspaceTools', () => {
  const readFile = vi.fn(async () => null as string | null);
  beforeEach(() => readFile.mockResolvedValue(null));

  it('requests nothing and reads nothing when the setting is off', async () => {
    settings(false);
    await expect(
      planWorkspaceTools({ connectionId: 'c1', readFile, teamId: 't1' })
    ).resolves.toEqual({ requests: [] });
    expect(connectionFindUnique).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('resolves settings with the team and its organisation', async () => {
    settings(false);
    teamFindUnique.mockResolvedValue({ orgId: 'o1' } as never);
    await planWorkspaceTools({ connectionId: 'c1', readFile, teamId: 't1' });
    expect(resolveSettingsMock).toHaveBeenCalledWith(expect.any(Array), {
      orgId: 'o1',
      teamId: 't1',
    });
  });

  it('returns the admin list when on', async () => {
    settings(true);
    connection({ tools: [{ key: 'just', version: '1.40.0' }] });
    const { requests } = await planWorkspaceTools({ connectionId: 'c1', readFile });
    expect(requests).toEqual([{ key: 'just', version: '1.40.0' }]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('ignores the file unless the connection enables it', async () => {
    settings(true);
    connection({ toolsFileEnabled: false });
    readFile.mockResolvedValue('version: 1\ntools:\n  - key: just\n');
    await expect(planWorkspaceTools({ connectionId: 'c1', readFile })).resolves.toEqual({
      requests: [],
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('merges the file when enabled, and treats a missing file as no entries', async () => {
    settings(true);
    connection({ toolsFileEnabled: true });
    readFile.mockResolvedValue('version: 1\ntools:\n  - key: just\n');
    await expect(planWorkspaceTools({ connectionId: 'c1', readFile })).resolves.toEqual({
      requests: [{ key: 'just' }],
    });
    readFile.mockResolvedValue(null);
    await expect(planWorkspaceTools({ connectionId: 'c1', readFile })).resolves.toEqual({
      requests: [],
    });
  });

  it('fails non-retryably on a malformed file', async () => {
    settings(true);
    connection({ toolsFileEnabled: true });
    readFile.mockResolvedValue('version: 2\n');
    const err = await planWorkspaceTools({ connectionId: 'c1', readFile }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolInstallError);
    expect(err.retryable).toBe(false);
  });

  it('fails non-retryably on an invalid admin list', async () => {
    settings(true);
    connection({ tools: [{ key: 'Bad Key' }] });
    const err = await planWorkspaceTools({ connectionId: 'c1', readFile }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolInstallError);
    expect(err.message).toMatch(/tool list is invalid/);
  });

  it('lets the deny list win over the admin list and the file', async () => {
    settings(true);
    connection({
      tools: [{ key: 'just' }, { key: 'jq' }],
      toolsDeny: ['just', 'yq'],
      toolsFileEnabled: true,
    });
    readFile.mockResolvedValue('version: 1\ntools:\n  - key: yq\n  - key: jq\n');
    const { requests } = await planWorkspaceTools({ connectionId: 'c1', readFile });
    expect(requests).toEqual([{ key: 'jq' }]);
  });

  it('fails when more than maxTools are requested', async () => {
    settings(true, 1);
    connection({ tools: [{ key: 'just' }, { key: 'jq' }] });
    await expect(planWorkspaceTools({ connectionId: 'c1', readFile })).rejects.toThrow(/at most 1/);
  });

  it('fails when the connection does not exist', async () => {
    settings(true);
    connectionFindUnique.mockResolvedValue(null);
    await expect(planWorkspaceTools({ connectionId: 'c1', readFile })).rejects.toThrow(/not found/);
  });
});

describe('installResolvedTools', () => {
  const entry = {
    archs: { amd64: { sha256: 'a'.repeat(64), url: 'https://example.test/j.tar.gz' } },
    key: 'just',
    libc: 'any' as const,
    member: 'just',
    status: 'ACTIVE' as const,
    version: '1.40.0',
  };

  it('installs through the given exec with the 300 s timeout and reports versions and warnings', async () => {
    const exec = vi.fn(async () => '');
    const result = await installResolvedTools(exec, [
      { entry },
      { entry: { ...entry, key: 'old', status: 'DEPRECATED' }, warning: 'old is deprecated' },
    ]);
    expect(exec).toHaveBeenCalledTimes(1);
    const [script, timeout] = exec.mock.calls[0] as unknown as [string, number];
    expect(script).toContain('auto-swe tool install');
    expect(timeout).toBe(300_000);
    expect(result.installed).toEqual([
      { key: 'just', version: '1.40.0' },
      { key: 'old', version: '1.40.0', warning: 'old is deprecated' },
    ]);
  });

  it('runs nothing for an empty list', async () => {
    const exec = vi.fn(async () => '');
    await expect(installResolvedTools(exec, [])).resolves.toEqual({ durationMs: 0, installed: [] });
    expect(exec).not.toHaveBeenCalled();
  });

  it('marks the network exit code retryable and names the tool', async () => {
    const exec = async () => {
      throw Object.assign(new Error('Command failed'), {
        code: 75,
        stderr: 'auto-swe tool install: just@1.40.0: download failed from https://x\n',
      });
    };
    const err = await installResolvedTools(exec, [{ entry }]).catch((e) => e);
    expect(err).toBeInstanceOf(ToolInstallError);
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('just@1.40.0: download failed from https://x');
  });

  it('marks every other failure non-retryable', async () => {
    const exec = async () => {
      throw Object.assign(new Error('Command failed'), {
        code: 1,
        stderr: 'auto-swe tool install: just@1.40.0: checksum mismatch\n',
      });
    };
    const err = await installResolvedTools(exec, [{ entry }]).catch((e) => e);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('checksum mismatch');
  });
});

describe('installResolvedTools: the outer timeout', () => {
  const entry = {
    archs: { amd64: { sha256: 'a'.repeat(64), url: 'https://example.test/j.tar.gz' } },
    key: 'just',
    libc: 'any' as const,
    member: 'just',
    status: 'ACTIVE' as const,
    version: '1.40.0',
  };

  it.each([
    [
      'a killed child (code null, killed)',
      Object.assign(new Error('Command failed'), { code: null, killed: true }),
    ],
    ['a signalled child', Object.assign(new Error('Command failed'), { signal: 'SIGTERM' })],
    [
      'exit 124 (the timeout convention)',
      Object.assign(new Error('Command failed'), { code: 124 }),
    ],
    ['a timeout message', new Error('exec timed out after 300000ms')],
  ])('is a retryable failure for %s', async (_name, error) => {
    const err = await installResolvedTools(async () => {
      throw error;
    }, [{ entry }]).catch((e) => e);
    expect(err).toBeInstanceOf(ToolInstallError);
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('the install did not finish within 300 seconds');
  });

  it('keeps a plain non-zero exit non-retryable', async () => {
    const err = await installResolvedTools(async () => {
      throw Object.assign(new Error('Command failed'), { code: 1, stderr: '' });
    }, [{ entry }]).catch((e) => e);
    expect(err.retryable).toBe(false);
  });
});

describe('installLateTools', () => {
  const row = (key: string, status: 'ACTIVE' | 'DEPRECATED' = 'ACTIVE') => ({
    archs: { amd64: { sha256: 'a'.repeat(64), url: `https://example.test/${key}.tar.gz` } },
    key,
    libc: 'any' as const,
    member: key,
    status,
    version: '1.0.0',
  });
  const base = (over: Partial<Parameters<typeof installLateTools>[0]> = {}) => ({
    catalog: [row('just'), row('old', 'DEPRECATED')],
    connectionId: 'c1',
    exec: vi.fn(async () => ''),
    installed: [],
    requests: [{ key: 'just' }],
    ...over,
  });

  beforeEach(() => {
    settings(true);
    connection();
  });

  it.each(['blocked', 'restricted'] as const)(
    'refuses under the %s egress policy',
    async (policy) => {
      const opts = base({ egressPolicy: policy });
      const err = await installLateTools(opts).catch((e) => e);
      expect(err).toBeInstanceOf(ToolRefusal);
      expect(err.message).toBe(
        `tool installs after workspace start are unavailable under the ${policy} egress policy`
      );
      expect(err.retryable).toBe(false);
      expect(opts.exec).not.toHaveBeenCalled();
    }
  );

  it('installs under open, or when no policy is given', async () => {
    for (const egressPolicy of ['open', undefined] as const) {
      const opts = base({ ...(egressPolicy ? { egressPolicy } : {}) });
      const out = await installLateTools(opts);
      expect(out.fresh).toEqual([{ key: 'just', version: '1.0.0' }]);
      expect(opts.exec).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses once max(3, maxTools) installs have failed, and not before', async () => {
    settings(true, 1);
    const ok = base({ failedAttempts: 2 });
    await expect(installLateTools(ok)).resolves.toBeDefined();
    const capped = base({ failedAttempts: 3 });
    const err = await installLateTools(capped).catch((e) => e);
    expect(err).toBeInstanceOf(ToolRefusal);
    expect(err.message).toBe('too many failed install attempts in this workspace');
    expect(capped.exec).not.toHaveBeenCalled();

    settings(true, 8);
    await expect(installLateTools(base({ failedAttempts: 7 }))).resolves.toBeDefined();
    await expect(installLateTools(base({ failedAttempts: 8 }))).rejects.toThrow(/too many failed/);
  });

  it('refuses an agent pinning a deprecated row, but not an unpinned request for an active one', async () => {
    const opts = base({ requests: [{ key: 'old', version: '1.0.0' }] });
    const err = await installLateTools(opts).catch((e) => e);
    expect(err).toBeInstanceOf(ToolRefusal);
    expect(err.message).toBe("tool 'old@1.0.0' is deprecated and cannot be installed on request");
    expect(opts.exec).not.toHaveBeenCalled();
    await expect(installLateTools(base())).resolves.toBeDefined();
  });
});

describe('toToolInstallFailure', () => {
  it('maps a retryable error to a plain Error and the rest to a non-retryable failure', () => {
    const retryable = toToolInstallFailure(new ToolInstallError('net', { retryable: true }));
    expect(retryable).not.toBeInstanceOf(ApplicationFailure);
    expect((retryable as Error).message).toBe('net');
    const fatal = toToolInstallFailure(new ToolInstallError('bad'));
    expect(fatal).toBeInstanceOf(ApplicationFailure);
    expect((fatal as ApplicationFailure).nonRetryable).toBe(true);
    expect((fatal as ApplicationFailure).type).toBe('TOOL_INSTALL_FAILED');
  });

  it('passes any other error through', () => {
    const other = new Error('db');
    expect(toToolInstallFailure(other)).toBe(other);
  });
});

describe('recordToolInstallEvent', () => {
  it('persists one tools_installed event', async () => {
    await recordToolInstallEvent({
      durationMs: 5,
      installed: [{ key: 'just', version: '1.40.0', warning: 'w' }],
    });
    expect(persistMock).toHaveBeenCalledTimes(1);
    const tracer = (persistMock.mock.calls[0] as unknown as [{ records: unknown[] }])[0];
    expect(JSON.stringify(tracer)).toContain('workspace.tools_installed');
  });

  it('never throws when the write fails', async () => {
    persistMock.mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      recordToolInstallEvent({ durationMs: 0, error: 'boom', installed: [] })
    ).resolves.toBeUndefined();
  });
});
