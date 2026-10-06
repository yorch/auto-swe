/**
 * Offline eval harness (docs/evals.md §3).
 *
 * Orchestrates a candidate-vs-baseline comparison over a frozen benchmark:
 * for each case it obtains a binary floor outcome (golden test pass/fail) under
 * both arms, persists per-case `EvalResult` rows, and computes the paired,
 * error-barred regression verdict (evalStats). It writes the `EvalRun` summary
 * and marks the run SUCCESS / REGRESSION.
 *
 * The per-case execution (provision a fixture at its pinned SHA, run the
 * candidate/baseline implementer, run the golden test) is the expensive
 * Docker + LLM boundary — it is injected as `deps.runCase` so this orchestration
 * is deterministic and unit-testable. `runCaseDefault` (the real path) provisions
 * the fixture, runs the version-pinned implementer in a TDD loop, and scores the
 * golden test; infrastructure errors throw (marking the run FAILED) rather than
 * scoring a false 0.
 */

import { prisma } from '@auto-swe/shared/db';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { ApplicationFailure } from '@temporalio/activity';
import { runImplementerTurn } from '../agents/implementerRuntime.js';
import {
  buildImplementerTurnRunner,
  type ImplementerTurnRunner,
} from '../agents/implementerRuntimeSelect.js';
import { IMPLEMENTER_SYSTEM_PROMPT } from '../agents/prompts.js';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { parseAgentRef } from '../lib/config/agentRef.js';
import { resolveAgent } from '../lib/config/agentResolver.js';
import type { ResolveCtx } from '../lib/config/types.js';
import { assertBudgetAvailable } from '../lib/costTracking.js';
import { recordEvalResult } from '../lib/evalCapture.js';
import { type PairedOutcome, regressionVerdict } from '../lib/evalStats.js';
import { recordRunFinalized } from '../lib/metrics.js';
import { withRunlessCapScale } from '../lib/runlessBudget.js';
import { ownerOfDataset, withSpendOwner } from '../lib/spendOwner.js';
import { createWorkspace, type Workspace } from './workspace.js';

/**
 * Base image for eval workspaces — pinned, and the only `createWorkspace` call
 * in the codebase that does not inherit the operator's configured image.
 *
 * That is the same frozen-fixture reasoning as `EvalCase.baselineSha`: a
 * benchmark score is comparable against its own history only if the environment
 * it ran in did not move. So this workspace deliberately ignores the
 * connection's `executorImage` and the `WORKSPACE_IMAGE` default, both of
 * which an operator can change at any time.
 *
 * Changing this constant silently rebases every stored eval score onto a
 * different environment — regressions and improvements measured across the
 * change are not comparable. Treat it as a benchmark epoch, not a config knob:
 * if it must move, expect to re-baseline.
 *
 * It is a named constant rather than an inline literal so the shape of the
 * exception is greppable, and so `scripts/check-invariants.mjs` can hold every
 * other call site to inheriting without maintaining a list of exemptions.
 */
export const EVAL_WORKSPACE_IMAGE = 'node:24-alpine';

export interface EvalCaseRow {
  id: string;
  repoUrl: string;
  baselineSha: string;
  goldenTest: string;
  tags: string[];
  input: unknown; // EvalCase.input (Json) — task/prompt payload for the implementer
}

export interface HarnessInput {
  evalRunId: string;
  datasetId: string;
  candidateRef: string;
  baselineRef: string;
}

export interface HarnessDeps {
  /** Resolve the dataset's cases. */
  loadCases: (datasetId: string) => Promise<EvalCaseRow[]>;
  /** Run one case under one arm; returns 1 (floor passed) or 0 (failed). */
  runCase: (caseRow: EvalCaseRow, ref: string) => Promise<0 | 1>;
  /** Persist one normalized signal (defaults to the real capture writer). */
  record?: typeof recordEvalResult;
  /** Finalize the EvalRun row. */
  finalize?: (evalRunId: string, status: string, summary: unknown) => Promise<void>;
}

async function defaultLoadCases(datasetId: string): Promise<EvalCaseRow[]> {
  // Quarantined cases (stale references — see re-validation in docs/evals.md) are excluded from the
  // gate so a dataset that has rotted doesn't fail candidates for non-agent reasons.
  return prisma.evalCase.findMany({
    select: {
      baselineSha: true,
      goldenTest: true,
      id: true,
      input: true,
      repoUrl: true,
      tags: true,
    },
    where: { datasetId, quarantined: false },
  });
}

async function defaultFinalize(evalRunId: string, status: string, summary: unknown): Promise<void> {
  // `endedAt: null`: a run is finalized once, so the verdict is counted once.
  const { count } = await prisma.evalRun
    .updateMany({
      data: { endedAt: new Date(), status, summary: summary as object },
      where: { endedAt: null, id: evalRunId },
    })
    .catch(() => ({ count: 0 }));
  if (count > 0) {
    recordRunFinalized(status, 'eval');
  }
}

/**
 * Runs the implementer at the agent version specified by `ref` against the
 * frozen fixture, then checks `goldenTest`. Returns 1 when the golden test
 * passes within the workflow-defaults eval-iteration cap, 0 when it
 * consistently fails.
 *
 * A `0` means a genuine floor failure (the agent's code did not make the golden
 * test pass). Infrastructure/config errors — Docker provisioning, agent/model
 * resolution, MCP, LLM transport — are NOT scored as 0: they THROW so the
 * harness marks the whole EvalRun FAILED rather than silently recording a false
 * regression (or, if both arms fail symmetrically, a false "no regression").
 * This is the RFC §9 rule: report infra failures separately from quality
 * failures, never let them poison the headline metric.
 *
 * `ref` format: `"<agentKey>"` (float to latest active) or
 * `"<agentKey>@<version>"` (pin exact version). The version pin flows into
 * model, system prompt, skills, and tool selection via `resolveAgent`.
 *
 * `scope` is the dataset's tenant (its team and organization). Every setting and
 * Agent row resolves in it, so a TEAM or ORGANIZATION override — the runtime,
 * the step budget, the agent version itself — is what the eval grades, as it
 * is what that tenant's production runs get. Omitted, the case resolves at
 * GLOBAL scope, which is right only for a GLOBAL dataset.
 */
export async function runCaseDefault(
  caseRow: EvalCaseRow,
  ref: string,
  scope: Pick<ResolveCtx, 'orgId' | 'teamId'> = {}
): Promise<0 | 1> {
  const parsed = parseAgentRef(ref);
  const ctx: ResolveCtx = {
    ...(scope.teamId ? { teamId: scope.teamId } : {}),
    ...(scope.orgId ? { orgId: scope.orgId } : {}),
    ...(parsed.version !== undefined ? { agentVersions: { [parsed.key]: parsed.version } } : {}),
  };

  // Attempt cap comes from the DB-backed workflow defaults (falls back to 3).
  // Resolved once per case-arm — not a hot path (each iteration is a Docker +
  // LLM boundary).
  const maxEvalIterations = (await resolveWorkflowDefaults()).maxEvalIterations;

  // Every implementer run in the harness is traced like any other (tool calls,
  // responses, test runs) and goes through `assertBudgetAvailable` /
  // `recordLlmUsage`. An eval workflow has no `ActiveWorkflow` ledger row and no
  // run, so both hold it to the runless cap (`workflow.runlessMax*Tokens`, scaled
  // by the dataset's case count in `runEvalHarness`), summed over the whole eval
  // execution from its trace rows.
  const tracer = new AgentTracer();
  let workspace: Workspace | undefined;
  let turns: ImplementerTurnRunner | undefined;
  try {
    workspace = await createWorkspace(
      caseRow.repoUrl,
      'eval-candidate',
      'main',
      EVAL_WORKSPACE_IMAGE,
      caseRow.baselineSha
    );

    // Built exactly as production builds it (`buildImplementerTurnRunner`), so the
    // eval grades what a run gets: the runtime the setting chooses, the tool keys
    // with persona narrowing, the skills, the MCP binding with its headers and
    // private-network opt-in, and the step and tool-output budgets — an eval run
    // under different conditions than production is not measuring production.
    // Chosen once for the whole case: a runtime that resumes its session across
    // iterations must not be rebuilt per iteration.
    turns = await buildImplementerTurnRunner({ agentKey: parsed.key, ctx, tracer, workspace });
    // The model spec the turn is priced at and the version's own system prompt.
    const resolved = await resolveAgent(parsed.key, ctx);

    const systemPrompt = turns.systemPrompt(
      resolved.model.systemPrompt ?? IMPLEMENTER_SYSTEM_PROMPT
    );
    const taskDescription =
      typeof caseRow.input === 'string' ? caseRow.input : JSON.stringify(caseRow.input);

    let lastTestOutput = '';
    for (let i = 0; i < maxEvalIterations; i++) {
      const userMessage = JSON.stringify({
        description: taskDescription,
        iteration: i,
        ...(i > 0 ? { previousTestOutput: lastTestOutput.slice(-4000) } : {}),
      });
      const usageEvent = `llm.eval.${parsed.key}.iteration_${i}`;
      await assertBudgetAvailable(usageEvent);
      await runImplementerTurn({
        boundModelSpec: resolved.model.spec,
        context: { caseId: caseRow.id, iteration: i, ref },
        role: parsed.key,
        runtime: turns.runtime,
        system: systemPrompt,
        tracer,
        usageEvent,
        user: userMessage,
      });

      const testStart = Date.now();
      const gt = await workspace.execCapture(caseRow.goldenTest);
      tracer.addActivityEvent({
        durationMs: Date.now() - testStart,
        inputJson: { caseId: caseRow.id, iteration: i, ref },
        name: 'eval.golden_test',
        outputJson: { exitCode: gt.exitCode, passed: gt.exitCode === 0 },
      });
      // Feed both streams back — test/lint runners print failure detail (stack
      // traces, assertion diffs, compiler errors) to stderr, so stdout alone
      // gives the next iteration an empty repair signal.
      lastTestOutput = [gt.stdout, gt.stderr].filter(Boolean).join('\n');
      if (gt.exitCode === 0) {
        return 1;
      }
    }
    return 0;
  } finally {
    await turns?.close();
    // Always — a case that threw is exactly the one whose trace is needed.
    await persistActivityTrace(tracer, parsed.key);
    await workspace?.destroy();
  }
}

/**
 * Set on a run's summary when a budget stopped it before every case ran: the
 * verdict covers only the `completedCases` that did. `reason` is `budget` for
 * the runless cap and `org_budget` when the organization's monthly USD cap
 * refused the next call.
 */
export interface PartialRunSummary {
  reason: 'budget' | 'org_budget';
  /** The `BUDGET_EXCEEDED` message that stopped the run. */
  error: string;
  completedCases: number;
  totalCases: number;
  /** Cases with no paired outcome — the one the budget stopped, and every one after it. */
  notRunCaseIds: string[];
}

const isBudgetExceeded = (err: unknown) =>
  err instanceof ApplicationFailure && err.type === 'BUDGET_EXCEEDED';

/** `BUDGET_EXCEEDED` raised by the organization's monthly USD cap, not the runless cap. */
const isOrgBudgetStop = (err: unknown) =>
  err instanceof ApplicationFailure &&
  (err.details?.[0] as { cap?: unknown } | undefined)?.cap === 'organization';

/**
 * Run the harness. Persists per-case rows + the run verdict; returns the
 * RegressionVerdict for the caller (CLI exit code / nightly gate).
 *
 * The whole execution shares one runless cap, scaled by the case count. When it
 * runs out part-way, the cases already paired still carry a verdict: the run
 * finishes over them with `summary.partial` set, rather than failing and
 * discarding paid-for work. Once the cap is spent no later case could run, so
 * the harness stops there. A budget stop before any case completed, and any
 * other error, still fails the run.
 */
export async function runEvalHarness(input: HarnessInput, deps: HarnessDeps) {
  const record = deps.record ?? recordEvalResult;
  const finalize = deps.finalize ?? defaultFinalize;
  const cases = await deps.loadCases(input.datasetId);

  return withRunlessCapScale(cases.length, async () => {
    const pairs: PairedOutcome[] = [];
    let partial: PartialRunSummary | undefined;
    for (const [index, c] of cases.entries()) {
      // Settled, not `all`: an arm that fails must not leave the other running
      // (and spending) unobserved.
      const [baselineArm, candidateArm] = await Promise.allSettled([
        deps.runCase(c, input.baselineRef),
        deps.runCase(c, input.candidateRef),
      ]);
      if (baselineArm.status === 'rejected' || candidateArm.status === 'rejected') {
        const reasons = [baselineArm, candidateArm].flatMap((a) =>
          a.status === 'rejected' ? [a.reason] : []
        );
        // An infrastructure error outranks a budget stop: it is not a budget fact.
        const failure = reasons.find((r) => !isBudgetExceeded(r)) ?? reasons[0];
        if (!isBudgetExceeded(failure) || pairs.length === 0) {
          throw failure;
        }
        partial = {
          completedCases: pairs.length,
          error: failure instanceof Error ? failure.message : String(failure),
          notRunCaseIds: cases.slice(index).map((r) => r.id),
          reason: isOrgBudgetStop(failure) ? 'org_budget' : 'budget',
          totalCases: cases.length,
        };
        break;
      }
      const baseline = baselineArm.value;
      const candidate = candidateArm.value;
      pairs.push({ baseline, candidate, caseId: c.id, tags: c.tags });

      // Record the candidate's floor outcome as the gate signal for this run.
      await record({
        caseId: c.id,
        evalRunId: input.evalRunId,
        metadata: { tags: c.tags },
        passed: candidate === 1,
        scorer: 'gate:runTests',
        scoreType: 'BOOLEAN',
        source: 'GATE',
        value: candidate,
      });
    }

    const verdict = regressionVerdict(pairs);
    await finalize(input.evalRunId, verdict.regression ? 'REGRESSION' : 'SUCCESS', {
      byTag: verdict.byTag,
      overall: verdict.overall,
      summary: verdict.summary,
      ...(partial ? { partial } : {}),
    });
    return verdict;
  });
}

export const _defaults = { defaultFinalize, defaultLoadCases };

/**
 * Temporal activity entry: run the harness with the real DB + Docker deps. The
 * durable `EvalRunWorkflow` proxies this; the per-case execution (workspace at
 * the pinned SHA + golden test) happens here, not in the workflow isolate.
 */
export async function runEvalHarnessActivity(input: HarnessInput): Promise<void> {
  try {
    // No run row: the spend is the dataset's owner's, and the dataset's tenant is
    // the scope every case resolves its settings and Agent rows in.
    const owner = ownerOfDataset(input.datasetId);
    await withSpendOwner(owner, async () => {
      const scope = await owner;
      return runEvalHarness(input, {
        loadCases: defaultLoadCases,
        runCase: (caseRow, ref) => runCaseDefault(caseRow, ref, scope),
      });
    });
  } catch (err) {
    // Mark the run FAILED (not stuck RUNNING / not a false SUCCESS) and re-throw
    // so Temporal records the failure.
    await defaultFinalize(input.evalRunId, 'FAILED', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
