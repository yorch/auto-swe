/**
 * Offline eval harness — P1 of the evals feature (docs/evals-p1.md WS4).
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
import { createImplementerAgent } from '../agents/implementer.js';
import { IMPLEMENTER_SYSTEM_PROMPT } from '../agents/prompts.js';
import { parseAgentRef } from '../lib/config/agentRef.js';
import { resolveAgent } from '../lib/config/agentResolver.js';
import { resolveAgentMcpUrl } from '../lib/config/mcpConnection.js';
import type { ResolveCtx } from '../lib/config/types.js';
import { recordEvalResult } from '../lib/evalCapture.js';
import { type PairedOutcome, regressionVerdict } from '../lib/evalStats.js';
import { type LanguageModel, resolveModel } from '../lib/models.js';
import { createWorkspace, type Workspace } from './workspace.js';

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
  // Quarantined cases (stale references — P3 re-validation) are excluded from the
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
  await prisma.evalRun
    .update({
      data: { endedAt: new Date(), status, summary: summary as object },
      where: { id: evalRunId },
    })
    .catch(() => undefined);
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
 */
export async function runCaseDefault(caseRow: EvalCaseRow, ref: string): Promise<0 | 1> {
  const parsed = parseAgentRef(ref);
  const ctx: ResolveCtx =
    parsed.version !== undefined ? { agentVersions: { [parsed.key]: parsed.version } } : {};

  // Attempt cap comes from the DB-backed workflow defaults (falls back to 3).
  // Resolved once per case-arm — not a hot path (each iteration is a Docker +
  // LLM boundary).
  const maxEvalIterations = (await resolveWorkflowDefaults()).maxEvalIterations;

  let workspace: Workspace | undefined;
  let closeMcp: (() => Promise<void>) | undefined;
  try {
    workspace = await createWorkspace(
      caseRow.repoUrl,
      'eval-candidate',
      'main',
      'node:24-alpine',
      caseRow.baselineSha
    );

    const resolved = await resolveAgent(parsed.key, ctx);
    const model: LanguageModel = resolveModel(
      resolved.model.spec,
      resolved.model.apiKey,
      resolved.model.apiBase
    );
    const mcpServerRef = await resolveAgentMcpUrl(parsed.key, ctx);
    const built = await createImplementerAgent(
      workspace,
      undefined,
      resolved.toolKeys,
      resolved.skills,
      { mcpServerRef },
      model
    );
    closeMcp = built.closeMcp;

    const basePrompt = resolved.model.systemPrompt ?? IMPLEMENTER_SYSTEM_PROMPT;
    const systemPrompt = built.promptSuffix ? `${basePrompt}\n\n${built.promptSuffix}` : basePrompt;
    const taskDescription =
      typeof caseRow.input === 'string' ? caseRow.input : JSON.stringify(caseRow.input);

    let lastTestOutput = '';
    for (let i = 0; i < maxEvalIterations; i++) {
      const userMessage = JSON.stringify({
        description: taskDescription,
        iteration: i,
        ...(i > 0 ? { previousTestOutput: lastTestOutput.slice(-4000) } : {}),
      });
      await built.agent.generate(
        [
          { content: systemPrompt, role: 'system' as const },
          { content: userMessage, role: 'user' as const },
        ],
        { toolChoice: 'auto' as const }
      );
      const gt = await workspace.execCapture(caseRow.goldenTest);
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
    await closeMcp?.();
    await workspace?.destroy();
  }
}

/**
 * Run the harness. Persists per-case rows + the run verdict; returns the
 * RegressionVerdict for the caller (CLI exit code / nightly gate).
 */
export async function runEvalHarness(input: HarnessInput, deps: HarnessDeps) {
  const record = deps.record ?? recordEvalResult;
  const finalize = deps.finalize ?? defaultFinalize;
  const cases = await deps.loadCases(input.datasetId);

  const pairs: PairedOutcome[] = [];
  for (const c of cases) {
    const [baseline, candidate] = await Promise.all([
      deps.runCase(c, input.baselineRef),
      deps.runCase(c, input.candidateRef),
    ]);
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
  });
  return verdict;
}

export const _defaults = { defaultFinalize, defaultLoadCases };

/**
 * Temporal activity entry: run the harness with the real DB + Docker deps. The
 * durable `EvalRunWorkflow` proxies this; the per-case execution (workspace at
 * the pinned SHA + golden test) happens here, not in the workflow isolate.
 */
export async function runEvalHarnessActivity(input: HarnessInput): Promise<void> {
  try {
    await runEvalHarness(input, {
      loadCases: defaultLoadCases,
      runCase: runCaseDefault,
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
