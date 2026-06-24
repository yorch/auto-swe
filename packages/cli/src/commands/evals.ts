import type {
  EvalDatasetDetail,
  EvalDatasetSummary,
  EvalResultDto,
  EvalRunDto,
} from '@auto-swe/shared/types/api';
import { apiRequest, GatewayError } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';

const SUB_HELP = `auto-swe evals — inspect eval datasets and run the regression gate (P1)

  evals list                          List eval datasets
  evals show <id>                     Print a dataset's cases
  evals results [--run=<id>] [--source=GATE|REVIEW|MERGE] [--scorer=<s>] [--limit=N]
                                      Query captured eval signals
  evals run <dataset-slug> --candidate=<ref> --against=<ref>
                                      Start the nightly regression gate; exits 1 on a regression
`;

export async function runEvalsCommand(args: string[], env: CliEnv): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  try {
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
  } catch (err) {
    if (err instanceof GatewayError) {
      process.stderr.write(`${err.code}: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  process.stderr.write(`Unknown subcommand: evals ${sub}\n${SUB_HELP}`);
  return 1;
}

async function cmdList(env: CliEnv): Promise<number> {
  const { data } = await apiRequest<{ data: EvalDatasetSummary[] }>(
    env,
    'GET',
    '/api/v1/admin/evals'
  );
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
  const { data } = await apiRequest<{ data: EvalDatasetDetail }>(
    env,
    'GET',
    `/api/v1/admin/evals/${id}`
  );
  process.stdout.write(`${data.name} (${data.slug}) — ${data.cases.length} cases\n`);
  for (const c of data.cases) {
    const screened = c.flakeScreened ? '✓screened' : 'unscreened';
    process.stdout.write(`  ${c.id}  ${c.repoUrl}@${c.baselineSha.slice(0, 10)}  ${screened}\n`);
  }
  return 0;
}

function parseFlags(rest: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of rest) {
    const m = a.match(/^--([a-zA-Z]+)=(.*)$/);
    if (m) {
      out[m[1]] = m[2];
    }
  }
  return out;
}

async function cmdRun(rest: string[], env: CliEnv): Promise<number> {
  const slug = rest.find((a) => !a.startsWith('--'));
  const flags = parseFlags(rest);
  if (!slug || !flags.candidate || !flags.against) {
    process.stderr.write('Usage: evals run <dataset-slug> --candidate=<ref> --against=<ref>\n');
    return 1;
  }
  // Resolve slug → id.
  const { data: datasets } = await apiRequest<{ data: EvalDatasetSummary[] }>(
    env,
    'GET',
    '/api/v1/admin/evals'
  );
  const ds = datasets.find((d) => d.slug === slug);
  if (!ds) {
    process.stderr.write(`No dataset with slug '${slug}'\n`);
    return 1;
  }
  const { data: started } = await apiRequest<{ data: EvalRunDto }>(
    env,
    'POST',
    '/api/v1/admin/evals/runs',
    { baselineRef: flags.against, candidateRef: flags.candidate, datasetId: ds.id }
  );
  process.stdout.write(
    `Started eval run ${started.id} (${slug}: ${flags.candidate} vs ${flags.against})\n`
  );

  // Poll for the verdict. The harness is the integration seam; this loop is how
  // the nightly CI gates on the result.
  const deadline = Date.now() + 4 * 60 * 60 * 1000; // 4h
  for (;;) {
    const { data: run } = await apiRequest<{ data: EvalRunDto }>(
      env,
      'GET',
      `/api/v1/admin/evals/runs/${started.id}`
    );
    if (run.status !== 'RUNNING') {
      const summary = (run.summary ?? {}) as { summary?: string };
      process.stdout.write(`${summary.summary ?? run.status}\n`);
      return run.status === 'REGRESSION' ? 1 : 0;
    }
    if (Date.now() > deadline) {
      process.stderr.write('Timed out waiting for the eval run\n');
      return 2;
    }
    await sleep(15_000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cmdResults(rest: string[], env: CliEnv): Promise<number> {
  const flags = parseFlags(rest);
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
  const { data, meta } = await apiRequest<{
    data: EvalResultDto[];
    meta: { total: number };
  }>(env, 'GET', `/api/v1/admin/evals/results?${qs.toString()}`);
  if (data.length === 0) {
    process.stdout.write('No eval results.\n');
    return 0;
  }
  for (const r of data) {
    const val = r.scoreType === 'BOOLEAN' ? (r.value >= 1 ? 'pass' : 'fail') : r.value.toFixed(2);
    process.stdout.write(`${r.createdAt}  ${r.source.padEnd(6)}  ${r.scorer.padEnd(24)}  ${val}\n`);
  }
  process.stdout.write(`(${data.length} of ${meta.total})\n`);
  return 0;
}
