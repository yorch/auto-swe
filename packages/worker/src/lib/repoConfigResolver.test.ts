import { describe, expect, it, vi } from 'vitest';
import {
  configuredGateCommand,
  resolveRepoGateCommands,
  resolveRepoPreview,
  scmConfigReader,
  workspaceConfigReader,
} from './repoConfigResolver.js';
import type { RepoRef, ScmProvider } from './scm/types.js';

describe('repository configuration resolution', () => {
  it('resolves gate overrides per key and ignores blank/null overrides', () => {
    const connection = { runBuild: ' ', runLint: null, runTests: 'admin tests' };
    const file = { runBuild: 'file build', runLint: 'file lint', runTests: 'file tests' };
    expect(configuredGateCommand('runTests', connection, file)).toEqual({
      command: 'admin tests',
      source: 'configured',
    });
    expect(configuredGateCommand('runLint', connection, file)).toEqual({
      command: 'file lint',
      source: 'repo-file',
    });
    expect(configuredGateCommand('runBuild', connection, file)?.source).toBe('repo-file');
    expect(configuredGateCommand('runVulnScan', connection, file)).toBeNull();
  });
  it('treats missing files as unset', async () => {
    const reader = { read: vi.fn(async () => null) };
    expect(await resolveRepoGateCommands(reader)).toEqual({});
    expect(await resolveRepoPreview(reader, null)).toBeNull();
  });
  it('uses the entire connection preview without reading or merging the file', async () => {
    const reader = {
      read: vi.fn(async () => {
        throw new Error('must not read');
      }),
    };
    expect(
      await resolveRepoPreview(reader, { readyUrl: 'http://localhost:3000/', start: 'admin' })
    ).toMatchObject({ start: 'admin' });
    expect(reader.read).not.toHaveBeenCalled();
  });
  it('uses the repository preview when no connection preview exists', async () => {
    expect(
      await resolveRepoPreview(
        { read: async () => 'start: file\nreadyUrl: http://localhost:3000/' },
        null
      )
    ).toMatchObject({ start: 'file' });
  });
  it('names invalid files in typed failures', async () => {
    await expect(
      resolveRepoPreview({ read: async () => 'invalid: true' }, null)
    ).rejects.toMatchObject({
      message: expect.stringContaining('.auto-swe/preview.yml'),
      nonRetryable: true,
      type: 'REPO_CONFIG_INVALID',
    });
    await expect(
      resolveRepoGateCommands(workspaceConfigReader({ readBaseFile: async () => 'typo: nope' }))
    ).rejects.toMatchObject({
      details: [
        expect.objectContaining({ kind: 'invalid_config', subject: '.auto-swe/gates.yml' }),
      ],
      type: 'WORKSPACE_SETUP_FAILED',
    });
  });
  it('reads SCM files at a resolved base SHA, not the moving branch', async () => {
    const fetchFileContent = vi.fn(async () => null);
    const resolveRef = vi.fn(async () => 'a'.repeat(40));
    const repo = {} as RepoRef;
    const reader = await scmConfigReader(
      { fetchFileContent, resolveRef } as unknown as ScmProvider,
      repo,
      'main'
    );
    await reader.read('.auto-swe/preview.yml');
    expect(resolveRef).toHaveBeenCalledWith(repo, 'main');
    expect(fetchFileContent).toHaveBeenCalledWith(repo, '.auto-swe/preview.yml', 'a'.repeat(40));
  });
  it('refuses an unresolved base rather than fetching a working branch', async () => {
    const fetchFileContent = vi.fn();
    await expect(
      scmConfigReader(
        { fetchFileContent, resolveRef: async () => null } as unknown as ScmProvider,
        {} as RepoRef,
        'main'
      )
    ).rejects.toMatchObject({ type: 'REPO_CONFIG_READ_FAILED' });
    expect(fetchFileContent).not.toHaveBeenCalled();
  });
});
