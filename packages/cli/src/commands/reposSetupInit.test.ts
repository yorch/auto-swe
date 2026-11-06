import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseRepoSetupYaml } from '@auto-swe/shared/lib/repoSetup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReposSetupInit } from './repos.js';

describe('repos setup init', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'setup-init-'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { force: true, recursive: true });
  });

  const written = async () =>
    parseRepoSetupYaml(await readFile(path.join(dir, '.auto-swe/setup.yml'), 'utf8'));

  it('writes the stack default for the files it finds', async () => {
    await writeFile(path.join(dir, 'go.mod'), 'module x\n');
    await writeFile(path.join(dir, 'go.sum'), '');
    expect(await runReposSetupInit([dir])).toBe(0);
    const parsed = await written();
    expect(parsed.ok && parsed.setup.steps?.[0]?.run).toBe('go mod download');
  });

  it('writes a valid placeholder when no stack is recognised', async () => {
    expect(await runReposSetupInit([dir])).toBe(0);
    expect((await written()).ok).toBe(true);
  });

  it('refuses to replace an existing file without --force', async () => {
    expect(await runReposSetupInit([dir])).toBe(0);
    await writeFile(path.join(dir, 'requirements.txt'), 'requests\n');
    expect(await runReposSetupInit([dir])).toBe(1);
    expect(await runReposSetupInit([dir, '--force'])).toBe(0);
    const parsed = await written();
    expect(parsed.ok && parsed.setup.cache?.paths).toEqual(['.venv']);
  });
});
