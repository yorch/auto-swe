import type {
  EvalDatasetDetail,
  EvalDatasetSummary,
  EvalResultDto,
} from '@auto-swe/shared/types/api';
import { apiRequest, GatewayError } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';

const SUB_HELP = `auto-swe evals — inspect eval datasets and captured signals (P1)

  evals list                          List eval datasets
  evals show <id>                     Print a dataset's cases
  evals results [--run=<id>] [--source=GATE|REVIEW|MERGE] [--scorer=<s>] [--limit=N]
                                      Query captured eval signals
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
