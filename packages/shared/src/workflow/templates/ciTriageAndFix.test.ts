import { describe, expect, it } from 'vitest';
import { CI_TRIAGE_TEMPLATE_NAME } from '../../lib/ciTrigger.js';
import { type Dispatcher, runSpec } from '../interpreter.js';
import type { Node } from '../spec.js';
import { validateSpec } from '../validateSpec.js';
import { CI_TRIAGE_AND_FIX_SPEC } from './ciTriageAndFix.js';
import { BUILTIN_TEMPLATES } from './index.js';

const implementerSteps = new Set([
  'executeImplementation',
  'executeCIFixImplementation',
  'executeReviewFixImplementation',
  'executeGateFixImplementation',
]);

describe('ci-triage-and-fix', () => {
  it('is the template a CI-failure trigger starts by name', () => {
    expect(CI_TRIAGE_AND_FIX_SPEC.name).toBe(CI_TRIAGE_TEMPLATE_NAME);
    expect(BUILTIN_TEMPLATES.some((t) => t.name === CI_TRIAGE_TEMPLATE_NAME)).toBe(true);
  });

  it('refuses workflow-file changes on every implementer step, the CI loop fix included', () => {
    const steps = Object.entries(CI_TRIAGE_AND_FIX_SPEC.nodes).filter(
      ([, n]) => n.type === 'step' && implementerSteps.has(n.step)
    );
    expect(steps.map(([id]) => id).sort()).toEqual(['ciFix', 'implement', 'pushRetryFix']);
    for (const [, node] of steps) {
      expect((node as Extract<Node, { type: 'step' }>).config).toMatchObject({
        refuseWorkflowChanges: true,
      });
    }
  });

  it('hands the diagnosis to the implementer as untrusted data, never as guidance', () => {
    const implement = CI_TRIAGE_AND_FIX_SPEC.nodes.implement as Extract<Node, { type: 'step' }>;
    expect(implement.inputs).toHaveProperty('ciDiagnosis');
    expect(implement.inputs).not.toHaveProperty('guidance');
  });

  it('opens the fix as a draft', () => {
    const openPR = CI_TRIAGE_AND_FIX_SPEC.nodes.openPR as Extract<Node, { type: 'step' }>;
    expect(openPR.config).toMatchObject({ draft: true });
  });

  it('validates', () => {
    const result = validateSpec(CI_TRIAGE_AND_FIX_SPEC);
    expect(result.errors).toEqual([]);
  });
});

describe('ci-triage-and-fix runs', () => {
  type Outputs = Record<string, unknown | (() => unknown)>;

  function dispatcher(outputs: Outputs, ciPasses = true) {
    const steps: Array<{ step: string; inputs: Record<string, unknown> }> = [];
    const d: Dispatcher = {
      async dispatchStep({ step, inputs }) {
        steps.push({ inputs, step });
        const out = outputs[step];
        return typeof out === 'function' ? (out as () => unknown)() : out;
      },
      async recordStep() {},
      async waitSignal() {
        return ciPasses ? { passed: true } : { logsUrl: 'https://ci/logs', passed: false };
      },
    };
    return { d, steps };
  }

  const base = (payload: Record<string, unknown> = {}) => ({
    context: {},
    nodes: {},
    request: { externalTicketId: 'ci-1-1', payload, repoId: 'r' },
    workflow: { id: 'w' },
  });
  const triage = (decision: string) => ({
    brief: 'Workflow failed: expected 3, received 4',
    category: 'regression',
    decision,
    reason: 'because',
  });

  it('skips without reporting a run the platform may not act on', async () => {
    const { d, steps } = dispatcher({ triageCiFailure: triage('skip') });
    const result = await runSpec(CI_TRIAGE_AND_FIX_SPEC, base(), d);
    expect(result.status).toBe('SKIPPED');
    expect(steps.map((s) => s.step)).toEqual(['triageCiFailure']);
  });

  it('reports a diagnosis without changing anything', async () => {
    const { d, steps } = dispatcher({
      reportCiTriage: { commented: true },
      triageCiFailure: triage('report'),
    });
    const result = await runSpec(CI_TRIAGE_AND_FIX_SPEC, base(), d);
    expect(result.status).toBe('SUCCESS');
    expect(steps.map((s) => s.step)).toEqual(['triageCiFailure', 'reportCiTriage']);
  });

  it('fixes, opens a draft, links it from the PR and ends when its CI passes', async () => {
    const { d, steps } = dispatcher({
      createOrUpdatePullRequest: { prNumber: 8, prUrl: 'https://github.com/a/b/pull/8' },
      executeImplementation: {
        branch: 'auto/ci-1-1',
        filesChanged: [{ path: 'src/sum.ts' }],
        headSha: 'x',
      },
      reportCiTriage: { commented: true },
      resolveCiWaitConfig: { deadlineSec: 60, graceSec: 5, intervalSec: 5, mode: 'signal' },
      runLint: { passed: true },
      runTests: { passed: true },
      runTypecheck: { passed: true },
      triageCiFailure: triage('fix'),
      updateDomainState: {},
    });
    const result = await runSpec(CI_TRIAGE_AND_FIX_SPEC, base(), d);
    expect(result.status).toBe('SUCCESS');
    const implement = steps.find((s) => s.step === 'executeImplementation');
    expect(implement?.inputs.ciDiagnosis).toContain('expected 3');
    const report = steps.filter((s) => s.step === 'reportCiTriage').at(-1);
    expect(report?.inputs.fixPrUrl).toBe('https://github.com/a/b/pull/8');
  });

  it('reports and ends FAILED when the fix attempt fails, opening nothing', async () => {
    const { d, steps } = dispatcher({
      executeImplementation: () => {
        throw new Error('DIFF_TOUCHES_WORKFLOWS');
      },
      reportCiTriage: { commented: true },
      triageCiFailure: triage('fix'),
      updateDomainState: {},
    });
    const result = await runSpec(CI_TRIAGE_AND_FIX_SPEC, base(), d);
    expect(result.status).toBe('FAILED');
    expect(steps.map((s) => s.step)).not.toContain('createOrUpdatePullRequest');
    expect(steps.at(-1)?.step).toBe('reportCiTriage');
  });

  it('reports instead of opening a PR when the fix changed no files', async () => {
    const { d, steps } = dispatcher({
      executeImplementation: { branch: 'auto/ci-1-1', filesChanged: [] },
      reportCiTriage: { commented: true },
      triageCiFailure: triage('fix'),
      updateDomainState: {},
    });
    const result = await runSpec(CI_TRIAGE_AND_FIX_SPEC, base(), d);
    expect(result.status).toBe('SUCCESS');
    expect(steps.map((s) => s.step)).not.toContain('createOrUpdatePullRequest');
  });

  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [undefined, 2],
  ])('revises a draft whose CI keeps failing maxCiFixAttempts=%s times: %s', async (max, fixes) => {
    let sha = 0;
    const { d, steps } = dispatcher(
      {
        createOrUpdatePullRequest: { prNumber: 8, prUrl: 'https://github.com/a/b/pull/8' },
        executeCIFixImplementation: () => ({
          branch: 'auto/ci-1-1',
          filesChanged: [{ path: 'src/sum.ts' }],
          headSha: `fix-${++sha}`,
        }),
        executeImplementation: {
          branch: 'auto/ci-1-1',
          filesChanged: [{ path: 'src/sum.ts' }],
          headSha: 'x',
        },
        fetchCILogs: 'boom',
        reportCiTriage: { commented: true },
        resolveCiWaitConfig: { deadlineSec: 60, graceSec: 5, intervalSec: 5, mode: 'signal' },
        runLint: { passed: true },
        runTests: { passed: true },
        runTypecheck: { passed: true },
        triageCiFailure: triage('fix'),
        updateDomainState: {},
      },
      false
    );
    const result = await runSpec(
      CI_TRIAGE_AND_FIX_SPEC,
      base(max === undefined ? {} : { maxCiFixAttempts: max }),
      d
    );
    expect(result.status).toBe('FAILED');
    expect(steps.filter((s) => s.step === 'executeCIFixImplementation')).toHaveLength(fixes);
  });

  const fixOutputs = (pushOut: unknown) => ({
    createOrUpdatePullRequest: { prNumber: 8, prUrl: 'https://github.com/a/b/pull/8' },
    executeImplementation: {
      branch: 'auto/ci-1-1',
      filesChanged: [{ path: 'src/sum.ts' }],
      headSha: 'x',
    },
    pushCiFixToPullRequest: pushOut,
    reportCiTriage: { commented: true },
    resolveCiWaitConfig: { deadlineSec: 60, graceSec: 5, intervalSec: 5, mode: 'signal' },
    runLint: { passed: true },
    runTests: { passed: true },
    runTypecheck: { passed: true },
    triageCiFailure: triage('fix'),
    updateDomainState: {},
  });

  it('pushes onto the pull request branch when asked, reports it, and opens nothing', async () => {
    const { d, steps } = dispatcher(
      fixOutputs({ branch: 'feature/x', commitSha: 'c'.repeat(40), pushed: true })
    );
    const result = await runSpec(CI_TRIAGE_AND_FIX_SPEC, base({ pullRequestDelivery: 'push' }), d);
    expect(result.status).toBe('SUCCESS');
    const names = steps.map((s) => s.step);
    expect(names).toContain('pushCiFixToPullRequest');
    expect(names).not.toContain('createOrUpdatePullRequest');
    expect(steps.filter((s) => s.step === 'reportCiTriage').at(-1)?.inputs.pushedCommitSha).toBe(
      'c'.repeat(40)
    );
  });

  it.each([
    ['refused', { pushed: false, reason: 'the branch is protected' }],
    ['failed', () => Promise.reject(new Error('GitHub is down'))],
  ])('opens the draft instead when the push is %s', async (_label, pushOut) => {
    const { d, steps } = dispatcher(fixOutputs(pushOut));
    const result = await runSpec(CI_TRIAGE_AND_FIX_SPEC, base({ pullRequestDelivery: 'push' }), d);
    expect(result.status).toBe('SUCCESS');
    expect(steps.map((s) => s.step)).toContain('createOrUpdatePullRequest');
  });

  it('never tries to push when the payload asks for a draft', async () => {
    const { d, steps } = dispatcher(fixOutputs({ pushed: true }));
    await runSpec(CI_TRIAGE_AND_FIX_SPEC, base(), d);
    expect(steps.map((s) => s.step)).not.toContain('pushCiFixToPullRequest');
  });
});
