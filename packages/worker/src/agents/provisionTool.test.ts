import { ToolInstallError } from '@auto-swe/shared/lib/toolCatalog';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../activities/workspace.js';

const { connectionFindUnique, loadCatalogMock, persistMock, resolveSettingsMock } = vi.hoisted(
  () => ({
    connectionFindUnique: vi.fn(),
    loadCatalogMock: vi.fn(),
    persistMock: vi.fn(async () => true),
    resolveSettingsMock: vi.fn(),
  })
);
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: { findUnique: connectionFindUnique },
    team: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock('@auto-swe/shared/config', () => ({ resolveSettings: resolveSettingsMock }));
vi.mock('../lib/activityContext.js', () => ({ persistActivityTrace: persistMock }));
vi.mock('../lib/toolCatalogLoader.js', () => ({ loadToolCatalog: loadCatalogMock }));

import { type InstalledTool, installLateTools } from '../lib/workspaceTools.js';
import { createProvisionTool, grantsProvisionTool } from './provisionTool.js';

const sha256 = 'a'.repeat(64);
const entry = (key: string, version: string, status: 'ACTIVE' | 'DEPRECATED' | 'REVOKED') => ({
  archs: {
    amd64: { sha256, url: `https://secret.example.test/${key}.tar.gz` },
    arm64: { sha256, url: `https://secret.example.test/${key}.tar.gz` },
  },
  key,
  libc: 'any' as const,
  member: key,
  status,
  version,
});
const CATALOG = [
  entry('just', '1.40.0', 'ACTIVE'),
  entry('jq', '1.7.1', 'ACTIVE'),
  entry('yq', '4.0.0', 'ACTIVE'),
  entry('old', '1.0.0', 'DEPRECATED'),
  entry('bad', '1.0.0', 'REVOKED'),
];

const settings = (over: Record<string, unknown> = {}) =>
  resolveSettingsMock.mockResolvedValue({
    'workspace.toolInstall.agentCallable': true,
    'workspace.toolInstall.enabled': true,
    'workspace.toolInstall.maxTools': 8,
    ...over,
  });

interface Fake {
  workspace: Workspace;
  installed: InstalledTool[];
  exec: ReturnType<typeof vi.fn>;
}

/** A workspace whose `installTools` is the real policy over a fake exec. */
function fakeWorkspace(options: { withInstall?: boolean; execFails?: Error } = {}): Fake {
  const installed: InstalledTool[] = [];
  const exec = vi.fn(async (_command: string) => {
    if (options.execFails) {
      throw options.execFails;
    }
    return '';
  });
  const workspace = {
    ...(options.withInstall === false
      ? {}
      : {
          installTools: async (requests: { key: string; version?: string }[]) => {
            const outcome = await installLateTools({
              connectionId: 'c1',
              exec,
              installed,
              requests,
              teamId: null,
            });
            installed.push(...outcome.fresh);
            return outcome.results;
          },
        }),
  } as unknown as Workspace;
  return { exec, installed, workspace };
}

type Result = {
  ok: boolean;
  installed?: { key: string; version: string; warning?: string };
  error?: string;
};
const call = async (
  fake: Fake,
  input: { key: string; version?: string },
  toolKeys: string[] | null = ['provisionTool']
): Promise<Result> => {
  const tool = createProvisionTool({ toolKeys, workspace: fake.workspace });
  const execute = (tool as unknown as { execute: (i: unknown, c: unknown) => Promise<Result> })
    .execute;
  return execute(input, {});
};

beforeEach(() => {
  vi.clearAllMocks();
  settings();
  connectionFindUnique.mockResolvedValue({ toolsDeny: [] });
  loadCatalogMock.mockResolvedValue(CATALOG);
});

describe('grantsProvisionTool', () => {
  it('is granted only by name, never by null or an unrelated list', () => {
    expect(grantsProvisionTool(null)).toBe(false);
    expect(grantsProvisionTool([])).toBe(false);
    expect(grantsProvisionTool(['bash', 'browser'])).toBe(false);
    expect(grantsProvisionTool(['provisionTool'])).toBe(true);
  });
});

describe('provisionTool gates', () => {
  it('refuses when the agent does not name provisionTool, including a null grant', async () => {
    for (const keys of [null, ['bash']]) {
      const fake = fakeWorkspace();
      const r = await call(fake, { key: 'just' }, keys);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/'just'.*not allowed/);
      expect(fake.exec).not.toHaveBeenCalled();
    }
  });

  it('refuses when installation is off, or not callable by agents', async () => {
    for (const over of [
      { 'workspace.toolInstall.enabled': false },
      { 'workspace.toolInstall.agentCallable': false },
    ]) {
      settings(over);
      const fake = fakeWorkspace();
      const r = await call(fake, { key: 'just' });
      expect(r).toEqual({
        error: "Could not install 'just': installing tools is not enabled for this workspace.",
        ok: false,
      });
      expect(fake.exec).not.toHaveBeenCalled();
    }
  });

  it('refuses a workspace created without toolsFor (no installTools)', async () => {
    const fake = fakeWorkspace({ withInstall: false });
    const r = await call(fake, { key: 'just' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not tied to a repository connection/);
  });

  it('resolves the switches at the caller scope', async () => {
    const fake = fakeWorkspace();
    const tool = createProvisionTool({
      ctx: { orgId: 'o1', teamId: 't1' },
      toolKeys: ['provisionTool'],
      workspace: fake.workspace,
    });
    await (tool as unknown as { execute: (i: unknown, c: unknown) => Promise<unknown> }).execute(
      { key: 'just' },
      {}
    );
    expect(resolveSettingsMock).toHaveBeenCalledWith(
      ['workspace.toolInstall.enabled', 'workspace.toolInstall.agentCallable'],
      { orgId: 'o1', teamId: 't1' }
    );
  });

  it('refuses a key on the connection deny list without running anything', async () => {
    connectionFindUnique.mockResolvedValue({ toolsDeny: ['just'] });
    const fake = fakeWorkspace();
    const r = await call(fake, { key: 'just' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/denied for this repository/);
    expect(fake.exec).not.toHaveBeenCalled();
  });

  it('refuses beyond workspace.toolInstall.maxTools, counting what is installed', async () => {
    settings({ 'workspace.toolInstall.maxTools': 2 });
    const fake = fakeWorkspace();
    expect((await call(fake, { key: 'just' })).ok).toBe(true);
    expect((await call(fake, { key: 'jq' })).ok).toBe(true);
    const r = await call(fake, { key: 'yq' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/limit of 2 tools/);
    expect(fake.installed.map((t) => t.key)).toEqual(['just', 'jq']);
  });

  it('refuses a revoked tool, an unknown tool and an unknown version', async () => {
    const fake = fakeWorkspace();
    expect((await call(fake, { key: 'bad', version: '1.0.0' })).error).toMatch(/revoked/);
    expect((await call(fake, { key: 'nope' })).error).toMatch(/not in the tool catalog/);
    expect((await call(fake, { key: 'just', version: '9.9.9' })).error).toMatch(
      /not in the tool catalog/
    );
    expect(fake.exec).not.toHaveBeenCalled();
  });

  it('fails closed on an unreadable catalog and says a retry may help', async () => {
    loadCatalogMock.mockRejectedValue(
      new ToolInstallError('tool catalog is unreadable: password=hunter2', { retryable: true })
    );
    const fake = fakeWorkspace();
    const r = await call(fake, { key: 'just' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not be read/);
    expect(r.error).toMatch(/calling provisionTool again/);
    expect(r.error).not.toContain('hunter2');
    expect(fake.exec).not.toHaveBeenCalled();
  });
});

describe('provisionTool installs', () => {
  it('installs the latest active version and reports it', async () => {
    const fake = fakeWorkspace();
    const r = await call(fake, { key: 'just' });
    expect(r).toEqual({ installed: { key: 'just', version: '1.40.0' }, ok: true });
    expect(fake.exec).toHaveBeenCalledTimes(1);
    expect(String(fake.exec.mock.calls[0]?.[0])).toContain('auto-swe tool install');
  });

  it('refuses to pin a deprecated row, naming it and running nothing', async () => {
    const fake = fakeWorkspace();
    const r = await call(fake, { key: 'old', version: '1.0.0' });
    expect(r).toEqual({
      error:
        "Could not install 'old': tool 'old@1.0.0' is deprecated and cannot be installed on request.",
      ok: false,
    });
    expect(fake.exec).not.toHaveBeenCalled();
  });

  it('reports a timed-out install as retryable', async () => {
    const fake = fakeWorkspace({
      execFails: Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }),
    });
    const r = await call(fake, { key: 'just' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/may be retried by calling provisionTool again/);
  });

  it('is a no-op success for a key already installed, and refuses a different version', async () => {
    const fake = fakeWorkspace();
    await call(fake, { key: 'just' });
    fake.exec.mockClear();
    expect(await call(fake, { key: 'just' })).toEqual({
      installed: { key: 'just', version: '1.40.0' },
      ok: true,
    });
    expect(await call(fake, { key: 'just', version: '1.40.0' })).toMatchObject({ ok: true });
    expect(fake.exec).not.toHaveBeenCalled();
    const conflict = await call(fake, { key: 'just', version: '1.39.0' });
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toMatch(/already installed at version 1\.40\.0/);
    expect(fake.exec).not.toHaveBeenCalled();
  });

  it('turns an install failure into a structured result without stderr or the URL', async () => {
    const err = Object.assign(new Error('boom'), {
      exitCode: 1,
      stderr:
        'auto-swe tool install: just@1.40.0: download failed from https://secret.example.test/just.tar.gz',
    });
    const fake = fakeWorkspace({ execFails: err });
    const r = await call(fake, { key: 'just' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(
      "Could not install 'just': the installation failed and retrying will not help."
    );
    expect(JSON.stringify(r)).not.toContain('secret.example.test');
    expect(fake.installed).toEqual([]);
  });

  it('says a transient failure may be retried', async () => {
    const err = Object.assign(new Error('boom'), {
      exitCode: 75,
      stderr: 'auto-swe tool install: just: download failed from https://secret.example.test/x',
    });
    const fake = fakeWorkspace({ execFails: err });
    const r = await call(fake, { key: 'just' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/may be retried by calling provisionTool again/);
    expect(JSON.stringify(r)).not.toContain('secret.example.test');
  });

  it('never throws, even when settings cannot be resolved', async () => {
    resolveSettingsMock.mockRejectedValue(new Error('db password=hunter2'));
    const fake = fakeWorkspace();
    const r = await call(fake, { key: 'just' });
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain('hunter2');
  });
});
