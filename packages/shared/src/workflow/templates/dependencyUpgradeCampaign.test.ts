import { describe, expect, it } from 'vitest';
import { CAMPAIGN_UPGRADE_PROMPT } from '../../lib/agentPrompts.js';
import { CAMPAIGN_RECIPE_REFS } from '../../lib/campaignRecipes.js';
import { validateInputPayload } from '../../lib/inputSchema.js';
import { type Dispatcher, runSpec } from '../interpreter.js';
import { type Node, nodeEdges } from '../spec.js';
import {
  DEPENDENCY_UPGRADE_CAMPAIGN_INPUT_SCHEMA as schema,
  DEPENDENCY_UPGRADE_CAMPAIGN_SPEC as spec,
} from './dependencyUpgradeCampaign.js';
import { BUILTIN_TEMPLATES } from './index.js';

const nodes = Object.entries(spec.nodes);
const stepNodes = (name: string) =>
  nodes.filter(([, n]) => n.type === 'step' && n.step === name) as Array<
    [string, Extract<Node, { type: 'step' }>]
  >;

/** Node ids reachable from `from`, following every edge. */
function reachable(from: string): Set<string> {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const id = queue.pop() as string;
    if (seen.has(id) || !spec.nodes[id]) {
      continue;
    }
    seen.add(id);
    queue.push(...nodeEdges(spec.nodes[id] as Node).map(([, target]) => target));
  }
  return seen;
}

const terminals = nodes.filter(([, n]) => n.type === 'terminate').map(([id]) => id);

describe('dependency-upgrade-campaign template', () => {
  it('is registered as a built-in with its own description and input schema', () => {
    const t = BUILTIN_TEMPLATES.find((b) => b.name === 'dependency-upgrade-campaign');
    expect(t?.spec).toBe(spec);
    expect(t?.description).toBe(spec.description);
    expect(t?.inputSchema).toBe(schema);
  });

  it('ends every path at a terminal: no node is a dead end and every node reaches one', () => {
    expect(terminals.sort()).toEqual([
      'done',
      'doneNotAffected',
      'failRecipeRefused',
      'failVerify',
    ]);
    for (const [id, node] of nodes) {
      if (node.type === 'terminate') {
        continue;
      }
      const edges = nodeEdges(node as Node);
      expect(edges.length, `${id} has no outgoing edge`).toBeGreaterThan(0);
      const reach = reachable(id);
      expect(
        terminals.some((t) => reach.has(t)),
        `${id} reaches no terminal`
      ).toBe(true);
    }
  });

  it('opens the pull request as a draft, and only after a passing verification', () => {
    const [[, open]] = stepNodes('createOrUpdatePullRequest') as [
      [string, Extract<Node, { type: 'step' }>],
    ];
    expect(open.config).toEqual({ draft: true });
    // Both ways into the pull request pass a verdict of the protected gate.
    for (const gate of ['checkVerify', 'checkReverify']) {
      expect(spec.nodes[gate]).toMatchObject({ onTrue: 'openPR' });
    }
    const intoPr = nodes
      .filter(([, n]) => nodeEdges(n as Node).some(([, target]) => target === 'openPR'))
      .map(([id]) => id)
      .sort();
    expect(intoPr).toEqual(['checkReverify', 'checkVerify']);
    expect(reachable('doneNotAffected').has('openPR')).toBe(false);
    expect(reachable('failVerify').has('openPR')).toBe(false);
  });

  it('has no CI loop, no review network and no human step', () => {
    const steps = nodes
      .filter(([, n]) => n.type === 'step')
      .map(([, n]) => (n as { step: string }).step);
    for (const forbidden of [
      'runReviewNetwork',
      'fetchCILogs',
      'executeCIFixImplementation',
      'executeReviewFixImplementation',
    ]) {
      expect(steps).not.toContain(forbidden);
    }
    expect(nodes.some(([, n]) => n.type === 'signal' || n.type.startsWith('human'))).toBe(false);
    expect(Object.keys(spec.nodes)).not.toContain('waitForCI');
  });

  it('forces the test-integrity guard to block on both agent steps, with the campaign brief', () => {
    for (const step of ['executeImplementation', 'executeGateFixImplementation']) {
      const found = stepNodes(step);
      expect(found.length, step).toBe(1);
      expect(found[0]?.[1].config?.testIntegrity, step).toBe('block');
      // A dependency upgrade never needs a workflow file; a pushed one runs with the secrets.
      expect(found[0]?.[1].config?.refuseWorkflowChanges, step).toBe(true);
    }
    const [[, implement]] = stepNodes('executeImplementation');
    expect(implement.config?.systemPrompt).toBe(CAMPAIGN_UPGRADE_PROMPT);
  });

  it('verifies with the original tests both before and after the one fix attempt', () => {
    const gates = stepNodes('runTests');
    expect(gates.map(([id]) => id).sort()).toEqual(['reverify', 'verify']);
    for (const [id, gate] of gates) {
      expect(gate.config, id).toEqual({ protectTests: true });
      // Advisory: a failing run is a result to route on, not an error.
      expect(gate.onFail, id).toBe('warn');
    }
    expect(stepNodes('executeGateFixImplementation')).toHaveLength(1);
    expect(spec.nodes.checkReverify).toMatchObject({ onFalse: 'failVerify' });
  });

  it('only spends one fix attempt: a second failure ends FAILED', () => {
    expect(reachable('reverify').has('fixVerify')).toBe(false);
    expect(spec.nodes.failVerify).toMatchObject({ status: 'FAILED', type: 'terminate' });
  });

  it('accepts the recipes in the catalogue and nothing else', () => {
    expect(schema.properties.recipe?.enum).toEqual([...CAMPAIGN_RECIPE_REFS]);
    const ok = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      packageName: '@scope/pkg',
      recipe: 'npm-dependency@1',
      targetVersion: '1.2.3',
    };
    expect(validateInputPayload(schema, ok).ok).toBe(true);
    expect(validateInputPayload(schema, { ...ok, recipe: 'curl-pipe-sh@1' }).ok).toBe(false);
  });

  it.each([
    '$(touch x)',
    '`id`',
    'a b',
    'a;b',
    'a\nb',
    '-rf',
    'a|b',
    'a&b',
    "a'b",
    'a"b',
    'a\\b',
    'github:evil/repo',
    'file:../x',
    'ünï',
  ])('rejects the package name %j', (packageName) => {
    const result = validateInputPayload(schema, {
      connectionId: '11111111-1111-4111-8111-111111111111',
      packageName,
      targetVersion: '1.0.0',
    });
    expect(result.ok).toBe(false);
  });

  it.each(['1.0.0 && id', '$(id)', 'a b', '1;2', '^1.0.0', '~1', '-1', 'a\nb', '1\u0000'])(
    'rejects the target version %j',
    (targetVersion) => {
      const result = validateInputPayload(schema, {
        connectionId: '11111111-1111-4111-8111-111111111111',
        packageName: 'lodash',
        targetVersion,
      });
      expect(result.ok).toBe(false);
    }
  );

  describe('run', () => {
    interface Script {
      recipe?: Record<string, unknown>;
      /** The recipe step throws (its `warn` policy leaves a null output). */
      recipeThrows?: boolean;
      implement?: Record<string, unknown>;
      /** The verdicts of the protected gate, in order. */
      verdicts?: boolean[];
    }

    function dispatcher(script: Script) {
      const steps: Array<{
        step: string;
        config: Record<string, unknown>;
        inputs: Record<string, unknown>;
      }> = [];
      const verdicts = [...(script.verdicts ?? [true])];
      const codeResult = (marker: string) => ({
        branch: 'auto/CAMPAIGN-x',
        filesChanged: [{ path: 'package.json' }],
        marker,
      });
      const d: Dispatcher = {
        async dispatchStep({ step, config, inputs }) {
          steps.push({ config, inputs, step });
          switch (step) {
            case 'applyRecipe':
              if (script.recipeThrows) {
                throw new Error('could not provision the gate workspace');
              }
              return (
                script.recipe ?? {
                  codeResult: codeResult('recipe'),
                  filesChanged: ['package.json', 'package-lock.json'],
                  passed: true,
                  skipped: false,
                }
              );
            case 'executeImplementation':
              return (
                script.implement ?? {
                  ...codeResult('agent'),
                  filesChanged: [{ path: 'package.json' }],
                }
              );
            case 'executeGateFixImplementation':
              return codeResult('fix');
            case 'runTests':
              return { passed: verdicts.shift() ?? false, summary: 'x' };
            case 'createOrUpdatePullRequest':
              return { prNumber: 9, prUrl: 'https://example.test/o/r/pull/9' };
            default:
              return {};
          }
        },
        async recordStep() {},
        async waitSignal() {
          return undefined;
        },
      };
      return { d, steps };
    }

    const base = (payload: Record<string, unknown> = {}) => ({
      context: {},
      nodes: {},
      request: {
        externalTicketId: 'CAMPAIGN-x',
        payload: {
          connectionId: 'c',
          packageName: 'lodash',
          recipe: 'npm-dependency@1',
          targetVersion: '4.17.21',
          ...payload,
        },
        repoId: 'r',
      },
      workflow: { id: 'w' },
    });
    const names = (steps: Array<{ step: string }>) =>
      steps.map((s) => s.step).filter((s) => s !== 'updateDomainState');

    it('recipe applies and the original tests pass: a draft PR, path RECIPE', async () => {
      const { d, steps } = dispatcher({});
      const result = await runSpec(spec, base(), d);
      expect(result.status).toBe('SUCCESS');
      expect(names(steps)).toEqual(['applyRecipe', 'runTests', 'createOrUpdatePullRequest']);
      expect(result.result).toMatchObject({
        changed: true,
        path: 'RECIPE',
        prNumber: 9,
        verification: 'PASSED',
      });
      const open = steps.find((s) => s.step === 'createOrUpdatePullRequest');
      expect(open?.config).toEqual({ draft: true });
      // The PR is opened from the recipe's change.
      expect((open?.inputs.codeResult as { marker?: string } | undefined)?.marker).toBe('recipe');
      // The gate was told to protect the tests.
      expect(steps.find((s) => s.step === 'runTests')?.config).toEqual({ protectTests: true });
    });

    it('hands the recipe its three inputs from the run payload', async () => {
      const { d, steps } = dispatcher({});
      await runSpec(spec, base(), d);
      expect(steps.find((s) => s.step === 'applyRecipe')?.inputs).toEqual({
        packageName: 'lodash',
        recipe: 'npm-dependency@1',
        targetVersion: '4.17.21',
      });
    });

    it('recipe cannot apply: the agent makes the change, path AGENT', async () => {
      const { d, steps } = dispatcher({
        recipe: {
          filesChanged: [],
          passed: false,
          skipped: false,
          summary: 'unsupported lockfile',
        },
      });
      const result = await runSpec(spec, base(), d);
      expect(result.status).toBe('SUCCESS');
      expect(names(steps)).toEqual([
        'applyRecipe',
        'executeImplementation',
        'runTests',
        'createOrUpdatePullRequest',
      ]);
      expect(result.result).toMatchObject({ path: 'AGENT', verification: 'PASSED' });
      const agent = steps.find((s) => s.step === 'executeImplementation');
      expect(agent?.config).toMatchObject({ testIntegrity: 'block' });
      // The agent is told the package and version the brief concerns.
      expect(agent?.inputs.guidance).toEqual({ packageName: 'lodash', targetVersion: '4.17.21' });
    });

    it('no recipe named: the recipe step never runs and the agent does the work', async () => {
      const { d, steps } = dispatcher({});
      const payload = { packageName: undefined, recipe: undefined, targetVersion: undefined };
      const result = await runSpec(spec, base(payload), d);
      expect(result.status).toBe('SUCCESS');
      expect(names(steps)).toEqual([
        'executeImplementation',
        'runTests',
        'createOrUpdatePullRequest',
      ]);
      expect(result.result).toMatchObject({ path: 'AGENT' });
    });

    it('a refused work branch ends the run FAILED: no agent, no verification, no PR', async () => {
      const reason = 'the work branch auto/CAMPAIGN-x already exists on the host (at 0123456789ab)';
      const { d, steps } = dispatcher({
        recipe: { filesChanged: [], passed: false, refused: true, skipped: false, summary: reason },
      });
      const result = await runSpec(spec, base(), d);
      expect(result.status).toBe('FAILED');
      expect(result.result).toEqual({
        path: 'RECIPE',
        skippedReason: reason,
        verification: 'NOT_RUN',
      });
      expect(names(steps)).toEqual(['applyRecipe']);
    });

    it('a recipe step that threw (output null) still falls to the agent, not the refusal', async () => {
      const { d, steps } = dispatcher({ recipeThrows: true });
      const result = await runSpec(spec, base(), d);
      expect(result.status).toBe('SUCCESS');
      expect(names(steps)[1]).toBe('executeImplementation');
    });

    it('recipe passes with no files changed: not affected, nothing opened', async () => {
      const { d, steps } = dispatcher({
        recipe: { filesChanged: [], passed: true, skipped: false },
      });
      const result = await runSpec(spec, base(), d);
      expect(result.status).toBe('SUCCESS');
      expect(result.result).toEqual({ changed: false, path: 'NONE', verification: 'NOT_RUN' });
      expect(names(steps)).toEqual(['applyRecipe']);
    });

    it('agent makes no change: not affected, no gate and no PR', async () => {
      const { d, steps } = dispatcher({ implement: { filesChanged: [] } });
      const result = await runSpec(spec, base({ recipe: undefined }), d);
      expect(result.status).toBe('SUCCESS');
      expect(result.result).toMatchObject({ changed: false, verification: 'NOT_RUN' });
      expect(names(steps)).toEqual(['executeImplementation']);
    });

    it('failed verification gets one agent fix; a recipe change becomes RECIPE_THEN_AGENT', async () => {
      const { d, steps } = dispatcher({ verdicts: [false, true] });
      const result = await runSpec(spec, base(), d);
      expect(result.status).toBe('SUCCESS');
      expect(names(steps)).toEqual([
        'applyRecipe',
        'runTests',
        'executeGateFixImplementation',
        'runTests',
        'createOrUpdatePullRequest',
      ]);
      expect(result.result).toMatchObject({ path: 'RECIPE_THEN_AGENT', verification: 'PASSED' });
      const fix = steps.find((s) => s.step === 'executeGateFixImplementation');
      expect(fix?.config).toEqual({ refuseWorkflowChanges: true, testIntegrity: 'block' });
      expect(fix?.inputs.gateName).toBe('runTests');
      // The PR carries the fix's change, not the recipe's.
      const open = steps.find((s) => s.step === 'createOrUpdatePullRequest');
      expect((open?.inputs.codeResult as { marker?: string } | undefined)?.marker).toBe('fix');
    });

    it('failed verification twice: FAILED with verification FAILED and no PR', async () => {
      const { d, steps } = dispatcher({ verdicts: [false, false] });
      const result = await runSpec(spec, base(), d);
      expect(result.status).toBe('FAILED');
      expect(result.result).toMatchObject({
        path: 'RECIPE_THEN_AGENT',
        skippedReason: expect.stringContaining('original tests'),
        verification: 'FAILED',
      });
      expect(names(steps)).not.toContain('createOrUpdatePullRequest');
      expect(steps.filter((s) => s.step === 'runTests')).toHaveLength(2);
    });

    it('an agent-made change that fails twice stays path AGENT', async () => {
      const { d } = dispatcher({
        recipe: { filesChanged: [], passed: false, skipped: false },
        verdicts: [false, false],
      });
      const result = await runSpec(spec, base(), d);
      expect(result.status).toBe('FAILED');
      expect(result.result).toMatchObject({ path: 'AGENT', verification: 'FAILED' });
    });
  });
});
