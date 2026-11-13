import { CAMPAIGN_UPGRADE_PROMPT } from '../../lib/agentPrompts.js';
import { CAMPAIGN_RECIPE_REFS } from '../../lib/campaignRecipes.js';
import type { InputSchema } from '../../lib/inputSchema.js';
import { BUDGET_TIERS } from '../../types/workflow.js';
import { type Node, SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { prResult, qualityGate, terminate } from './authoring/index.js';
import { authored, macro } from './authoring/macro.js';

type StepNode = Extract<Node, { type: 'step' }>;

/**
 * The run-input contract of `dependency-upgrade-campaign`. Written out rather than spread from
 * the SWE schema, like the other built-ins that carry their own fields: a stored schema is
 * migrated only through its own `PREVIOUS_BUILTIN_INPUT_SCHEMAS` entry.
 *
 * A campaign launches every child of it with the same payload plus the child's `connectionId`.
 * `recipe`, `packageName` and `targetVersion` are optional together: a campaign with no recipe
 * is an agent-only change (a framework upgrade, say) described by the request's description.
 *
 * The patterns are the widest alphabet either ecosystem's value can use. An input pattern is
 * limited to one varying quantifier and no groups (see `inputPatternProblem`), so it cannot say
 * what `parseRecipeParams` says; it keeps a shell-significant character, a space, a leading dash
 * and the colon of a `git:` or `file:` specifier out of the run's payload. The strict shape is
 * checked again by the gateway at launch and by the worker before any command is built.
 */
export const DEPENDENCY_UPGRADE_CAMPAIGN_INPUT_SCHEMA: InputSchema = {
  properties: {
    budget: { enum: [...BUDGET_TIERS], type: 'string' },
    connectionId: { connectionType: 'git_repo', type: 'connection' },
    description: { type: 'string' },
    packageName: {
      description: 'The npm package, or the Go module path, to raise.',
      maxLength: 255,
      pattern: '[A-Za-z0-9@][A-Za-z0-9._~/-]*',
      title: 'Package',
      type: 'string',
    },
    recipe: {
      description:
        'The code-owned recipe to try first. Leave empty to have the agent make the change.',
      enum: [...CAMPAIGN_RECIPE_REFS],
      title: 'Recipe',
      type: 'string',
    },
    targetVersion: {
      description: 'The exact version to raise it to, such as 4.17.21 (npm) or v1.9.0 (Go).',
      maxLength: 128,
      pattern: '[v0-9][0-9A-Za-z.+-]*',
      title: 'Target version',
      type: 'string',
    },
    ticketId: { type: 'string' },
  },
  required: ['connectionId'],
  type: 'object',
};

/**
 * A dependency upgrade never needs a workflow or action file, and a pushed workflow runs with the
 * repository's secrets, so both agent steps refuse a change to one (and a symlink or submodule),
 * as the CI-fix templates do. The marker also puts the test-integrity guard on the step.
 */
const REFUSE_WORKFLOW_CHANGES = { refuseWorkflowChanges: true } as const;

/** The most the agent is shown of the package and version, as "guidance" under the brief. */
const UPGRADE_CONTEXT = {
  'context.upgrade.packageName': { default: '', from: 'request.payload.packageName' },
  'context.upgrade.targetVersion': { default: '', from: 'request.payload.targetVersion' },
} as const;

/** The tests are verified by the repository's ORIGINAL test files; see the `verify` step. */
const verifyGate = (next: string): Node => ({
  ...(qualityGate('runTests', next, {
    group: 'verify',
    title: 'Run the original tests',
  }) as StepNode),
  config: { protectTests: true },
});

/**
 * Apply one planned change to one repository, deterministically first. This is the template every
 * child of a campaign runs; it is also a complete workflow on its own (launch it with a package
 * and a version). It ends at a DRAFT pull request, never merges, and has no CI loop: the draft
 * and the host's CI are what a person reads.
 *
 *  1. With a recipe, a code-owned script makes the change in a sandbox. A repository the recipe
 *     does not apply to (the package is not used, or it is already at the version) ends the run
 *     SUCCESS with no pull request; a layout the recipe cannot handle falls through to the agent,
 *     having pushed nothing.
 *  2. Without a recipe, or after a recipe that could not apply, the agent makes the change. Its
 *     step refuses a change that deletes, skips or weakens tests (`testIntegrity: 'block'`). An
 *     agent that changes nothing ends the run SUCCESS, not affected, only when there was no
 *     recipe; after a recipe that could not apply it ends the run FAILED.
 *  3. Every change, from the recipe or the agent, is verified by the repository's original tests:
 *     the verification restores the test files, test support files (fixtures, mocks, golden
 *     files, helpers), runner setup files and pure test-runner configuration the branch changed,
 *     recognised by file-name convention, before it runs, in its own workspace. An edit to one of
 *     those does not count towards green; a test outside the conventions, a test setting inside a
 *     manifest, the test command, and the change's own code that the tests run are not restored
 *     (docs/campaigns.md, Limitations).
 *  4. A change that fails verification gets one agent fix, verified again. Failing twice ends the
 *     run FAILED with no pull request.
 *
 * The result reports `changed`, `path` (RECIPE, AGENT, RECIPE_THEN_AGENT or NONE) and
 * `verification` (PASSED, FAILED or NOT_RUN) for the campaign's per-repository record.
 */
export const DEPENDENCY_UPGRADE_CAMPAIGN_SPEC: WorkflowSpec = {
  description:
    'Apply one planned dependency or framework change to a repository, deterministically first. ' +
    'A code-owned recipe makes the change in a sandbox when the campaign names one, and the ' +
    'agent takes over when there is none or it cannot apply. Every change is verified against ' +
    "the repository's original tests, with the test files the change touched put back first, " +
    'and an agent that deletes, skips or weakens tests is stopped before it pushes. A failed ' +
    'verification gets one fix attempt. The run ends at a draft pull request for a person to ' +
    'review, or with nothing opened when the repository is not affected.',
  entry: 'setUpgrade',
  name: 'dependency-upgrade-campaign',
  ...authored(
    {
      setUpgrade: {
        group: 'prepare',
        next: 'checkRecipe',
        title: 'Note the package and version',
        type: 'set',
        values: { ...UPGRADE_CONTEXT },
      },
      checkRecipe: {
        expr: "(request.payload.recipe ?? '') == ''",
        group: 'prepare',
        onFalse: 'recipe',
        onTrue: 'implement',
        title: 'Is there a recipe?',
        type: 'cond',
      },
      recipe: {
        group: 'recipe',
        inputs: {
          packageName: { default: '', from: 'request.payload.packageName' },
          recipe: { default: '', from: 'request.payload.recipe' },
          targetVersion: { default: '', from: 'request.payload.targetVersion' },
        },
        next: 'checkRecipeRefused',
        onFail: 'warn',
        status: 'IMPLEMENTING',
        step: 'applyRecipe',
        title: 'Apply the recipe',
        type: 'step',
      },
      // A work branch the step did not cut from the pinned base (one that already existed on the
      // host) ends the run: neither the agent nor the verification may build on it.
      checkRecipeRefused: {
        expr: 'nodes.recipe.output.refused == true',
        group: 'recipe',
        onFalse: 'routeRecipe',
        onTrue: 'failRecipeRefused',
        title: 'Was the branch refused?',
        type: 'cond',
      },
      failRecipeRefused: terminate('FAILED', {
        group: 'recipe',
        result: {
          path: { literal: 'RECIPE' },
          skippedReason: { from: 'nodes.recipe.output.summary' },
          verification: { literal: 'NOT_RUN' },
        },
        title: 'Work branch refused',
      }),
      routeRecipe: {
        expr: 'nodes.recipe.output.passed == true',
        group: 'recipe',
        onFalse: 'implement',
        onTrue: 'routeRecipeChange',
        title: 'Did the recipe apply?',
        type: 'cond',
      },
      routeRecipeChange: {
        expr: 'nodes.recipe.output.filesChanged.length == 0',
        group: 'recipe',
        onFalse: 'saveRecipe',
        onTrue: 'doneNotAffected',
        title: 'Did it change anything?',
        type: 'cond',
      },
      saveRecipe: {
        group: 'recipe',
        next: 'verify',
        title: 'Take the recipe’s change',
        type: 'set',
        values: {
          'context.currentCodeResult': { from: 'nodes.recipe.output.codeResult' },
          'context.path': { literal: 'RECIPE' },
        },
      },
      implement: {
        config: {
          ...REFUSE_WORKFLOW_CHANGES,
          systemPrompt: CAMPAIGN_UPGRADE_PROMPT,
          testIntegrity: 'block',
        },
        group: 'implement',
        inputs: { guidance: { from: 'context.upgrade' } },
        next: 'checkChanges',
        status: 'IMPLEMENTING',
        step: 'executeImplementation',
        storeAs: 'context.currentCodeResult',
        title: 'Make the change',
        type: 'step',
      },
      checkChanges: {
        expr: 'nodes.implement.output.filesChanged.length == 0',
        group: 'implement',
        onFalse: 'saveAgent',
        onTrue: 'checkAgentOnly',
        title: 'Anything changed?',
        type: 'cond',
      },
      // An agent that changes nothing means "not affected" only when the agent was the plan. After
      // a recipe that could not apply, the recipe already found the package in use, so no change
      // means the upgrade was not made: that is a failure, never a quiet success.
      checkAgentOnly: {
        expr: "(request.payload.recipe ?? '') == ''",
        group: 'implement',
        onFalse: 'failNoChange',
        onTrue: 'doneNotAffected',
        title: 'Was the agent the only plan?',
        type: 'cond',
      },
      failNoChange: terminate('FAILED', {
        group: 'implement',
        result: {
          changed: { literal: false },
          path: { literal: 'NONE' },
          skippedReason: {
            literal:
              'the recipe could not apply, and the agent that took over made no change, so the upgrade was not made',
          },
          verification: { literal: 'NOT_RUN' },
        },
        title: 'Recipe and agent made no change',
      }),
      saveAgent: {
        group: 'implement',
        next: 'verify',
        title: 'Note that the agent made the change',
        type: 'set',
        values: { 'context.path': { literal: 'AGENT' } },
      },
      // Warn mode: a failure is a result to route on, not an error that ends the run. A
      // verification that could not restore the original tests throws instead (it must not pass).
      verify: verifyGate('checkVerify'),
      checkVerify: {
        expr: 'nodes.verify.output.passed == true',
        group: 'verify',
        onFalse: 'fixVerify',
        onTrue: 'openPR',
        title: 'Do the original tests pass?',
        type: 'cond',
      },
      fixVerify: {
        config: { ...REFUSE_WORKFLOW_CHANGES, testIntegrity: 'block' },
        group: 'verify',
        inputs: {
          gateName: { literal: 'runTests' },
          gateOutput: { from: 'nodes.verify.output' },
          previousCodeResult: { from: 'context.currentCodeResult' },
        },
        next: 'checkRecipePath',
        status: 'IMPLEMENTING',
        step: 'executeGateFixImplementation',
        storeAs: 'context.currentCodeResult',
        title: 'Fix what the original tests found',
        type: 'step',
      },
      checkRecipePath: {
        expr: "context.path == 'RECIPE'",
        group: 'verify',
        onFalse: 'reverify',
        onTrue: 'markRecipeThenAgent',
        title: 'Did a recipe make the change?',
        type: 'cond',
      },
      markRecipeThenAgent: {
        group: 'verify',
        next: 'reverify',
        title: 'Note that the agent fixed the recipe’s change',
        type: 'set',
        values: { 'context.path': { literal: 'RECIPE_THEN_AGENT' } },
      },
      reverify: verifyGate('checkReverify'),
      checkReverify: {
        expr: 'nodes.reverify.output.passed == true',
        group: 'verify',
        onFalse: 'failVerify',
        onTrue: 'openPR',
        title: 'Do the original tests pass now?',
        type: 'cond',
      },
      failVerify: terminate('FAILED', {
        group: 'verify',
        result: {
          path: { from: 'context.path' },
          skippedReason: {
            literal:
              "the change did not pass the repository's original tests, even after one fix attempt",
          },
          verification: { literal: 'FAILED' },
        },
        title: 'Verification failed',
      }),
    },
    macro('pr', 'openPullRequest@1', { draft: true, next: 'done' }),
    {
      done: terminate('SUCCESS', {
        group: 'finish',
        result: {
          ...prResult(),
          changed: { literal: true },
          path: { from: 'context.path' },
          verification: { literal: 'PASSED' },
        },
        title: 'Draft PR opened',
      }),
      // No group on the extra terminal: a second terminal in `finish` would split it in two.
      doneNotAffected: terminate('SUCCESS', {
        result: {
          changed: { literal: false },
          path: { literal: 'NONE' },
          verification: { literal: 'NOT_RUN' },
        },
        title: 'Not affected, nothing to change',
      }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
