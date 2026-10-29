import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Covers the cross-repo dependency block reaching the implementer's system
 * prompt (repo dependency graph, P2). Everything the activity touches outside
 * that path — workspace, agent, git, scanners — is faked; the assertion is on
 * the `system` message the implementer agent is generated with.
 */

const { checkoutMock, generateMock, loadMock, prismaMock, ticketMock, workspaceMock } = vi.hoisted(
  () => ({
    checkoutMock: vi.fn(),
    generateMock: vi.fn(),
    loadMock: vi.fn(),
    prismaMock: {
      connection: { findUniqueOrThrow: vi.fn() },
      contextSnapshot: { findUnique: vi.fn() },
      workflowRun: { update: vi.fn() },
    },
    ticketMock: vi.fn(async (..._args: unknown[]) => ''),
    workspaceMock: {
      destroy: vi.fn(async () => {}),
      exec: vi.fn(async (_command: string, _options?: { timeoutMs?: number }) => ''),
      execCapture: vi.fn(),
      gitAuthed: vi.fn(async (_subcommand: string) => ''),
    },
  })
);

const fallbackSetting = vi.hoisted(() => ({ on: false }));
const tddSetting = vi.hoisted(() => ({ maxIterations: 1 }));

vi.mock('@auto-swe/shared/db', () => ({ prisma: prismaMock }));

vi.mock('../lib/ticketContext.js', () => ({ loadTicketContext: ticketMock }));

// Which loop drives the implementer is a run-pinned setting; these tests are about
// the Mastra loop, so the registry read answers without a database.
vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/config')>()),
  // `workflow.ticketContextFallback` is a boolean the tests flip; every other key is the runtime.
  resolveSetting: vi.fn(async (key: string) =>
    key === 'workflow.ticketContextFallback' ? fallbackSetting.on : 'mastra'
  ),
}));

vi.mock('@auto-swe/shared/lib/skillScanner', () => ({
  scanSkillContent: vi.fn(async () => ({ safe: true, warnings: [] })),
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveIssueTrackerConfig: vi.fn(async () => ({})),
  resolveWorkflowDefaults: vi.fn(async () => ({
    branchPrefix: 'auto',
    lessonRetrievalLimit: 5,
    lessonRetrievalThreshold: 0.7,
    get maxTddIterations() {
      return tddSetting.maxIterations;
    },
  })),
}));

vi.mock('@auto-swe/shared/lib/trackerSync', async (orig) => ({
  ...(await orig<typeof import('@auto-swe/shared/lib/trackerSync')>()),
  syncTrackerOnEvent: vi.fn(async () => {}),
}));

vi.mock('@temporalio/activity', () => ({
  ApplicationFailure: { nonRetryable: (msg: string) => new Error(msg) },
  heartbeat: vi.fn(),
}));

vi.mock('../agents/implementer.js', () => ({
  buildImplementerForActivity: vi.fn(async () => ({
    agent: { generate: generateMock },
    closeMcp: undefined,
    maxSteps: 50,
    promptSuffix: '',
    skills: [],
  })),
}));

vi.mock('../agents/securityReviewProcessor.js', () => ({
  scanDiffForSecurityIssues: vi.fn(async () => ({ findings: [], passed: true })),
}));

vi.mock('../lib/activityContext.js', () => ({
  currentAttempt: vi.fn(() => 1),
  currentWorkflowId: vi.fn(() => 'wf-1'),
  persistActivityTrace: vi.fn(async () => {}),
  startTraceFlushing: vi.fn(() => () => {}),
}));

vi.mock('../lib/activityLog.js', () => ({ logWarn: vi.fn() }));

vi.mock('../lib/codeSecurityScanner.js', () => ({ scanDiffForCodeIssues: vi.fn(async () => []) }));

// The loop choice has its own tests (agentRuntime, implementerRuntimeSelect);
// these drive the Mastra loop, the default.
vi.mock('../lib/config/agentRuntime.js', () => ({
  resolveAgentRuntime: vi.fn(async () => ({ runtime: 'mastra', source: 'default' })),
}));
vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn(async () => ({ orgId: 'org-1', teamId: 'team-1' })),
}));

const { assertRolePricedMock } = vi.hoisted(() => ({
  assertRolePricedMock: vi.fn(async (_role: string) => {}),
}));
vi.mock('../lib/usdCapGuard.js', () => ({
  assertRolePricedForUsdCap: assertRolePricedMock,
  // The security gate passes spend refusals through; the real check reads the type.
  isSpendRefusal: (err: unknown) =>
    ['BUDGET_EXCEEDED', 'MODEL_PRICE_UNAVAILABLE', 'MODEL_UNPRICED'].includes(
      (err as { type?: string } | null)?.type ?? ''
    ),
}));
const unpriced = () =>
  Object.assign(new Error('Model has no price in the model catalog'), { type: 'MODEL_UNPRICED' });

vi.mock('../lib/costTracking.js', () => ({
  assertBudgetAvailable: vi.fn(async () => {}),
  recordLlmUsage: vi
    .fn()
    .mockResolvedValue({ costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 }),
}));

vi.mock('../lib/lessonRetrieval.js', () => ({ retrieveSimilarLessons: vi.fn(async () => []) }));

vi.mock('../lib/models.js', () => ({
  getBoundModel: vi.fn(async () => ({
    agent: { id: 'agent-row-4', version: 4 },
    model: {},
    spec: 'anthropic/v4-model',
    systemPrompt: null,
  })),
  resolveSystemPrompt: vi.fn(async () => 'BASE_PROMPT'),
}));

vi.mock('../lib/repoDependencyContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/repoDependencyContext.js')>();
  return { ...actual, checkoutUpstreamRepos: checkoutMock, loadRepoDependencyContext: loadMock };
});

vi.mock('../lib/scm/index.js', () => ({
  getScmProvider: () => ({
    cloneCredentials: vi.fn(async () => ({ authedCloneUrl: 'https://x:t@github.com/a/b.git' })),
  }),
  toRepoRef: (r: unknown) => r,
}));

vi.mock('./workspace.js', () => ({
  createWorkspace: vi.fn(async () => workspaceMock),
  fetchBranchesSubcommand: (branches: string[]) =>
    `fetch origin ${branches.map((b) => `'+refs/heads/${b}:refs/remotes/origin/${b}'`).join(' ')}`,
  gitWithAuthHeader: (s: string) => `HARDENED git ${s}`,
  shellQuote: (s: string) => `'${s}'`,
}));

import { buildImplementerForActivity } from '../agents/implementer.js';
import {
  currentAttempt,
  persistActivityTrace,
  startTraceFlushing,
} from '../lib/activityContext.js';
import { logWarn } from '../lib/activityLog.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { scanDiffForCodeIssues } from '../lib/codeSecurityScanner.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { executeImplementation } from './executeImplementation.js';
import { TEST_RUN_TIMEOUT_MS } from './utils.js';
import { createWorkspace } from './workspace.js';

const REQUEST: RepoWorkRequest = {
  description: 'Add a health endpoint',
  externalTicketId: 'JIRA-1',
  repoId: 'repo-1',
  workRequestId: 'wr-9',
} as RepoWorkRequest;

/** The `system` message the implementer agent was generated with. */
function systemPrompt(): string {
  const messages = generateMock.mock.calls[0][0] as { content: string; role: string }[];
  return messages.find((m) => m.role === 'system')?.content ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentAttempt).mockReturnValue(1);
  vi.mocked(scanDiffForCodeIssues).mockResolvedValue([]);
  loadMock.mockResolvedValue('');
  ticketMock.mockResolvedValue('');
  fallbackSetting.on = false;
  tddSetting.maxIterations = 1;
  checkoutMock.mockResolvedValue('');
  generateMock.mockResolvedValue({ text: 'done', usage: { inputTokens: 1, outputTokens: 1 } });
  prismaMock.connection.findUniqueOrThrow.mockResolvedValue({
    defaultBranch: 'main',
    executorImage: null,
    id: 'repo-1',
    organizationName: 'acme',
    repoName: 'api',
  });
  prismaMock.contextSnapshot.findUnique.mockResolvedValue(null);
  prismaMock.workflowRun.update.mockResolvedValue({});
  workspaceMock.exec.mockResolvedValue('');
});

describe('USD-cap guard', () => {
  it('refuses an unpriced model before any workspace exists, and spends nothing', async () => {
    assertRolePricedMock.mockRejectedValueOnce(unpriced());
    await expect(executeImplementation(REQUEST)).rejects.toMatchObject({ type: 'MODEL_UNPRICED' });
    expect(assertRolePricedMock).toHaveBeenCalledWith('implementer');
    expect(vi.mocked(createWorkspace)).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('proceeds when the guard passes (an uncapped organization)', async () => {
    await executeImplementation(REQUEST);
    expect(generateMock).toHaveBeenCalled();
  });
});

describe('executeImplementation agent turn', () => {
  it('prices each TDD turn at the bound model and stamps its Agent row on the trace row', async () => {
    const addLlmResponse = vi.spyOn(AgentTracer.prototype, 'addLlmResponse');
    await executeImplementation(REQUEST);
    expect(vi.mocked(recordLlmUsage)).toHaveBeenCalledWith(
      expect.anything(),
      'implementer',
      expect.anything(),
      expect.anything(),
      'anthropic/v4-model'
    );
    expect(addLlmResponse).toHaveBeenCalledWith(
      expect.objectContaining({ agent: { id: 'agent-row-4', version: 4 } })
    );
  });

  it('passes the resolved step budget to every TDD iteration', async () => {
    await executeImplementation(REQUEST);
    expect(generateMock.mock.calls[0]?.[1]).toMatchObject({ maxSteps: 50, toolChoice: 'auto' });
  });

  it("runs the repo's configured runTests command", async () => {
    prismaMock.connection.findUniqueOrThrow.mockResolvedValue({
      defaultBranch: 'main',
      executorImage: null,
      gateCommands: { runTests: 'go test ./...' },
      id: 'repo-1',
      organizationName: 'acme',
      repoName: 'api',
    });
    await executeImplementation(REQUEST);
    const testCall = workspaceMock.exec.mock.calls.find(
      (c: unknown[]) =>
        (c[1] as { timeoutMs?: number } | undefined)?.timeoutMs === TEST_RUN_TIMEOUT_MS
    );
    expect(testCall?.[0]).toBe('{ go test ./...\n} 2>&1');
  });
});

describe('executeImplementation live trace flushing', () => {
  it('flushes the activity tracer while it runs, and stops before the final persist', async () => {
    const calls: string[] = [];
    vi.mocked(startTraceFlushing).mockImplementationOnce(() => {
      calls.push('start');
      return () => calls.push('stop');
    });
    generateMock.mockImplementationOnce(async () => {
      calls.push('generate');
      return { text: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    vi.mocked(persistActivityTrace).mockImplementationOnce(async () => {
      calls.push('persist');
      return true;
    });

    await executeImplementation(REQUEST);

    expect(calls).toEqual(['start', 'generate', 'stop', 'persist']);
    const [tracer, agentKey] = vi.mocked(startTraceFlushing).mock.calls[0] ?? [];
    expect(agentKey).toBe('implementer');
    expect(tracer).toBe(vi.mocked(persistActivityTrace).mock.calls[0]?.[0]);
  });

  it('still stops flushing and persists when the activity fails', async () => {
    const calls: string[] = [];
    vi.mocked(startTraceFlushing).mockReturnValueOnce(() => calls.push('stop'));
    vi.mocked(persistActivityTrace).mockImplementationOnce(async () => {
      calls.push('persist');
      return true;
    });
    generateMock.mockRejectedValue(new Error('model down'));

    await expect(executeImplementation(REQUEST)).rejects.toThrow();

    expect(calls).toEqual(['stop', 'persist']);
  });
});

describe('executeImplementation base branch', () => {
  it("clones the repository's default branch when the run names no base", async () => {
    const result = await executeImplementation(REQUEST);
    expect(vi.mocked(createWorkspace).mock.calls[0]?.[2]).toBe('main');
    expect(result.baseBranch).toBe('main');
  });

  it("clones, diffs against and reports the payload's base", async () => {
    const result = await executeImplementation({
      ...REQUEST,
      payload: { baseBranch: 'release/1.4' },
    });
    expect(vi.mocked(createWorkspace).mock.calls[0]?.[2]).toBe('release/1.4');
    const diff = workspaceMock.exec.mock.calls.find((c: unknown[]) =>
      String(c[0]).startsWith('git diff origin/')
    );
    expect(diff?.[0]).toBe("git diff origin/'release/1.4'");
    expect(result.baseBranch).toBe('release/1.4');
  });

  it('refuses a malformed base before any workspace exists', async () => {
    await expect(
      executeImplementation({ ...REQUEST, payload: { baseBranch: '-x' } })
    ).rejects.toThrow(/not a valid branch name/);
    expect(vi.mocked(createWorkspace)).not.toHaveBeenCalled();
  });
});

describe('executeImplementation tracker ticket context', () => {
  const run = (ticket?: string) =>
    executeImplementation(
      { ...REQUEST, workRequestId: 'wr-1' } as RepoWorkRequest,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ticket
    );

  it('appends the ticket an earlier step produced to the implementer system prompt, and fetches nothing', async () => {
    fallbackSetting.on = true;
    await run('\n\n## Issue tracker ticket\n<ticket>\nTitle: Health endpoint\n</ticket>');
    const prompt = systemPrompt();
    expect(prompt.startsWith('BASE_PROMPT')).toBe(true);
    expect(prompt).toContain('Title: Health endpoint');
    expect(ticketMock).not.toHaveBeenCalled();
  });

  it('puts the ticket before the cross-repo block, so the dependency graph stays last', async () => {
    loadMock.mockResolvedValue('[CROSS]');
    await run('[TICKET]');
    const prompt = systemPrompt();
    expect(prompt.indexOf('[TICKET]')).toBeGreaterThan(-1);
    expect(prompt.indexOf('[TICKET]')).toBeLessThan(prompt.indexOf('[CROSS]'));
  });

  it('takes an empty ticket from the step as "none", even with the fallback on', async () => {
    fallbackSetting.on = true;
    await run('');
    expect(systemPrompt()).toBe('BASE_PROMPT');
    expect(ticketMock).not.toHaveBeenCalled();
  });

  it('does not fetch on its own while the fallback setting is off', async () => {
    await run();
    expect(ticketMock).not.toHaveBeenCalled();
    expect(systemPrompt()).toBe('BASE_PROMPT');
  });

  it("fetches the run's ticket when no step provided one and the fallback is on", async () => {
    fallbackSetting.on = true;
    ticketMock.mockResolvedValue('[TICKET]');
    await run();
    expect(ticketMock).toHaveBeenCalledWith(expect.objectContaining({ workRequestId: 'wr-1' }));
    expect(systemPrompt()).toContain('[TICKET]');
  });

  it('does not stop the implementation when the fallback lookup rejects', async () => {
    fallbackSetting.on = true;
    ticketMock.mockRejectedValue(new Error('boom'));
    await run();
    expect(systemPrompt()).toBe('BASE_PROMPT');
  });
});

describe('executeImplementation cross-repo context', () => {
  it('appends the dependency block to the implementer system prompt', async () => {
    loadMock.mockResolvedValue('\n\n## Cross-Repo Dependency Context\n- acme/web — kinds: code');

    await executeImplementation(REQUEST);

    expect(loadMock).toHaveBeenCalledWith('repo-1', 'org-1');
    const prompt = systemPrompt();
    expect(prompt.startsWith('BASE_PROMPT')).toBe(true);
    expect(prompt).toContain('## Cross-Repo Dependency Context');
    expect(prompt).toContain('- acme/web — kinds: code');
  });

  it('leaves the prompt unchanged when the graph is empty', async () => {
    await executeImplementation(REQUEST);
    expect(systemPrompt()).toBe('BASE_PROMPT');
  });

  it('leaves the image undefined when the connection pins none, so the config default applies', async () => {
    // The 4th argument must be `undefined`, not a literal. `createWorkspace`
    // resolves `image ?? infra.image`, so ANY string here wins the `??`
    // and the operator's WORKSPACE_IMAGE is never read — which is
    // exactly how it was silently unreachable on every workspace path.
    await executeImplementation(REQUEST);
    expect(vi.mocked(createWorkspace)).toHaveBeenCalled();
    expect(vi.mocked(createWorkspace).mock.calls[0]?.[3]).toBeUndefined();
  });

  it('passes the connection executorImage through when one is pinned', async () => {
    prismaMock.connection.findUniqueOrThrow.mockResolvedValue({
      defaultBranch: 'main',
      executorImage: 'ghcr.io/acme/executor:9',
      id: 'repo-1',
      organizationName: 'acme',
      repoName: 'api',
    });
    await executeImplementation(REQUEST);
    expect(vi.mocked(createWorkspace).mock.calls[0]?.[3]).toBe('ghcr.io/acme/executor:9');
  });

  it('skips the graph read when the step opts out', async () => {
    await executeImplementation(REQUEST, undefined, undefined, { crossRepoContext: false });
    expect(loadMock).not.toHaveBeenCalled();
    expect(systemPrompt()).toBe('BASE_PROMPT');
  });

  it('does not check out upstream repos by default', async () => {
    loadMock.mockResolvedValue('\n\nBLOCK');
    await executeImplementation(REQUEST);
    expect(checkoutMock).not.toHaveBeenCalled();
  });

  it('checks out upstream repos when the expensive tier is enabled', async () => {
    loadMock.mockResolvedValue('\n\nBLOCK');
    checkoutMock.mockResolvedValue('\n\n### Upstream sources checked out locally\n- a → `/x`');

    await executeImplementation(REQUEST, undefined, undefined, { crossRepoCheckout: true });

    expect(checkoutMock).toHaveBeenCalledWith(workspaceMock, 'repo-1', 'org-1');
    expect(systemPrompt()).toContain('Upstream sources checked out locally');
  });

  it('never fails the run when the graph read throws', async () => {
    loadMock.mockRejectedValue(new Error('db down'));
    await expect(executeImplementation(REQUEST)).resolves.toMatchObject({ repoId: 'repo-1' });
    expect(systemPrompt()).toBe('BASE_PROMPT');
  });

  it('never fails the run when the dependency checkout throws', async () => {
    loadMock.mockResolvedValue('\n\nBLOCK');
    checkoutMock.mockRejectedValue(new Error('docker gone'));
    await expect(
      executeImplementation(REQUEST, undefined, undefined, { crossRepoCheckout: true })
    ).resolves.toMatchObject({ repoId: 'repo-1' });
  });
});

describe('executeImplementation shell hygiene', () => {
  it('shell-quotes the repository defaultBranch in the diff command', async () => {
    prismaMock.connection.findUniqueOrThrow.mockResolvedValue({
      defaultBranch: 'main; touch /pwned',
      executorImage: null,
      id: 'repo-1',
      organizationName: 'acme',
      repoName: 'api',
    });
    await executeImplementation(REQUEST);
    const commands = workspaceMock.exec.mock.calls.map((c) => c[0]);
    expect(commands).toContain("git diff origin/'main; touch /pwned'");
    expect(commands).not.toContain('git diff origin/main; touch /pwned');
  });
});

describe('executeImplementation allowedPaths', () => {
  const BASE = 'a'.repeat(40);
  const commands = () => workspaceMock.exec.mock.calls.map((c) => c[0]);
  const pushed = () =>
    workspaceMock.gitAuthed.mock.calls.some((c) => (c[0] as string).includes('push origin'));
  /** The guarded step's git calls: the starting commit, the merge base, the committed range. */
  const withRange = (names: string) =>
    workspaceMock.exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('rev-parse --verify')) {
        return `${BASE}\n`;
      }
      return cmd.includes('diff-tree') ? names : '';
    });

  it('reads the starting commit before the agent runs, and checks the committed tree before the push', async () => {
    withRange('docs/a.md\0');
    await executeImplementation(REQUEST, undefined, undefined, undefined, ['docs/a.md']);
    const cmds = commands();
    const start = cmds.findIndex((c) => c.includes('rev-parse --verify'));
    const commit = cmds.findIndex((c) => c.includes('commit --no-verify'));
    const range = cmds.findIndex((c) =>
      c.includes(
        `diff-tree -r --name-only --no-renames --ignore-submodules=none -z ${BASE} ${BASE}`
      )
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(generateMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      workspaceMock.exec.mock.invocationCallOrder[start] as number
    );
    expect(commit).toBeGreaterThan(start);
    expect(range).toBeGreaterThan(commit);
    expect(
      cmds.every((c) => !c.includes('commit -m') || c.startsWith('GIT_NO_REPLACE_OBJECTS=1'))
    ).toBe(true);
    expect(pushed()).toBe(true);
  });

  it('fails before the push when the committed range names a file outside the list', async () => {
    withRange('docs/a.md\0.github/workflows/x.yml\0');
    await expect(
      executeImplementation(REQUEST, undefined, undefined, undefined, ['docs/a.md'])
    ).rejects.toThrow(/may not change \(\.github\/workflows\/x\.yml\)/);
    expect(pushed()).toBe(false);
  });

  it('pushes exactly the checked commit, and reports it as the head', async () => {
    withRange('docs/a.md\0');
    const result = await executeImplementation(REQUEST, undefined, undefined, undefined, [
      'docs/a.md',
    ]);
    expect(workspaceMock.gitAuthed).toHaveBeenCalledWith(
      `push origin ${BASE}:refs/heads/'auto/JIRA-1'`
    );
    expect(result.headSha).toBe(BASE);
  });

  it('reports a diff measured from the starting commit', async () => {
    withRange('docs/a.md\0');
    await executeImplementation(REQUEST, undefined, undefined, undefined, ['docs/a.md']);
    expect(
      commands().some((c) =>
        c.includes(`diff --no-ext-diff --no-textconv --ignore-submodules=none ${BASE} ${BASE}`)
      )
    ).toBe(true);
    expect(commands()).not.toContain("git diff origin/'main'");
  });

  it('changes nothing for a step that sets no list', async () => {
    await executeImplementation(REQUEST);
    expect(
      commands().some((c) => c.includes('rev-parse --verify') || c.includes('--no-verify'))
    ).toBe(false);
    expect(commands()).toContainEqual(
      expect.stringMatching(
        /^git diff --cached --quiet \|\| git commit -m 'auto: implement JIRA-1\n\nAuto-SWE-Run: wr-9/
      )
    );
    expect(commands()).toContain("git diff origin/'main'");
    expect(workspaceMock.gitAuthed).toHaveBeenCalledWith("push origin 'auto/JIRA-1'");
    expect(pushed()).toBe(true);
  });
});

describe('executeImplementation retry safety', () => {
  const execCommands = () => workspaceMock.exec.mock.calls.map((c) => c[0]);

  it('starts from the clone HEAD on the first attempt', async () => {
    await executeImplementation(REQUEST);
    expect(workspaceMock.gitAuthed).not.toHaveBeenCalledWith(
      "fetch origin '+refs/heads/auto/JIRA-1:refs/remotes/origin/auto/JIRA-1'"
    );
    expect(execCommands()).not.toContain("git reset --hard origin/'auto/JIRA-1'");
  });

  /** What `git log -1` on the remote branch answers: the tip commit's message. */
  const remoteTip = (message: string) =>
    workspaceMock.exec.mockImplementation(async (command: string) =>
      command.startsWith('git log -1') ? message : ''
    );

  it('syncs to the branch a previous attempt of this run pushed when retried', async () => {
    vi.mocked(currentAttempt).mockReturnValue(2);
    remoteTip('auto: implement JIRA-1\n\nAuto-SWE-Run: wr-9');
    await executeImplementation(REQUEST);
    expect(workspaceMock.gitAuthed).toHaveBeenCalledWith(
      "fetch origin '+refs/heads/auto/JIRA-1:refs/remotes/origin/auto/JIRA-1'"
    );
    expect(execCommands()).toContain("git reset --hard origin/'auto/JIRA-1'");
    // The push still happens after the agent's work.
    expect(workspaceMock.gitAuthed).toHaveBeenLastCalledWith("push origin 'auto/JIRA-1'");
  });

  it('does not adopt a branch whose tip another run made, and pushes nothing', async () => {
    // The chain this guards: run 2 on a ticket cannot push (the branch holds run 1's commits),
    // is retried, and would reset to run 1's branch and push onto run 1's pull request.
    vi.mocked(currentAttempt).mockReturnValue(2);
    remoteTip('auto: implement JIRA-1\n\nAuto-SWE-Run: wr-1');
    await expect(executeImplementation(REQUEST)).rejects.toThrow(/already exists with commits/);
    expect(execCommands()).not.toContain("git reset --hard origin/'auto/JIRA-1'");
    expect(workspaceMock.gitAuthed).not.toHaveBeenCalledWith(expect.stringContaining('push '));
  });

  it('does not adopt a branch whose tip carries no run trailer at all', async () => {
    vi.mocked(currentAttempt).mockReturnValue(2);
    remoteTip('fix: a person pushed this');
    await expect(executeImplementation(REQUEST)).rejects.toThrow(/already exists with commits/);
    expect(execCommands()).not.toContain("git reset --hard origin/'auto/JIRA-1'");
  });

  it('works on the branch the request carries, not the ticket’s', async () => {
    await executeImplementation({ ...REQUEST, branchName: 'auto/JIRA-1-ab12cd34' });
    expect(workspaceMock.gitAuthed).toHaveBeenLastCalledWith("push origin 'auto/JIRA-1-ab12cd34'");
  });

  it('proceeds from the clone when the retry finds nothing pushed yet', async () => {
    vi.mocked(currentAttempt).mockReturnValue(2);
    workspaceMock.gitAuthed.mockImplementation(async (sub: string) => {
      if (sub.startsWith('fetch')) {
        throw new Error("fatal: couldn't find remote ref");
      }
      return '';
    });
    await expect(executeImplementation(REQUEST)).resolves.toMatchObject({ branch: 'auto/JIRA-1' });
  });

  it('skips the commit when nothing is staged so a no-op retry still pushes', async () => {
    await executeImplementation(REQUEST);
    expect(execCommands()).toContainEqual(
      expect.stringMatching(
        /^git diff --cached --quiet \|\| git commit -m 'auto: implement JIRA-1\n\nAuto-SWE-Run: wr-9/
      )
    );
  });

  it('degrades the advisory code-security scan instead of failing the run', async () => {
    vi.mocked(scanDiffForCodeIssues).mockRejectedValue(new Error('pattern db down'));
    await expect(executeImplementation(REQUEST)).resolves.toMatchObject({
      codeSecurityFindings: undefined,
      repoId: 'repo-1',
    });
  });

  it('gives the test run the long timeout instead of the 2-minute exec default', async () => {
    await executeImplementation(REQUEST);
    const testCall = workspaceMock.exec.mock.calls.find(
      (c) => c[1]?.timeoutMs === TEST_RUN_TIMEOUT_MS
    );
    expect(testCall).toBeDefined();
  });

  it('destroys the workspace and persists the trace when the runtime fails to close', async () => {
    vi.mocked(buildImplementerForActivity).mockResolvedValueOnce({
      agent: { generate: generateMock },
      closeMcp: vi.fn(async () => {
        throw new Error('mcp close failed');
      }),
      maxSteps: 50,
      promptSuffix: '',
      skills: [],
    } as never);
    await expect(executeImplementation(REQUEST)).resolves.toMatchObject({ repoId: 'repo-1' });
    expect(vi.mocked(logWarn)).toHaveBeenCalledWith('implementer runtime failed to close', {
      error: 'mcp close failed',
    });
    expect(vi.mocked(persistActivityTrace)).toHaveBeenCalledTimes(1);
    expect(workspaceMock.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('executeImplementation unrunnable test command', () => {
  const isTestRun = (c: unknown[]) =>
    (c[1] as { timeoutMs?: number } | undefined)?.timeoutMs === TEST_RUN_TIMEOUT_MS;

  /** Make the test run (and only it) reject like a failed `docker exec`. */
  function failTestRun(fields: Record<string, unknown>) {
    workspaceMock.exec.mockImplementation(
      async (_command: string, options?: { timeoutMs?: number }) => {
        if (options?.timeoutMs === TEST_RUN_TIMEOUT_MS) {
          throw Object.assign(new Error('Command failed'), fields);
        }
        return '';
      }
    );
  }

  beforeEach(() => {
    tddSetting.maxIterations = 3;
  });

  it('stops after the first unrunnable iteration instead of re-running the agent', async () => {
    failTestRun({ code: 127, stdout: 'sh: bun: not found' });
    await executeImplementation(REQUEST);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(workspaceMock.exec.mock.calls.filter(isTestRun)).toHaveLength(1);
  });

  it('records a tdd.test_unrunnable event with the iteration, command and trimmed output', async () => {
    const eventSpy = vi.spyOn(AgentTracer.prototype, 'addActivityEvent');
    failTestRun({
      code: 1,
      stdout: `HEAD\nnpm error Missing script: "test"${'x'.repeat(2000)}TAIL`,
    });
    await executeImplementation(REQUEST);
    const events = eventSpy.mock.calls
      .map(([e]) => e)
      .filter((e) => e.name === 'tdd.test_unrunnable');
    expect(events).toHaveLength(1);
    expect(events[0].inputJson).toEqual({ iteration: 0 });
    const out = events[0].outputJson as { command: string; output: string; reason: string };
    expect(out.command).toBe('npm test');
    expect(out.reason).toContain('Missing script');
    expect(out.output).toHaveLength(1000);
    expect(out.output.endsWith('TAIL')).toBe(true);
    expect(out.output).not.toContain('HEAD');
  });

  it('stops after one pass when npm cannot find a package.json (non-repo-Node workspace)', async () => {
    const eventSpy = vi.spyOn(AgentTracer.prototype, 'addActivityEvent');
    failTestRun({
      code: 254,
      stdout: [
        'npm error code ENOENT',
        'npm error syscall open',
        'npm error path /workspace/target-repo/package.json',
        'npm error errno -2',
        'npm error enoent Could not read package.json: Error: ENOENT: no such file or directory',
      ].join('\n'),
    });
    const result = await executeImplementation(REQUEST);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(workspaceMock.exec.mock.calls.filter(isTestRun)).toHaveLength(1);
    const events = eventSpy.mock.calls
      .map(([e]) => e)
      .filter((e) => e.name === 'tdd.test_unrunnable');
    expect(events).toHaveLength(1);
    expect((events[0].outputJson as { reason: string }).reason).toBe(
      'npm reports no package.json in the workspace'
    );
    expect(result.implementationNotes).toContain(
      'could not run in the workspace (npm reports no package.json in the workspace)'
    );
  });

  it('keeps iterating when the missing-package.json text comes with exit 1 (a nested run in a failing suite)', async () => {
    failTestRun({
      code: 1,
      stdout:
        'npm error enoent Could not read package.json: Error: ENOENT: no such file\nTests: 1 failed',
    });
    await executeImplementation(REQUEST);
    expect(generateMock).toHaveBeenCalledTimes(3);
  });

  it('says plainly that the test command could not run, with the command and cause', async () => {
    failTestRun({ code: 127, stdout: 'sh: npm: not found' });
    const result = await executeImplementation(REQUEST);
    expect(result.implementationNotes).toContain('could not run in the workspace');
    expect(result.implementationNotes).toContain('npm test');
    expect(result.implementationNotes).toContain('127');
    expect(result.implementationNotes).not.toContain('(max)');
    expect(result.implementationNotes).not.toContain('not executed');
    expect(result.testResults).toMatchObject({ failing: 1, passed: false });
  });

  it('still commits and pushes the work', async () => {
    failTestRun({ code: 127, stdout: 'sh: bun: not found' });
    await executeImplementation(REQUEST);
    const commands = workspaceMock.exec.mock.calls.map((c) => c[0]);
    expect(commands).toContain('git add -A');
    expect(workspaceMock.gitAuthed).toHaveBeenCalledWith(expect.stringContaining('push origin'));
  });

  it('keeps iterating up to the maximum when tests ran and failed', async () => {
    failTestRun({ code: 1, stdout: 'Tests: 2 failed, 5 passed' });
    const result = await executeImplementation(REQUEST);
    expect(generateMock).toHaveBeenCalledTimes(3);
    expect(result.implementationNotes).toContain('3 (max) TDD iterations');
  });

  it('stops as soon as the tests pass', async () => {
    workspaceMock.exec.mockResolvedValue('Tests  4 passed (4)');
    const result = await executeImplementation(REQUEST);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(result.implementationNotes).toContain('Tests passing');
  });
});

// A failing assertion must not leak a spy on AgentTracer into the next test.
afterEach(() => {
  vi.restoreAllMocks();
});
