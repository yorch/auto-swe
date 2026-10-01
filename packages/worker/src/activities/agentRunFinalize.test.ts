import fs from 'node:fs/promises';
import { ApplicationFailure } from '@temporalio/activity';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));
vi.mock('../agents/securityReviewProcessor.js', () => ({ scanDiffForSecurityIssues: vi.fn() }));
vi.mock('../lib/codeSecurityScanner.js', () => ({ scanDiffForCodeIssues: vi.fn(async () => []) }));
vi.mock('../lib/sensitiveFileScanner.js', () => ({
  checkSensitiveFilePath: vi.fn(async () => null),
}));

const { shell } = vi.hoisted(() => ({
  shell: { archiveBytes: 100, commands: [] as string[] },
}));
vi.mock('../lib/execUtils.js', () => ({
  execShellAsync: vi.fn(async (cmd: string) => {
    shell.commands.push(cmd);
    // `docker cp <agent>:... - > '<archive>'` leaves an archive of a chosen size.
    const m = cmd.match(/> '([^']+)'$/);
    if (m?.[1]) {
      await fs.writeFile(m[1], Buffer.alloc(shell.archiveBytes));
    }
    return '';
  }),
  throwIfActivityCancelled: vi.fn(),
}));

import { AgentTracer } from '../lib/agentTracer.js';
import {
  commitTrustedTree,
  type GateDeps,
  type GatedCommit,
  gateTrustedCommit,
  importAgentTree,
  pushGatedCommit,
} from './agentRunFinalize.js';
import type { Workspace } from './workspace.js';

const BASE = 'a'.repeat(40);
const SHA = 'b'.repeat(40);
const BLOB = 'c'.repeat(40);

interface FakeOpts {
  /** raw diff output (NUL separated) */
  raw?: string;
  diff?: string;
  binaryShas?: string[];
  sizes?: Record<string, number>;
  head?: string;
  stagedExit?: number;
}

function fakeWorkspace(id: string, opts: FakeOpts = {}) {
  const log: string[] = [];
  const ws = {
    containerId: id,
    destroy: vi.fn(),
    exec: vi.fn(async (cmd: string) => {
      log.push(cmd);
      if (cmd.includes('diff --raw')) {
        return opts.raw ?? `:000000 100644 ${'0'.repeat(40)} ${BLOB} A\0src/a.ts\0`;
      }
      if (cmd.includes('diff --text')) {
        return opts.diff ?? 'diff --git a/src/a.ts b/src/a.ts\nnew file mode 100644\n+hello\n';
      }
      if (cmd.endsWith('rev-parse HEAD')) {
        return `${opts.head ?? BASE}\n`;
      }
      return '';
    }),
    execCapture: vi.fn(async (cmd: string) => {
      log.push(cmd);
      return { exitCode: opts.stagedExit ?? 1, stderr: '', stdout: '' };
    }),
    execStdin: vi.fn(async (cmd: string) => {
      log.push(cmd);
      if (cmd.includes('batch-check')) {
        return `${BLOB} ${opts.sizes?.[BLOB] ?? 10}\n`;
      }
      return `${(opts.binaryShas ?? []).join('\n')}\n`;
    }),
    gitAuthed: vi.fn(async (cmd: string) => {
      log.push(cmd);
      return '';
    }),
  };
  return { log, ws: ws as unknown as Workspace & typeof ws };
}

const passDeps = () => ({
  checkSensitivePath: vi.fn<GateDeps['checkSensitivePath']>(async () => null),
  scanDiffForCodeIssues: vi.fn<GateDeps['scanDiffForCodeIssues']>(async () => []),
  scanDiffForSecurityIssues: vi.fn<GateDeps['scanDiffForSecurityIssues']>(async () => ({
    findings: [],
    passed: true,
  })),
});

const args = () => ({
  allowWorkflowChanges: false,
  baseSha: BASE,
  sha: SHA,
  tracer: new AgentTracer(),
});

async function failureOf(p: Promise<unknown>): Promise<ApplicationFailure> {
  try {
    await p;
  } catch (e) {
    return e as ApplicationFailure;
  }
  throw new Error('expected a failure');
}

beforeEach(() => {
  shell.commands = [];
  shell.archiveBytes = 100;
});

describe('gateTrustedCommit', () => {
  it('reads the change from the trusted container with the hardened diff flags and scans that diff', async () => {
    const { ws, log } = fakeWorkspace('trusted-1');
    const deps = passDeps();
    const gated = await gateTrustedCommit(ws, args(), deps);

    const diffCmd = log.find((c) => c.includes('diff --text')) as string;
    expect(diffCmd).toContain('--text --no-textconv --no-ext-diff');
    expect(diffCmd).toContain('GIT_NO_REPLACE_OBJECTS=1');
    expect(diffCmd).toContain(`${BASE} ${SHA}`);
    expect(deps.scanDiffForSecurityIssues).toHaveBeenCalledWith(expect.stringContaining('+hello'));
    expect(gated.sha).toBe(SHA);
    expect(gated.workspaceId).toBe('trusted-1');
    expect(gated.filesChanged.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('refuses on a policy violation and never reaches the LLM gate', async () => {
    const { ws } = fakeWorkspace('t', {
      raw: `:000000 120000 ${'0'.repeat(40)} ${BLOB} A\0link\0`,
    });
    const deps = passDeps();
    const f = await failureOf(gateTrustedCommit(ws, args(), deps));
    expect(f.type).toBe('AGENT_RUN_PUSH_POLICY');
    expect(f.nonRetryable).toBe(true);
    expect(f.message).toContain('[symlink] link');
    expect(deps.scanDiffForSecurityIssues).not.toHaveBeenCalled();
  });

  it('refuses a sensitive path through the deterministic check, not the model', async () => {
    const { ws } = fakeWorkspace('t', {
      raw: `:000000 100644 ${'0'.repeat(40)} ${BLOB} A\0.env\0`,
    });
    const deps = passDeps();
    deps.checkSensitivePath.mockResolvedValue('blocked by sensitive-file policy');
    const f = await failureOf(gateTrustedCommit(ws, args(), deps));
    expect(f.type).toBe('AGENT_RUN_PUSH_POLICY');
    expect(deps.scanDiffForSecurityIssues).not.toHaveBeenCalled();
  });

  it('refuses a binary file even when its path looks fine', async () => {
    const { ws } = fakeWorkspace('t', { binaryShas: [BLOB] });
    const f = await failureOf(gateTrustedCommit(ws, args(), passDeps()));
    expect(f.type).toBe('AGENT_RUN_PUSH_POLICY');
    expect(f.message).toContain('[binary]');
  });

  it('refuses a change it cannot classify (fails closed)', async () => {
    const { ws } = fakeWorkspace('t', { raw: 'not a raw diff\0x\0' });
    const f = await failureOf(gateTrustedCommit(ws, args(), passDeps()));
    expect(f.type).toBe('AGENT_RUN_PUSH_POLICY');
  });

  it('turns a gate error into SECURITY_GATE_UNAVAILABLE (non-retryable, fail closed)', async () => {
    const { ws } = fakeWorkspace('t');
    const deps = passDeps();
    deps.scanDiffForSecurityIssues.mockRejectedValue(new Error('provider 500'));
    const f = await failureOf(gateTrustedCommit(ws, args(), deps));
    expect(f.type).toBe('SECURITY_GATE_UNAVAILABLE');
    expect(f.nonRetryable).toBe(true);
    expect(f.message).toContain('provider 500');
  });

  it('keeps a budget stop as BUDGET_EXCEEDED instead of relabelling it', async () => {
    const { ws } = fakeWorkspace('t');
    const deps = passDeps();
    deps.scanDiffForSecurityIssues.mockRejectedValue(
      ApplicationFailure.nonRetryable('over', 'BUDGET_EXCEEDED')
    );
    expect((await failureOf(gateTrustedCommit(ws, args(), deps))).type).toBe('BUDGET_EXCEEDED');
  });

  it('turns a critical finding into SECURITY_GATE_FAILURE with the implementer gate text', async () => {
    const { ws } = fakeWorkspace('t');
    const deps = passDeps();
    deps.scanDiffForSecurityIssues.mockResolvedValue({
      findings: [
        {
          category: 'secrets',
          description: 'hardcoded key',
          file: 'src/a.ts',
          line: 3,
          severity: 'CRITICAL',
          suggestedFix: 'remove',
        },
      ],
      passed: false,
    });
    const f = await failureOf(gateTrustedCommit(ws, args(), deps));
    expect(f.type).toBe('SECURITY_GATE_FAILURE');
    expect(f.nonRetryable).toBe(true);
    expect(f.message).toBe(
      'Security scan failed with critical findings:\n[CRITICAL] src/a.ts:3 — secrets: hardcoded key'
    );
  });

  it('refuses a diff too large to scan instead of scanning a truncation', async () => {
    const { ws } = fakeWorkspace('t', { diff: 'x'.repeat(300_001) });
    const deps = passDeps();
    const f = await failureOf(gateTrustedCommit(ws, args(), deps));
    expect(f.type).toBe('AGENT_RUN_DIFF_TOO_LARGE');
    expect(deps.scanDiffForSecurityIssues).not.toHaveBeenCalled();
  });

  it('degrades, rather than aborts, when the advisory code scanner fails', async () => {
    const { ws } = fakeWorkspace('t');
    const deps = passDeps();
    deps.scanDiffForCodeIssues.mockRejectedValue(new Error('patterns'));
    const gated = await gateTrustedCommit(ws, args(), deps);
    expect(gated.codeSecurityFindings).toEqual([]);
  });
});

describe('pushGatedCommit', () => {
  async function gatedIn(ws: Workspace): Promise<GatedCommit> {
    return gateTrustedCommit(ws, args(), passDeps());
  }

  it('pushes the immutable SHA to the branch, from the trusted container only', async () => {
    const { ws, log } = fakeWorkspace('trusted-1');
    const gated = await gatedIn(ws);
    await pushGatedCommit(ws, gated, 'auto/agent-0a1b2c3d');
    expect(ws.gitAuthed).toHaveBeenCalledTimes(1);
    expect(log.at(-1)).toBe(`push origin '${SHA}:refs/heads/auto/agent-0a1b2c3d'`);
  });

  it('refuses a commit gated in a different container', async () => {
    const a = fakeWorkspace('trusted-a');
    const b = fakeWorkspace('trusted-b');
    const gated = await gatedIn(a.ws);
    const f = await failureOf(pushGatedCommit(b.ws, gated, 'auto/x'));
    expect(f.type).toBe('AGENT_RUN_PUSH_POLICY');
    expect(b.ws.gitAuthed).not.toHaveBeenCalled();
  });

  it.each(['-evil', 'a..b', 'a b', "a'b", ''])('refuses the branch name %j', async (branch) => {
    const { ws } = fakeWorkspace('t');
    const gated = await gatedIn(ws);
    await expect(pushGatedCommit(ws, gated, branch)).rejects.toBeInstanceOf(ApplicationFailure);
    expect(ws.gitAuthed).not.toHaveBeenCalled();
  });

  it('cannot be called with an unchecked commit (compile-time guarantee)', async () => {
    const { ws } = fakeWorkspace('t');
    const forged = { sha: SHA, workspaceId: 't' };
    // @ts-expect-error a plain object is not a GatedCommit; only gateTrustedCommit mints one
    await pushGatedCommit(ws, forged, 'auto/x').catch(() => undefined);
  });
});

describe('commitTrustedTree', () => {
  it('reports an empty change without committing', async () => {
    const { ws, log } = fakeWorkspace('t', { stagedExit: 0 });
    expect(await commitTrustedTree(ws, BASE, 'msg')).toEqual({ empty: true });
    expect(log.some((c) => c.includes('commit -q'))).toBe(false);
  });

  it('commits one engine-authored commit with hooks off, on the base', async () => {
    const { ws, log } = fakeWorkspace('t', { stagedExit: 1 });
    ws.exec.mockImplementation(async (cmd: string) => {
      log.push(cmd);
      if (cmd.endsWith('rev-parse HEAD')) {
        return log.some((c) => c.includes('commit -q')) ? `${SHA}\n` : `${BASE}\n`;
      }
      return '';
    });
    expect(await commitTrustedTree(ws, BASE, "auto: it's a run")).toEqual({
      empty: false,
      sha: SHA,
    });
    const commit = log.find((c) => c.includes('commit -q')) as string;
    expect(commit).toContain('core.hooksPath=/dev/null');
    expect(commit).toContain('--no-verify');
    expect(commit).toContain(`'auto: it'\\''s a run'`);
  });

  it('refuses when the trusted checkout is not at the agent’s base commit', async () => {
    const { ws } = fakeWorkspace('t', { head: 'd'.repeat(40) });
    const f = await failureOf(commitTrustedTree(ws, BASE, 'msg'));
    expect(f.type).toBe('AGENT_RUN_BASE_MISMATCH');
  });
});

describe('importAgentTree', () => {
  it('copies the tree with the daemon, and never gives the agent container a credential path', async () => {
    const agent = fakeWorkspace('agent-1');
    const trusted = fakeWorkspace('trusted-1');
    await importAgentTree(agent.ws, trusted.ws);
    expect(shell.commands[0]).toContain("docker cp 'agent-1:/workspace/target-repo/.' -");
    expect(shell.commands[1]).toContain("docker cp - 'trusted-1:/stage'");
    expect(agent.ws.gitAuthed).not.toHaveBeenCalled();
    // The trusted tree is replaced and the copied .git is dropped.
    const replace = trusted.log.find((c) => c.includes('cp -a /stage/. .')) as string;
    expect(replace).toContain('rm -rf /stage/.git');
  });

  it('refuses an archive over the size limit, measured on the host', async () => {
    shell.archiveBytes = 5_000;
    const f = await failureOf(
      importAgentTree(fakeWorkspace('a').ws, fakeWorkspace('t').ws, { maxBytes: 1_000 })
    );
    expect(f.type).toBe('AGENT_RUN_EXPORT_TOO_LARGE');
    // Nothing was imported into the trusted container.
    expect(shell.commands.some((c) => c.startsWith('docker cp - '))).toBe(false);
  });
});
