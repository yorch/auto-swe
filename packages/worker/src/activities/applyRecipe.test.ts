import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));

const { pinRecipeBase } = vi.hoisted(() => ({ pinRecipeBase: vi.fn() }));
vi.mock('./recipeBase.js', () => ({ pinRecipeBase }));

const { runShellStep, provision, persistTrace, workspace } = vi.hoisted(() => {
  const workspace = {
    destroy: vi.fn(async () => {}),
    exec: vi.fn(async (_cmd: string) => ''),
    gitAuthed: vi.fn(async () => ''),
  };
  return {
    persistTrace: vi.fn(async (_tracer?: unknown, _key?: string) => true),
    provision: vi.fn(),
    runShellStep: vi.fn(),
    workspace,
  };
});
vi.mock('./shellStep.js', () => ({ runShellStep }));
vi.mock('./qualityGates.js', () => ({ provisionGateWorkspace: provision }));
vi.mock('../lib/activityContext.js', () => ({ persistActivityTrace: persistTrace }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn(async () => ({ branchPrefix: 'auto' })),
}));

import { CancelledFailure } from '@temporalio/activity';
import { applyRecipe } from './applyRecipe.js';
import { withEndMarker } from './pinnedGitTestSupport.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const request = {
  description: 'raise lodash',
  externalTicketId: 'CAMPAIGN-abc123',
  repoId: 'repo-1',
} as never;
const NPM = { packageName: 'lodash', targetVersion: '4.17.21' };

function shellResult(over: Record<string, unknown> = {}) {
  return {
    artifactId: 'art-1',
    committedSha: HEAD,
    exitCode: 0,
    filesChanged: ['package.json', 'package-lock.json'],
    passed: true,
    persisted: true,
    summary: 'shell step passed (exit 0; 2 files changed)',
    ...over,
  };
}

/**
 * The workspace answers the reads that describe the pushed commit: the tip, its first parent (the
 * commit the shell step cut the branch from), and the pinned diff reads, which echo their end
 * marker like a shell.
 */
function revParse(cmd: string): string | undefined {
  if (cmd.includes(`'${HEAD}^1'`)) {
    return `${BASE}\n`;
  }
  if (cmd.includes("'HEAD^{commit}'")) {
    return `${HEAD}\n`;
  }
  return undefined;
}
function describeWorkspace() {
  workspace.exec.mockImplementation(async (cmd: string) => {
    const sha = revParse(cmd);
    if (sha) {
      return sha;
    }
    if (cmd.includes('--name-status')) {
      return withEndMarker(cmd, 'M\0package.json\0M\0package-lock.json\0');
    }
    if (cmd.includes('--numstat')) {
      return withEndMarker(cmd, '1\t1\tpackage.json\n10\t8\tpackage-lock.json\n');
    }
    if (cmd.includes(' -p ')) {
      return withEndMarker(cmd, 'diff --git a/package.json b/package.json\n-1\n+2\n');
    }
    return withEndMarker(cmd, '');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  runShellStep.mockResolvedValue(shellResult());
  pinRecipeBase.mockResolvedValue({ baseBranch: 'main', baseSha: BASE, ok: true });
  provision.mockResolvedValue({ baseBranch: 'main', branch: 'auto/CAMPAIGN-abc123', workspace });
  describeWorkspace();
});

describe('applyRecipe', () => {
  it('with no recipe it is skipped, runs nothing and provisions nothing', async () => {
    for (const recipe of [undefined, '']) {
      const result = await applyRecipe({ recipe, request });
      expect(result).toMatchObject({ filesChanged: [], passed: false, skipped: true });
    }
    expect(runShellStep).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it('re-validates the parameters: invalid ones run nothing and are not a pass', async () => {
    for (const params of [
      { packageName: '$(touch pwned)', targetVersion: '1.0.0' },
      { packageName: 'lodash', targetVersion: '^4.0.0' },
      { packageName: 'lodash' },
      undefined,
      'lodash@4.17.21',
    ]) {
      const result = await applyRecipe({ params, recipe: 'npm-dependency@1', request });
      expect(result).toMatchObject({ filesChanged: [], passed: false, skipped: false });
      expect(result.summary).toMatch(/invalid parameters/);
      expect(result.summary).not.toContain('touch pwned');
    }
    const unknown = await applyRecipe({ params: NPM, recipe: 'curl-sh@1', request });
    expect(unknown).toMatchObject({ passed: false, skipped: false });
    expect(runShellStep).not.toHaveBeenCalled();
  });

  it('runs the recipe on its image, with egress, on the work branch, with the recipe’s bound', async () => {
    await applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request });
    expect(runShellStep).toHaveBeenCalledTimes(1);
    const input = runShellStep.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).toMatchObject({
      branch: 'auto/CAMPAIGN-abc123',
      image: 'node:24-alpine',
      network: 'egress',
      request,
      timeoutMs: 600_000,
    });
    expect(String(input.command)).toContain("export PKG='lodash' VER='4.17.21'");
    expect(String(input.command)).toContain('--ignore-scripts');
  });

  it('runs a Go recipe on the Go image', async () => {
    await applyRecipe({
      params: { packageName: 'github.com/a/b', targetVersion: 'v1.2.3' },
      recipe: 'go-module@1',
      request,
    });
    expect(runShellStep.mock.calls[0]?.[0]).toMatchObject({ image: 'golang:1.26-alpine' });
  });

  it('after a passing run with changes returns a code result for the gates and the pull request', async () => {
    const result = await applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request });
    expect(result).toMatchObject({
      artifactId: 'art-1',
      exitCode: 0,
      filesChanged: ['package.json', 'package-lock.json'],
      passed: true,
      skipped: false,
    });
    expect(result.codeResult).toMatchObject({
      baseBranch: 'main',
      baseSha: BASE,
      branch: 'auto/CAMPAIGN-abc123',
      headSha: HEAD,
      repoId: 'repo-1',
    });
    expect(result.codeResult?.filesChanged).toEqual([
      {
        language: 'json',
        linesAdded: 1,
        linesRemoved: 1,
        operation: 'MODIFY',
        path: 'package.json',
      },
      {
        language: 'json',
        linesAdded: 10,
        linesRemoved: 8,
        operation: 'MODIFY',
        path: 'package-lock.json',
      },
    ]);
    expect(result.codeResult?.diff).toContain('diff --git a/package.json');
    expect(result.codeResult?.implementationNotes).toContain('lodash');
    expect(result.codeResult?.implementationNotes).toContain('4.17.21');
  });

  it('says the tests were not run here, so the pull request text cannot claim they passed', async () => {
    const result = await applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request });
    const tests = result.codeResult?.testResults;
    expect(tests?.passed).toBe(false);
    expect(tests?.failing).toBe(0);
    expect(tests?.total).toBe(0);
    expect(tests?.stdout).toMatch(/protected test gate/);
  });

  it('describes the change in a workspace that runs no repository setup, and destroys it', async () => {
    await applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request });
    expect(provision).toHaveBeenCalledWith(request, 'runTests', 'auto/CAMPAIGN-abc123', {
      skipSetup: true,
    });
    expect(workspace.destroy).toHaveBeenCalledTimes(1);
  });

  it('leaves lockfiles out of the reported patch but keeps them in the file list', async () => {
    await applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request });
    const patch = workspace.exec.mock.calls.map((c) => c[0]).find((c) => c.includes(' -p '));
    expect(patch).toContain('exclude,glob)**/package-lock.json');
  });

  it('caps a very long patch', async () => {
    workspace.exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes(' -p ')) {
        return withEndMarker(cmd, 'x'.repeat(500_000));
      }
      return revParse(cmd) ?? withEndMarker(cmd, '');
    });
    const result = await applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request });
    expect(result.codeResult?.diff.length).toBeLessThan(200_100);
  });

  it('passes with no files changed when the repository is not affected: no code result, nothing provisioned', async () => {
    runShellStep.mockResolvedValue(shellResult({ filesChanged: [], summary: 'passed (0 files)' }));
    const result = await applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request });
    expect(result).toMatchObject({ filesChanged: [], passed: true, skipped: false });
    expect(result.codeResult).toBeUndefined();
    expect(provision).not.toHaveBeenCalled();
  });

  it('a non-zero exit is not a pass and carries no code result', async () => {
    runShellStep.mockResolvedValue(
      shellResult({
        exitCode: 3,
        filesChanged: [],
        passed: false,
        summary: 'shell step failed (exit 3): unsupported lockfile',
      })
    );
    const result = await applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request });
    expect(result).toMatchObject({ exitCode: 3, passed: false, skipped: false });
    expect(result.codeResult).toBeUndefined();
    expect(provision).not.toHaveBeenCalled();
  });

  it('a push that did not land is not a pass, even though the command exited 0', async () => {
    runShellStep.mockResolvedValue(shellResult({ passed: false, persisted: false }));
    const result = await applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request });
    expect(result.passed).toBe(false);
    expect(result.codeResult).toBeUndefined();
  });

  it('turns a toolchain that cannot run into a failed recipe the agent can follow, masked and bounded', async () => {
    runShellStep.mockRejectedValue(
      new Error(
        `docker: no daemon https://x-access-token:ghp_${'a'.repeat(36)}@github.com ${'z'.repeat(2000)}`
      )
    );
    const result = await applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request });
    expect(result).toMatchObject({ filesChanged: [], passed: false, skipped: false });
    expect(result.summary).not.toContain('ghp_');
    expect(result.summary.length).toBeLessThan(400);
  });

  it('lets a cancellation through', async () => {
    runShellStep.mockRejectedValue(new CancelledFailure('cancelled'));
    await expect(
      applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request })
    ).rejects.toBeInstanceOf(CancelledFailure);
    // The trace is still written.
    expect(persistTrace).toHaveBeenCalledTimes(1);
  });

  it('when the change cannot be described the activity fails rather than reporting an unusable pass', async () => {
    workspace.exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('^1')) {
        throw new Error('no parent');
      }
      return revParse(cmd) ?? '';
    });
    workspace.gitAuthed.mockRejectedValue(new Error('offline'));
    await expect(applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request })).rejects.toThrow(
      /was cut from/
    );
    expect(workspace.destroy).toHaveBeenCalledTimes(1);
  });

  it('reads the base as the pushed commit’s first parent, by sha, never a merge base', async () => {
    await applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request });
    const cmds = workspace.exec.mock.calls.map((c) => c[0] as string);
    expect(cmds.some((c) => c.includes('merge-base'))).toBe(false);
    expect(cmds.some((c) => c.includes(`'${HEAD}^1'`))).toBe(true);
    expect(cmds.some((c) => c.includes('diff-tree') && c.includes(`${BASE} ${HEAD}`))).toBe(true);
  });

  it('refuses a work branch that already exists on the host: the recipe never runs', async () => {
    pinRecipeBase.mockResolvedValue({
      ok: false,
      reason:
        'the work branch auto/CAMPAIGN-abc123 already exists on the host (at cccccccccccc); the recipe builds only on a branch it creates, so it was not run',
    });
    const result = await applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request });
    expect(result).toMatchObject({
      filesChanged: [],
      passed: false,
      refused: true,
      skipped: false,
    });
    expect(result.summary).toMatch(/already exists on the host/);
    expect(result.codeResult).toBeUndefined();
    expect(runShellStep).not.toHaveBeenCalled();
    expect(pinRecipeBase).toHaveBeenCalledWith(request, 'auto/CAMPAIGN-abc123');
  });

  it('refuses a pushed commit whose parent is not the base recorded before the clone', async () => {
    // The branch appeared between the check and the clone, with its own commit: the recipe's
    // commit sits on that, not on the base branch tip.
    const PLANTED = 'c'.repeat(40);
    pinRecipeBase.mockResolvedValue({ baseBranch: 'main', baseSha: PLANTED, ok: true });
    const result = await applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request });
    expect(result).toMatchObject({ passed: false, refused: true, skipped: false });
    expect(result.summary).toMatch(
      /not on the base branch tip cccccccccccc recorded before the clone/
    );
    expect(result.codeResult).toBeUndefined();
    expect(workspace.destroy).toHaveBeenCalledTimes(1);
  });

  it('records the base before the recipe runs', async () => {
    const order: string[] = [];
    pinRecipeBase.mockImplementation(async () => {
      order.push('pin');
      return { baseBranch: 'main', baseSha: BASE, ok: true };
    });
    runShellStep.mockImplementation(async () => {
      order.push('shell');
      return shellResult();
    });
    await applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request });
    expect(order).toEqual(['pin', 'shell']);
  });

  it('refuses a branch tip that is not the commit the recipe pushed', async () => {
    runShellStep.mockResolvedValue(shellResult({ committedSha: 'c'.repeat(40) }));
    await expect(applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request })).rejects.toThrow(
      /not the commit the recipe pushed/
    );
    expect(workspace.destroy).toHaveBeenCalledTimes(1);
  });

  it('fails rather than describe less when a diff read was cut short', async () => {
    workspace.exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('--name-status')) {
        return 'M\0package.json\0';
      }
      return revParse(cmd) ?? withEndMarker(cmd, '');
    });
    await expect(applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request })).rejects.toThrow(
      /cut short/
    );
  });

  describe('trace', () => {
    const recorded = () => JSON.stringify(persistTrace.mock.calls[0]?.[0]);

    it('records a campaign.recipe event and persists it for a pass', async () => {
      await applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request });
      expect(persistTrace).toHaveBeenCalledTimes(1);
      expect(persistTrace.mock.calls[0]?.[1]).toBe('applyRecipe');
      expect(recorded()).toContain('campaign.recipe');
      expect(recorded()).toContain('npm-dependency@1');
    });

    it.each([
      ['a skipped recipe', { params: undefined, recipe: undefined }],
      ['invalid parameters', { params: { packageName: '-x' }, recipe: 'npm-dependency@1' }],
    ])('persists in finally for %s', async (_name, args) => {
      await applyRecipe({ request, ...args });
      expect(persistTrace).toHaveBeenCalledTimes(1);
    });

    it('persists in finally when the shell step throws', async () => {
      runShellStep.mockRejectedValue(new CancelledFailure('x'));
      await applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request }).catch(() => {});
      expect(persistTrace).toHaveBeenCalledTimes(1);
    });

    it('never fails the step over its own trace', async () => {
      persistTrace.mockRejectedValueOnce(new Error('db down'));
      const result = await applyRecipe({ params: NPM, recipe: 'npm-dependency@1', request });
      expect(result.passed).toBe(true);
    });
  });
});
