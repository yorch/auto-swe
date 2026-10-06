import {
  type EvalDatasetDetail,
  type EvalDatasetSummary,
  type EvalResultDto,
  type EvalRunDto,
  IMPLEMENTER_RUNTIMES,
  type ImplementerRuntimeKind,
} from '@auto-swe/shared/types/api';
import { apiRequest, apiRequestFull, runWithExitCodes, UNKNOWN_SUBCOMMAND } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';
import { parseFlags } from '../lib/flags.js';
import { sleep } from '../lib/time.js';

const SUB_HELP = `auto-swe evals — inspect eval datasets and run the regression gate

  evals list                          List eval datasets
  evals show <id>                     Print a dataset's cases
  evals results [--run=<id>] [--source=GATE|REVIEW|MERGE] [--scorer=<s>] [--limit=N]
                                      Query captured eval signals
  evals run <dataset-slug> --candidate=<ref> --against=<ref>
            [--candidate-runtime=mastra|claude-code] [--against-runtime=mastra|claude-code]
                                      Start the nightly regression gate; exits 0 on SUCCESS,
                                      1 on a regression, 2 when the run fails without a verdict
                                      or the budget stopped it before every case ran. A runtime
                                      flag runs that side on the named implementer runtime
                                      instead of the workspace.implementerRuntime setting
`;

const RUN_USAGE =
  'Usage: evals run <dataset-slug> --candidate=<ref> --against=<ref> [--candidate-runtime=<runtime>] [--against-runtime=<runtime>]\n';

class UsageError extends Error {}

/** A runtime flag's value, `undefined` when absent; throws a usage message on an unknown one. */
function runtimeFlag(name: string, value: string | undefined): ImplementerRuntimeKind | undefined {
  if (value === undefined) {
    return undefined;
  }
  if ((IMPLEMENTER_RUNTIMES as readonly string[]).includes(value)) {
    return value as ImplementerRuntimeKind;
  }
  throw new UsageError(`--${name} must be one of ${IMPLEMENTER_RUNTIMES.join(', ')}`);
}

/** One side of the run as text: its ref, and the runtime it was told to run on. */
const arm = (ref: string, runtime: string | null | undefined) =>
  runtime ? `${ref} on ${runtime}` : ref;

export async function runEvalsCommand(args: string[], env: CliEnv): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  const handled = await runWithExitCodes(async () => {
    if (sub === 'list') {
      return await cmdList(env);
    }
    if (sub === 'show') {
      return await cmdShow(rest, env);
    }
    if (sub === 'results') {
      return await cmdResults(rest, env);
    }
    if (sub === 'run') {
      return await cmdRun(rest, env);
    }
    return UNKNOWN_SUBCOMMAND;
  });
  if (handled !== UNKNOWN_SUBCOMMAND) {
    return handled;
  }
  process.stderr.write(`Unknown subcommand: evals ${sub}\n${SUB_HELP}`);
  return 1;
}

// `apiRequest` already unwraps the `{ data }` envelope — type every call as
// the payload itself. Destructuring `.data` a second time returned undefined
// and made every subcommand throw.
async function cmdList(env: CliEnv): Promise<number> {
  const data = await apiRequest<EvalDatasetSummary[]>(env, 'GET', '/api/v1/platform/evals');
  if (data.length === 0) {
    process.stdout.write('No eval datasets.\n');
    return 0;
  }
  for (const d of data) {
    process.stdout.write(`${d.id}  ${d.slug}  [${d.scope}]  ${d.caseCount} cases  — ${d.name}\n`);
  }
  return 0;
}

async function cmdShow(rest: string[], env: CliEnv): Promise<number> {
  const id = rest[0];
  if (!id) {
    process.stderr.write('Usage: evals show <id>\n');
    return 1;
  }
  const data = await apiRequest<EvalDatasetDetail>(env, 'GET', `/api/v1/platform/evals/${id}`);
  process.stdout.write(`${data.name} (${data.slug}) — ${data.cases.length} cases\n`);
  for (const c of data.cases) {
    const screened = c.flakeScreened ? '✓screened' : 'unscreened';
    process.stdout.write(`  ${c.id}  ${c.repoUrl}@${c.baselineSha.slice(0, 10)}  ${screened}\n`);
  }
  return 0;
}

async function cmdRun(rest: string[], env: CliEnv): Promise<number> {
  const { flags, positional } = parseFlags(rest);
  const slug = positional[0];
  if (!slug || !flags.candidate || !flags.against) {
    process.stderr.write(RUN_USAGE);
    return 1;
  }
  let candidateRuntime: ImplementerRuntimeKind | undefined;
  let baselineRuntime: ImplementerRuntimeKind | undefined;
  try {
    candidateRuntime = runtimeFlag('candidate-runtime', flags['candidate-runtime']);
    baselineRuntime = runtimeFlag('against-runtime', flags['against-runtime']);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n${RUN_USAGE}`);
      return 1;
    }
    throw err;
  }
  // Resolve slug → id.
  const datasets = await apiRequest<EvalDatasetSummary[]>(env, 'GET', '/api/v1/platform/evals');
  const ds = datasets.find((d) => d.slug === slug);
  if (!ds) {
    process.stderr.write(`No dataset with slug '${slug}'\n`);
    return 1;
  }
  const started = await apiRequest<EvalRunDto>(env, 'POST', '/api/v1/platform/evals/runs', {
    baselineRef: flags.against,
    ...(baselineRuntime ? { baselineRuntime } : {}),
    candidateRef: flags.candidate,
    ...(candidateRuntime ? { candidateRuntime } : {}),
    datasetId: ds.id,
  });
  process.stdout.write(
    `Started eval run ${started.id} (${slug}: ${arm(flags.candidate, candidateRuntime)} vs ${arm(flags.against, baselineRuntime)})\n`
  );

  // Poll for the verdict. The harness is the integration seam; this loop is how
  // the nightly CI gates on the result.
  const deadline = Date.now() + 4 * 60 * 60 * 1000; // 4h
  for (;;) {
    const run = await apiRequest<EvalRunDto>(
      env,
      'GET',
      `/api/v1/platform/evals/runs/${started.id}`
    );
    if (run.status !== 'RUNNING') {
      const summary = (run.summary ?? {}) as EvalRunSummary;
      process.stdout.write(`${summary.summary ?? run.status}\n`);
      if (summary.runtimes) {
        process.stdout.write(
          `Runtimes: candidate ${summary.runtimes.candidate.join(', ') || '—'}, baseline ${summary.runtimes.baseline.join(', ') || '—'}\n`
        );
      }
      if (summary.partial) {
        const { completedCases, error, totalCases } = summary.partial;
        process.stdout.write(
          `Partial verdict: ${completedCases} of ${totalCases} cases ran — ${error ?? 'stopped early'}\n`
        );
      }
      return evalRunExitCode(run.status, summary.partial != null);
    }
    if (Date.now() > deadline) {
      process.stderr.write('Timed out waiting for the eval run\n');
      return 2;
    }
    await sleep(15_000);
  }
}

/** The part of `EvalRun.summary` the gate reads. */
interface EvalRunSummary {
  summary?: string;
  /** The implementer runtimes each side actually ran on. */
  runtimes?: { baseline: string[]; candidate: string[] };
  /** Set when the runless budget stopped the run before every case ran. */
  partial?: { completedCases: number; totalCases: number; error?: string };
}

/**
 * Only a complete SUCCESS passes the gate. REGRESSION is the documented 1 —
 * also when partial, since the cases that ran already regressed. Any other
 * terminal status (FAILED — the harness crashed or was cancelled) means no
 * verdict was reached, and a partial SUCCESS covers only the cases the budget
 * reached; a CI gate must read neither as a pass, so both are 2.
 */
export function evalRunExitCode(status: string, partial = false): number {
  if (status === 'SUCCESS') {
    return partial ? 2 : 0;
  }
  if (status === 'REGRESSION') {
    return 1;
  }
  return 2;
}

async function cmdResults(rest: string[], env: CliEnv): Promise<number> {
  const { flags } = parseFlags(rest);
  const qs = new URLSearchParams();
  if (flags.run) {
    qs.set('runId', flags.run);
  }
  if (flags.source) {
    qs.set('source', flags.source);
  }
  if (flags.scorer) {
    qs.set('scorer', flags.scorer);
  }
  qs.set('limit', flags.limit ?? '50');
  // The results endpoint returns `meta.total` beside `data`, so read the full
  // envelope here rather than the unwrapped payload.
  const { data, meta } = await apiRequestFull<{
    data: EvalResultDto[];
    meta: { total: number };
  }>(env, 'GET', `/api/v1/platform/evals/results?${qs.toString()}`);
  if (data.length === 0) {
    process.stdout.write('No eval results.\n');
    return 0;
  }
  for (const r of data) {
    const val = r.scoreType === 'BOOLEAN' ? (r.value >= 1 ? 'pass' : 'fail') : r.value.toFixed(2);
    // The runtime is recorded on offline harness rows only.
    const runtime = r.runtime ? `  ${r.runtime}` : '';
    process.stdout.write(
      `${r.createdAt}  ${r.source.padEnd(6)}  ${r.scorer.padEnd(24)}  ${val}${runtime}\n`
    );
  }
  process.stdout.write(`(${data.length} of ${meta.total})\n`);
  return 0;
}
