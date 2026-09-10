/**
 * `runEvalNode` activity — P2 of the evals feature (docs/evals-p2.md WS1).
 *
 * Executes an `eval` workflow node's scorers against a target value, combines
 * them via the tested floor→rank→per-axis model (scorerCombination), records a
 * per-scorer EvalResult row, and returns an aggregate for `cond` branching.
 *
 * Verification status: the COMBINATION + decision + persistence + `assert` +
 * `trajectory` paths are unit-tested (combineScores/decideGate/scoreTrajectory).
 * The `judge` path makes a real LLM call (unverifiable without keys) and the
 * `gate` path needs a workspace+diff (the node-level execution seam) — both are
 * wired but marked. Pure assembly is split into `assembleScores` so the wiring
 * is testable with injected scorer outcomes.
 */

import { prisma } from '@auto-swe/shared/db';
import {
  type RegexTarget,
  resolveRegexBudgetMs,
  runRegexBatch,
  toRegexSpecs,
} from '@auto-swe/shared/lib/regexExec';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { type Context, type EvalScorer, evalBoolean } from '@auto-swe/shared/workflow';
import { z } from 'zod';
import { currentWorkflowRunId } from '../lib/activityContext.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import type { ModelBackedAgentKey } from '../lib/config/types.js';
import { recordEvalResult } from '../lib/evalCapture.js';
import { buildJudgePrompt } from '../lib/judgePrompt.js';
import { resolveAutonomyPolicy } from '../lib/resolveAutonomyPolicy.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import {
  combineScores,
  decideGate,
  evaluateFloor,
  type ScoreInput,
} from '../lib/scorerCombination.js';
import { scoreTrajectory, type TraceLike } from '../lib/trajectoryScorer.js';
import type { GateName } from './qualityGates.js';
import { runAgent } from './runAgent.js';
import { runGateStandalone } from './standaloneGateRunner.js';

/** Scorer kind → the EvalResult source it records under. */
const SCORER_KIND_SOURCE: Record<
  EvalScorer['kind'],
  'GATE' | 'ASSERT' | 'JUDGE' | 'TRAJECTORY' | 'POLICY' | 'PII'
> = {
  assert: 'ASSERT',
  gate: 'GATE',
  judge: 'JUDGE',
  pii: 'PII',
  policy: 'POLICY',
  trajectory: 'TRAJECTORY',
};

export interface RunEvalNodeInput {
  targetValue: unknown;
  scorers: EvalScorer[];
  judgeAdvisory?: boolean;
  spanName?: string;
}

export interface RunEvalNodeResult {
  score: number;
  floorPassed: boolean;
  perAxis: Record<string, number>;
  decision: { blocked: boolean; reason: string };
}

/** Evaluate one scorer against the target → a normalized ScoreInput. */
async function evaluateScorer(
  scorer: EvalScorer,
  targetValue: unknown,
  runId: string | undefined
): Promise<ScoreInput> {
  switch (scorer.kind) {
    case 'assert': {
      const passed = evalAssert(scorer.expr, targetValue);
      return { kind: 'assert', passed, scorer: `assert:${scorer.expr}`, value: passed ? 1 : 0 };
    }
    case 'trajectory': {
      const traces = runId
        ? ((await prisma.agentTrace.findMany({
            select: { error: true, toolName: true, type: true },
            where: { runId },
          })) as TraceLike[])
        : [];
      const m = scoreTrajectory(traces);
      return { kind: 'trajectory', scorer: 'trajectory:toolCorrectness', value: m.toolCorrectness };
    }
    case 'judge': {
      const value = await runJudge(scorer.rubricRef, targetValue);
      return { kind: 'judge', scorer: `judge:${scorer.rubricRef}`, value };
    }
    case 'policy': {
      if (!runId) {
        return { kind: 'policy', passed: false, scorer: `policy:${scorer.riskClass}`, value: 0 };
      }
      const run = await prisma.workflowRun.findUnique({
        include: { template: { select: { teamId: true } } },
        where: { id: runId },
      });
      const policy = await resolveAutonomyPolicy(
        run?.templateId ?? '',
        run?.template?.teamId ?? null,
        scorer.riskClass
      );
      const rule = policy.rules[scorer.riskClass] ?? { action: 'require_approval' };
      const passed = rule.action === 'auto';
      return {
        kind: 'policy',
        passed,
        scorer: `policy:${scorer.riskClass}`,
        value: passed ? 1 : 0,
      };
    }
    case 'pii': {
      const text = typeof targetValue === 'string' ? targetValue : JSON.stringify(targetValue);
      const rows = await prisma.scannerPattern.findMany({
        orderBy: { label: 'asc' },
        where: { isActive: true, type: 'PII' },
      });
      const entries = [] as { flags: string; label: string; source: string }[];
      for (const r of rows) {
        try {
          new RegExp(r.pattern, r.flags);
        } catch {
          console.error(`[pii] skipping invalid pattern '${r.label}': invalid regex`);
          continue;
        }
        entries.push({ flags: r.flags, label: r.label, source: r.pattern });
      }
      const specs = toRegexSpecs(entries, 'pii:');
      const target: RegexTarget = { key: 'target', text };
      const budgetMs = await resolveRegexBudgetMs();
      const result = await runRegexBatch(specs, [target], { budgetMs, label: 'piiScan' });
      const passed = result.hits.length === 0 && !result.incomplete;
      return { kind: 'pii', passed, scorer: 'pii:pii', value: passed ? 1 : 0 };
    }
    case 'gate': {
      // A `gate` is a floor scorer: it must PASS for the candidate to be
      // accepted. When the gate cannot actually verify the candidate (no linked
      // run, missing connection/ticket, clone/exec failure) it must FAIL SAFE —
      // recording it as a pass would silently green-light unverified code, the
      // exact false-confidence failure mode the eval system exists to prevent
      // (RFC §9). So every non-executable path returns passed:false.
      const gateFailed: ScoreInput = {
        kind: 'gate',
        passed: false,
        scorer: `gate:${scorer.gate}`,
        value: 0,
      };
      if (!runId) {
        return gateFailed;
      }
      try {
        const run = await prisma.workflowRun.findUnique({
          select: { workRequest: { select: { connectionId: true, externalTicketId: true } } },
          where: { id: runId },
        });
        const { connectionId, externalTicketId } = run?.workRequest ?? {};
        if (!connectionId || !externalTicketId) {
          return gateFailed;
        }
        const repo = await prisma.connection.findUniqueOrThrow({
          include: { installation: { select: { installationId: true } } },
          where: { id: connectionId },
        });
        const defaults = await resolveWorkflowDefaults();
        const branch = `${defaults.branchPrefix}/${externalTicketId}`;
        const repoRef = toRepoRef(repo);
        const { authedCloneUrl } = await getScmProvider(repoRef).cloneCredentials(repoRef);
        const result = await runGateStandalone({
          authedRepoUrl: authedCloneUrl,
          branch,
          command: scorer.command,
          defaultBranch: repo.defaultBranch,
          // Score the candidate's already-pushed branch (not a fresh branch cut
          // from defaultBranch), on the repo's configured toolchain image.
          existingBranch: true,
          gate: scorer.gate as GateName,
          image: repo.executorImage ?? undefined,
        });
        return {
          kind: 'gate',
          passed: result.passed,
          scorer: `gate:${scorer.gate}`,
          value: result.passed ? 1 : 0,
        };
      } catch {
        return gateFailed;
      }
    }
  }
}

/**
 * Evaluate an assert expression against the target. Reuses the interpreter's
 * expression engine (`evalBoolean`, the same grammar `cond` nodes use) rather
 * than a second hand-rolled evaluator — so `$.linesChanged < 500`, boolean
 * logic, nested paths, etc. all behave identically. Malformed expressions
 * evaluate to `false` (a failed assert) rather than throwing.
 */
export function evalAssert(expr: string, target: unknown): boolean {
  try {
    // Eval-node asserts use a `$.`-prefixed path convention (e.g.
    // `$.linesChanged < 500`); the shared engine uses bare dotted paths, so
    // strip the prefix before delegating.
    return evalBoolean(expr.replace(/\$\./g, ''), (target ?? {}) as Context);
  } catch {
    return false;
  }
}

const JudgeOutput = z.object({
  rationale: z.string().optional(),
  score: z.number().min(0).max(1),
});

/**
 * Run the LLM judge for a rubric against the target via the `evalJudge` agent.
 * Returns a normalized 0..1 — defaults to 0.5/neutral on any failure (missing
 * rubric, agent error, unparseable output) so a judge error never blocks (the
 * judge is advisory by default). Makes a real model call; the model resolution
 * is verified by `assertConfigReady` at worker boot, but the call itself is only
 * exercised end-to-end against a provider.
 */
async function runJudge(rubricRef: string, targetValue: unknown): Promise<number> {
  try {
    const rubric = await prisma.evalRubric.findFirst({
      orderBy: { version: 'desc' },
      where: { slug: rubricRef },
    });
    if (!rubric) {
      return 0.5;
    }
    const prompt = buildJudgePrompt({
      candidate: typeof targetValue === 'string' ? targetValue : JSON.stringify(targetValue),
      rubric: rubric.promptText,
    });
    const ctx = await currentRequestContext();
    const spec = await resolveAgentSpec(
      {
        agentKey: 'evalJudge' as ModelBackedAgentKey,
        basePrompt: '',
        outputSchema: JudgeOutput,
        promptOverride: prompt.system,
      },
      ctx
    );
    const result = await runAgent<z.infer<typeof JudgeOutput>>(spec, prompt.user, {
      spanName: 'llm.eval_judge',
    });
    const score = result.object?.score;
    return typeof score === 'number' ? Math.max(0, Math.min(1, score)) : 0.5;
  } catch {
    return 0.5;
  }
}

/** Pure assembly (tested): combine score inputs into the node result. */
export function assembleScores(
  scoreInputs: ScoreInput[],
  judgeAdvisory: boolean,
  judgeThreshold?: number
): RunEvalNodeResult {
  const combined = combineScores(scoreInputs);
  const decision = decideGate(scoreInputs, { judgeAdvisory, judgeThreshold });
  return {
    decision: { blocked: decision.blocked, reason: decision.reason },
    floorPassed: combined.floorPassed,
    perAxis: combined.perAxis,
    score: combined.aggregate,
  };
}

export async function runEvalNode(input: RunEvalNodeInput): Promise<RunEvalNodeResult> {
  const runId = await currentWorkflowRunId();
  const judgeAdvisory = input.judgeAdvisory ?? true;

  // Floor scorers first; short-circuit the judge if the floor fails (saves the
  // LLM call). Evaluate non-judge scorers, then judge only when the floor holds.
  const nonJudge = input.scorers.filter((s) => s.kind !== 'judge');
  const judges = input.scorers.filter((s) => s.kind === 'judge');
  const baseInputs = await Promise.all(
    nonJudge.map((s) => evaluateScorer(s, input.targetValue, runId))
  );
  const floorOk = evaluateFloor(baseInputs);
  const judgeInputs = floorOk
    ? await Promise.all(judges.map((s) => evaluateScorer(s, input.targetValue, runId)))
    : [];
  const scoreInputs = [...baseInputs, ...judgeInputs];

  // DB-backed judge threshold (workflow_defaults) drives the blocking-judge
  // gate; `assembleScores`/`decideGate` keep 0.5 as the last-resort fallback.
  const { evalJudgeThreshold } = await resolveWorkflowDefaults();
  const result = assembleScores(scoreInputs, judgeAdvisory, evalJudgeThreshold);

  // Record one decomposable EvalResult row per scorer (best-effort).
  await Promise.all(
    scoreInputs.map((s) =>
      recordEvalResult({
        passed: s.passed,
        runId,
        scorer: s.scorer,
        scoreType: s.kind === 'judge' || s.kind === 'trajectory' ? 'NUMERIC' : 'BOOLEAN',
        source: SCORER_KIND_SOURCE[s.kind],
        value: s.value,
      })
    )
  );

  return result;
}
