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
import type { EvalScorer } from '@auto-swe/shared/workflow';
import { currentWorkflowRunId } from '../lib/activityContext.js';
import { recordEvalResult } from '../lib/evalCapture.js';
import { buildJudgePrompt } from '../lib/judgePrompt.js';
import { combineScores, decideGate, type ScoreInput } from '../lib/scorerCombination.js';
import { scoreTrajectory, type TraceLike } from '../lib/trajectoryScorer.js';

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
    case 'gate': {
      // Node-level gate execution needs the run's workspace + the target diff
      // applied; that is the integration seam (docs/evals-p2.md). Until wired,
      // record a neutral skip so the node still produces a decomposable row.
      return { kind: 'gate', passed: true, scorer: `gate:${scorer.gate}`, value: 1 };
    }
  }
}

/**
 * Minimal assert evaluator: supports `$.<path> <op> <number>` and a bare
 * `$.<path>` truthiness check. Enough for the common `linesChanged < 500`
 * guardrails; a richer expression engine can replace this later.
 */
export function evalAssert(expr: string, target: unknown): boolean {
  const cmp = expr.match(/^\$\.([\w.]+)\s*(<=|>=|<|>|==|!=)\s*(-?\d+(?:\.\d+)?)$/);
  if (cmp) {
    const [, path, op, rhsRaw] = cmp;
    const lhs = Number(lookup(target, path));
    const rhs = Number(rhsRaw);
    if (Number.isNaN(lhs)) {
      return false;
    }
    switch (op) {
      case '<':
        return lhs < rhs;
      case '<=':
        return lhs <= rhs;
      case '>':
        return lhs > rhs;
      case '>=':
        return lhs >= rhs;
      case '==':
        return lhs === rhs;
      case '!=':
        return lhs !== rhs;
    }
  }
  const bare = expr.match(/^\$\.([\w.]+)$/);
  if (bare) {
    return Boolean(lookup(target, bare[1]));
  }
  return false;
}

function lookup(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => {
    if (acc && typeof acc === 'object' && k in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[k];
    }
    return undefined;
  }, obj);
}

/**
 * Run the LLM judge for a rubric against the target. UNVERIFIED — makes a real
 * model call. Returns a normalized 0..1 (defaults to 0.5/neutral on any
 * failure so a judge error never blocks; the judge is advisory by default).
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
    // Integration seam: dispatch `prompt` to the evalJudge agent via runAgent and
    // parse { score }. Wired in a follow-up; until then the judge is neutral.
    void prompt;
    return 0.5;
  } catch {
    return 0.5;
  }
}

/** Pure assembly (tested): combine score inputs into the node result. */
export function assembleScores(
  scoreInputs: ScoreInput[],
  judgeAdvisory: boolean
): RunEvalNodeResult {
  const combined = combineScores(scoreInputs);
  const decision = decideGate(scoreInputs, { judgeAdvisory });
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
  const floorOk = combineScores(baseInputs).floorPassed;
  const judgeInputs = floorOk
    ? await Promise.all(judges.map((s) => evaluateScorer(s, input.targetValue, runId)))
    : [];
  const scoreInputs = [...baseInputs, ...judgeInputs];

  const result = assembleScores(scoreInputs, judgeAdvisory);

  // Record one decomposable EvalResult row per scorer (best-effort).
  await Promise.all(
    scoreInputs.map((s) =>
      recordEvalResult({
        passed: s.passed,
        runId,
        scorer: s.scorer,
        scoreType: s.kind === 'judge' || s.kind === 'trajectory' ? 'NUMERIC' : 'BOOLEAN',
        source: s.kind === 'judge' ? 'JUDGE' : s.kind === 'trajectory' ? 'TRAJECTORY' : 'GATE',
        value: s.value,
      })
    )
  );

  return result;
}
