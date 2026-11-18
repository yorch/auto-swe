import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { BUDGET_TIERS } from '@auto-swe/shared/types/workflow';
import {
  apiRequest,
  apiRequestFull,
  GatewayError,
  runWithExitCodes,
  UNKNOWN_SUBCOMMAND,
} from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';
import { missingValue, parseFlags } from '../lib/flags.js';
import { clean, pad, parsePositiveInt } from '../lib/format.js';
import { sleep } from '../lib/time.js';
import { findRepoByName } from './workRequests.js';

const SUB_HELP = `auto-swe plan — describe a goal, review a generated workflow, then approve it

  plan route "<goal>" --repo=<org/name>|--repo-id=<uuid>
  plan create "<goal>" --repo=<org/name>|--repo-id=<uuid> [--agent=<key>] [--wait]
              [--timeout=SECONDS] [--idempotency-key=KEY]
  plan wait <jobId> [--timeout=SECONDS]
  plan show <planId> [--json]
  plan list [--status=PENDING|APPROVED|LAUNCHED|REJECTED|EXPIRED] [--limit=N] [--json]
  plan approve <planId> [--budget-tier=STANDARD|LARGE|EPIC] [--idempotency-key=KEY] [--yes]
  plan reject <planId>
  plan save <planId> [--name=NAME]
  plan run "<goal>" --repo=<org/name>|--repo-id=<uuid> [--agent=<key>] [--budget-tier=T]
           [--timeout=SECONDS] [--idempotency-key=KEY] --yes

  route ranks the templates you may already launch for the goal. create starts a
  generation job (no model spend is recorded against a run until you approve); --wait
  polls it to a plan id. show prints the plan as an outline: nothing runs until the
  plan's owner approves exactly that stored plan. approve asks for confirmation on a
  terminal and refuses to continue non-interactively without --yes. run does create,
  wait, show and approve in one go and requires --yes; without it, it stops after
  printing the plan. The generated spec is only printed by show --json.
  save stores the plan's spec as a DRAFT workflow template in the plan's team; it needs
  team lead rights, and another person must review the draft before it can be promoted.
  An --idempotency-key makes a retried approval (in approve, or the approval step of run)
  find the run it already started instead of failing; without one, each call sends a
  fresh key. run also uses the key for the generation job, so a retried run finds the
  same plan.

  --agent=<key>   Build an output-only plan on this library agent
  --timeout=S     Give up waiting for generation after S seconds (default 600)
  --name=NAME     Name the saved template (default: the plan's own name)

  auto-swe run --describe "<goal>" --repo=<org/name> [--agent=<key>] --yes is the same as plan run.
`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_STATUSES = ['PENDING', 'APPROVED', 'LAUNCHED', 'REJECTED', 'EXPIRED'];
const DEFAULT_TIMEOUT_SEC = 600;
const POLL_START_MS = 2000;
const POLL_MAX_MS = 10_000;

export type Confirm = (question: string) => Promise<boolean>;

const askYesNo: Confirm = async (question) => {
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
};

interface RouteMatch {
  templateId: string;
  name: string;
  description?: string | null;
  reason?: string;
  score?: number;
}
interface JobState {
  status: 'running' | 'done' | 'failed';
  planId?: string;
  code?: string;
  message?: string;
  retryable?: boolean;
}
interface PlanNode {
  id: string;
  type: string | null;
  step: string | null;
  marker: string;
  region: string;
  agentRef?: string | null;
  /** Binding source paths only; `from` is null for a value that is not a plain path. */
  inputs?: Array<{ key: string; from: string | null; hasDefault?: boolean }>;
  writes?: string[];
  feedsImplementer?: boolean;
  message?: string;
}
interface PlanWarning {
  source?: string;
  code: string;
  message: string;
  nodeId?: string | null;
}
interface PlanView {
  id: string;
  status: string;
  mode: string;
  agentKey?: string | null;
  intent: string;
  nodes: PlanNode[];
  cost?: {
    totalUsd?: number | null;
    unpriced?: Array<{ nodeId: string; reason?: string }>;
    exclusions?: string;
    fanOutWidthAssumed?: number;
  } | null;
  warnings: PlanWarning[];
  agentPins?: unknown;
  model?: string | null;
  summary?: string | null;
  createdAt: string;
  expiresAt: string;
  approvedAt?: string | null;
  launchedWorkflowRunId?: string | null;
  /** The goal and plan body were removed from this plan record after the retention period. */
  scrubbed?: boolean;
}
interface PlanListRow {
  id: string;
  status: string;
  mode: string;
  agentKey?: string | null;
  intent: string;
  expiresAt: string;
  totalUsd?: number | null;
  scrubbed?: boolean;
}
interface ApproveResult {
  planId: string;
  workRequestId: string;
  workflowId?: string | null;
  temporalWorkflowId?: string;
  deduplicated?: boolean;
}

/** Test seam: polling bounds and the interactive confirmation. */
export interface PlanDeps {
  confirm?: Confirm;
  /** Isatty override for tests; defaults to stdin being a terminal. */
  interactive?: boolean;
}

export async function runPlanCommand(
  args: string[],
  env: CliEnv,
  deps: PlanDeps = {}
): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  const confirm = deps.confirm ?? askYesNo;
  const interactive = deps.interactive ?? Boolean(process.stdin.isTTY);
  const handled = await runWithExitCodes(async () => {
    if (sub === 'route') {
      return await cmdRoute(rest, env);
    }
    if (sub === 'create') {
      return await cmdCreate(rest, env);
    }
    if (sub === 'wait') {
      return await cmdWait(rest, env);
    }
    if (sub === 'show') {
      return await cmdShow(rest, env);
    }
    if (sub === 'list') {
      return await cmdList(rest, env);
    }
    if (sub === 'approve') {
      return await cmdApprove(rest, env, confirm, interactive);
    }
    if (sub === 'reject') {
      return await cmdReject(rest, env);
    }
    if (sub === 'save') {
      return await cmdSave(rest, env);
    }
    if (sub === 'run') {
      return await cmdRun(rest, env);
    }
    return UNKNOWN_SUBCOMMAND;
  });
  if (handled !== UNKNOWN_SUBCOMMAND) {
    return handled;
  }
  process.stderr.write(`Unknown subcommand: plan ${sub}\n${SUB_HELP}`);
  return 1;
}

/** Boolean flags are lifted out so `parseFlags` cannot hand them the next bare word. */
function takeBooleans(args: string[], names: string[]): { args: string[]; set: Set<string> } {
  const set = new Set<string>();
  const kept: string[] = [];
  for (const a of args) {
    const name = a.startsWith('--') ? a.slice(2) : '';
    if (names.includes(name)) {
      set.add(name);
    } else {
      kept.push(a);
    }
  }
  return { args: kept, set };
}

async function resolveRepoId(
  flags: Record<string, string>,
  env: CliEnv
): Promise<string | { error: string }> {
  if (!flags.repo && !flags['repo-id']) {
    return { error: 'Missing required flag: --repo=<org/name> or --repo-id=<uuid>' };
  }
  if (flags.repo && flags['repo-id']) {
    return { error: '--repo and --repo-id are mutually exclusive; provide only one.' };
  }
  if (flags['repo-id']) {
    return UUID_RE.test(flags['repo-id'])
      ? flags['repo-id']
      : { error: '--repo-id must be a valid UUID' };
  }
  const repo = flags.repo as string;
  if (UUID_RE.test(repo)) {
    return repo;
  }
  const [org, name] = repo.split('/');
  if (!org || !name) {
    return { error: '--repo must be in "org/name" format (e.g. acme/payments-api)' };
  }
  const found = await findRepoByName(env, org, name);
  return found ? found.id : { error: `Repository "${repo}" not found.` };
}

/** Shared parsing for the goal + repository commands. */
async function parseGoal(
  rawArgs: string[],
  env: CliEnv,
  usage: string,
  booleans: string[]
): Promise<
  | { goal: string; repoId: string; flags: Record<string, string>; set: Set<string> }
  | { exit: number }
> {
  const { args, set } = takeBooleans(rawArgs, booleans);
  const { flags, positional } = parseFlags(args);
  const bare = missingValue(
    flags,
    'repo',
    'repo-id',
    'agent',
    'timeout',
    'budget-tier',
    'idempotency-key'
  );
  if (bare) {
    process.stderr.write(`--${bare} requires a value\n`);
    return { exit: 1 };
  }
  const goal = positional[0]?.trim();
  if (!goal) {
    process.stderr.write(`Usage: ${usage}\n`);
    return { exit: 1 };
  }
  const repoId = await resolveRepoId(flags, env);
  if (typeof repoId !== 'string') {
    process.stderr.write(`${repoId.error}\n`);
    return { exit: 1 };
  }
  return { flags, goal, repoId, set };
}

function parseTimeout(flags: Record<string, string>): number | 'invalid' {
  return parsePositiveInt(flags.timeout, DEFAULT_TIMEOUT_SEC);
}

function checkBudgetTier(raw: string | undefined): string | undefined | 'invalid' {
  if (raw === undefined) {
    return undefined;
  }
  const tier = raw.toUpperCase();
  return BUDGET_TIERS.some((t) => t === tier) ? tier : 'invalid';
}

async function cmdRoute(rawArgs: string[], env: CliEnv): Promise<number> {
  const parsed = await parseGoal(rawArgs, env, 'plan route "<goal>" --repo=<org/name>', []);
  if ('exit' in parsed) {
    return parsed.exit;
  }
  const { matches, noneFit } = await apiRequest<{ matches: RouteMatch[]; noneFit: boolean }>(
    env,
    'POST',
    '/api/v1/run-plans/route',
    { intent: parsed.goal, repoId: parsed.repoId }
  );
  if (matches.length === 0) {
    process.stdout.write('No existing template fits this goal.\n');
  } else {
    process.stdout.write('Templates you can launch that may fit:\n');
    for (const m of matches) {
      const score = typeof m.score === 'number' ? m.score.toFixed(2) : '-';
      process.stdout.write(`  ${pad(clean(m.name), 32)} ${score}  ${clean(m.reason ?? '')}\n`);
    }
    if (noneFit) {
      process.stdout.write('\nThe router judged that none of these fit well.\n');
    }
  }
  process.stdout.write(
    `\nTo generate a new plan instead:\n  auto-swe plan create "<goal>" --repo=<org/name> --wait\n`
  );
  return 0;
}

async function startJob(
  env: CliEnv,
  goal: string,
  repoId: string,
  flags: Record<string, string>
): Promise<string> {
  const { jobId } = await apiRequest<{ jobId: string }>(
    env,
    'POST',
    '/api/v1/run-plans',
    { ...(flags.agent ? { agent: flags.agent } : {}), intent: goal, repoId },
    flags['idempotency-key'] ? { 'Idempotency-Key': flags['idempotency-key'] } : undefined
  );
  return jobId;
}

/**
 * Poll a generation job to a plan id with a growing delay. The deadline counts the delays slept,
 * so it holds whatever the clock does. Returns the plan id, or an exit code after printing why.
 */
async function waitForJob(
  env: CliEnv,
  jobId: string,
  timeoutSec: number
): Promise<{ planId: string } | { exit: number }> {
  let delay = POLL_START_MS;
  let waited = 0;
  for (;;) {
    const state = await apiRequest<JobState>(env, 'GET', `/api/v1/run-plans/jobs/${jobId}`);
    if (state.status === 'done' && state.planId) {
      return { planId: state.planId };
    }
    if (state.status === 'failed') {
      process.stderr.write(
        `${clean(state.code ?? 'PLAN_GENERATION_FAILED')}: ${clean(state.message ?? 'Plan generation failed')}\n`
      );
      if (state.retryable) {
        process.stderr.write('This can be retried.\n');
      }
      return { exit: 2 };
    }
    if (waited >= timeoutSec * 1000) {
      process.stderr.write(
        `plan: generation did not finish within ${timeoutSec}s. It may still complete; ` +
          `check again with: auto-swe plan wait ${jobId}\n`
      );
      return { exit: 1 };
    }
    await sleep(delay);
    waited += delay;
    delay = Math.min(Math.round(delay * 1.5), POLL_MAX_MS);
  }
}

async function cmdCreate(rawArgs: string[], env: CliEnv): Promise<number> {
  const parsed = await parseGoal(
    rawArgs,
    env,
    'plan create "<goal>" --repo=<org/name> [--agent=<key>] [--wait]',
    ['wait']
  );
  if ('exit' in parsed) {
    return parsed.exit;
  }
  const timeout = parseTimeout(parsed.flags);
  if (timeout === 'invalid') {
    process.stderr.write('--timeout must be a positive integer (seconds)\n');
    return 1;
  }
  const jobId = await startJob(env, parsed.goal, parsed.repoId, parsed.flags);
  process.stdout.write(`Plan generation started.\n  Job: ${jobId}\n`);
  if (!parsed.set.has('wait')) {
    process.stdout.write(`\nWait for it with:\n  auto-swe plan wait ${jobId}\n`);
    return 0;
  }
  const done = await waitForJob(env, jobId, timeout);
  if ('exit' in done) {
    return done.exit;
  }
  process.stdout.write(
    `Plan ready: ${done.planId}\n\nReview it:\n  auto-swe plan show ${done.planId}\n`
  );
  return 0;
}

async function cmdWait(rawArgs: string[], env: CliEnv): Promise<number> {
  const { flags, positional } = parseFlags(rawArgs);
  const jobId = positional[0];
  if (!jobId) {
    process.stderr.write('Usage: plan wait <jobId> [--timeout=SECONDS]\n');
    return 1;
  }
  const timeout = parseTimeout(flags);
  if (timeout === 'invalid') {
    process.stderr.write('--timeout must be a positive integer (seconds)\n');
    return 1;
  }
  const done = await waitForJob(env, jobId, timeout);
  if ('exit' in done) {
    return done.exit;
  }
  process.stdout.write(
    `Plan ready: ${done.planId}\n\nReview it:\n  auto-swe plan show ${done.planId}\n`
  );
  return 0;
}

function usd(n: number | null | undefined): string {
  return typeof n === 'number' ? `$${n.toFixed(2)}` : 'n/a';
}

/** The plan as a human outline. The spec itself is never printed here. */
/** Where an input is read from, in words. Server text is cleaned of control characters. */
function describeSource(from: string | null): string {
  if (from === null) {
    return 'a fixed value';
  }
  if (from === 'request.description') {
    return 'the goal';
  }
  const output = /^nodes\.([^.]+)\.output$/.exec(from);
  return output ? `the output of "${clean(output[1] ?? '')}"` : clean(from);
}

function describeNodeAction(n: PlanNode): string | null {
  if (n.type !== 'agent' || !n.agentRef) {
    return null;
  }
  const sources = (n.inputs ?? []).map((i) => describeSource(i.from));
  return sources.length > 0
    ? `runs agent ${clean(n.agentRef)} on ${sources.join(' and ')}`
    : `runs agent ${clean(n.agentRef)}`;
}

/** What a step node reads, with "has fallback value" where a default exists (never its value). */
function describeNodeReads(n: PlanNode): string | null {
  if (n.type !== 'step' || !n.inputs || n.inputs.length === 0) {
    return null;
  }
  return `reads ${n.inputs
    .map(
      (i) =>
        `${clean(i.key)} from ${describeSource(i.from)}${i.hasDefault ? ' (has fallback value)' : ''}`
    )
    .join(', ')}`;
}

const SCRUBBED_NOTICE =
  'The goal and plan body were removed from this plan record after the retention period. The run keeps its own records';

/** What is left of a plan whose goal and body were scrubbed: its metadata and cost, no outline. */
function printScrubbedPlan(plan: PlanView): void {
  const w = (s: string) => process.stdout.write(`${s}\n`);
  w(`Plan ${plan.id}`);
  w(`  Status:   ${plan.status}`);
  w(
    `  Mode:     ${plan.mode}${plan.agentKey ? ` (agent ${clean(plan.agentKey)})` : ''}` +
      (plan.mode === 'output-only'
        ? ' - produces output, delivers nothing'
        : ' - delivers a draft pull request')
  );
  if (plan.model) {
    w(`  Model:    ${clean(plan.model)}`);
  }
  if (plan.approvedAt) {
    w(`  Approved: ${plan.approvedAt}`);
  }
  w(`  Cost:     ${usd(plan.cost?.totalUsd)} (estimated)`);
  w('');
  w(`${SCRUBBED_NOTICE}.`);
}

function printPlan(plan: PlanView): void {
  if (plan.scrubbed) {
    printScrubbedPlan(plan);
    return;
  }
  const w = (s: string) => process.stdout.write(`${s}\n`);
  w(`Plan ${plan.id}`);
  w(`  Status:   ${plan.status}`);
  w(
    `  Mode:     ${plan.mode}${plan.agentKey ? ` (agent ${clean(plan.agentKey)})` : ''}` +
      (plan.mode === 'output-only'
        ? ' - produces output, delivers nothing'
        : ' - delivers a draft pull request')
  );
  w(`  Goal:     ${clean(plan.intent)}`);
  if (plan.summary) {
    w(`  Summary:  ${clean(plan.summary)}`);
  }
  if (plan.model) {
    w(`  Model:    ${clean(plan.model)}`);
  }
  w(`  Expires:  ${plan.expiresAt}`);
  if (plan.approvedAt) {
    w(`  Approved: ${plan.approvedAt}`);
  }
  w('');
  w(
    'Steps (core = pinned, injected = added by the platform, mandatory = required, free = generated):'
  );
  for (const n of plan.nodes) {
    w(`  [${pad(n.marker, 9).trimEnd()}] ${clean(n.id)}  ${clean(n.step ?? n.type ?? '')}`);
    const action = describeNodeAction(n);
    if (action) {
      w(`      ${action}`);
    }
    const reads = describeNodeReads(n);
    if (reads) {
      w(`      ${reads}`);
    }
    if (n.message) {
      w(`      message: ${clean(n.message)}`);
    }
    if (n.feedsImplementer) {
      w('      >> Output becomes guidance for the implementer');
    }
  }
  w('');
  const cost = plan.cost;
  w(`Estimated cost: ${usd(cost?.totalUsd)} (a floor, not a forecast)`);
  if (cost?.unpriced?.length) {
    w(
      `  Not priced (${cost.unpriced.length}): ${cost.unpriced.map((u) => clean(u.nodeId)).join(', ')}`
    );
  }
  if (cost?.exclusions) {
    w(`  ${clean(cost.exclusions)}`);
  }
  if (plan.warnings.length > 0) {
    w('');
    w('Warnings:');
    for (const x of plan.warnings) {
      w(`  ${clean(x.code)}${x.nodeId ? ` (${clean(x.nodeId)})` : ''}: ${clean(x.message)}`);
    }
  }
  const pins = plan.agentPins;
  if (pins && typeof pins === 'object' && Object.keys(pins).length > 0) {
    w('');
    w('Agent versions pinned:');
    for (const [k, v] of Object.entries(pins as Record<string, unknown>)) {
      w(`  ${clean(k)} @ ${clean(typeof v === 'object' ? JSON.stringify(v) : String(v))}`);
    }
  }
}

async function cmdShow(rawArgs: string[], env: CliEnv): Promise<number> {
  const { args, set } = takeBooleans(rawArgs, ['json']);
  const { positional } = parseFlags(args);
  const id = positional[0];
  if (!id || !UUID_RE.test(id)) {
    process.stderr.write('Usage: plan show <planId> [--json]\n');
    return 1;
  }
  const plan = await apiRequest<PlanView>(env, 'GET', `/api/v1/run-plans/${id}`);
  if (set.has('json')) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }
  printPlan(plan);
  return 0;
}

async function cmdList(rawArgs: string[], env: CliEnv): Promise<number> {
  const { args, set } = takeBooleans(rawArgs, ['json']);
  const { flags } = parseFlags(args);
  const bare = missingValue(flags, 'status', 'limit');
  if (bare) {
    process.stderr.write(`--${bare} requires a value\n`);
    return 1;
  }
  const status = flags.status?.toUpperCase();
  if (status !== undefined && !PLAN_STATUSES.includes(status)) {
    process.stderr.write(`--status must be one of: ${PLAN_STATUSES.join(', ')}\n`);
    return 1;
  }
  const limit = parsePositiveInt(flags.limit, 20);
  if (limit === 'invalid') {
    process.stderr.write('--limit must be a positive integer\n');
    return 1;
  }
  const qs = new URLSearchParams({ limit: String(limit) });
  if (status) {
    qs.set('status', status);
  }
  const { data } = await apiRequestFull<{ data: PlanListRow[] }>(
    env,
    'GET',
    `/api/v1/run-plans?${qs}`
  );
  if (set.has('json')) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return 0;
  }
  if (data.length === 0) {
    process.stdout.write('No plans.\n');
    return 0;
  }
  for (const p of data) {
    const headline = p.scrubbed
      ? `(${SCRUBBED_NOTICE})`
      : clean(p.intent).replace(/\s+/g, ' ').slice(0, 60);
    process.stdout.write(
      `${p.id}  ${pad(p.status, 9)} ${pad(p.mode, 11)} ${pad(usd(p.totalUsd), 8)} ${headline}\n`
    );
  }
  return 0;
}

/** Turns the approval refusals that mean "this plan no longer matches reality" into one message. */
function explainDrift(err: unknown): never {
  if (err instanceof GatewayError) {
    const drift =
      err.statusCode === 409 &&
      typeof err.details === 'object' &&
      err.details !== null &&
      'drift' in err.details
        ? String((err.details as { drift: unknown }).drift)
        : null;
    if (drift) {
      throw new GatewayError(
        err.statusCode,
        err.code,
        `The plan no longer matches the platform (${clean(drift)} changed since it was generated), ` +
          'so it was not approved and nothing ran. Generate a new plan: auto-swe plan create "<goal>" --repo=<org/name> --wait',
        err.details
      );
    }
    if (err.code === 'PLAN_EXPIRED') {
      throw new GatewayError(
        err.statusCode,
        err.code,
        `${err.message} Generate a new plan with auto-swe plan create.`,
        err.details
      );
    }
  }
  throw err;
}

async function approvePlan(
  env: CliEnv,
  id: string,
  budgetTier: string | undefined,
  idempotencyKey: string | undefined
): Promise<number> {
  let result: ApproveResult;
  try {
    result = await apiRequest<ApproveResult>(
      env,
      'POST',
      `/api/v1/run-plans/${id}/approve`,
      budgetTier ? { budgetTier } : {},
      { 'Idempotency-Key': idempotencyKey ?? randomUUID() }
    );
  } catch (err) {
    explainDrift(err);
  }
  process.stdout.write(
    result.deduplicated
      ? 'Plan already approved with this key; its run was started earlier.\n'
      : 'Plan approved; the run is starting.\n'
  );
  process.stdout.write(`  Work request: ${result.workRequestId}\n`);
  process.stdout.write(
    `Monitor it:\n  auto-swe runs list --work-request-id=${result.workRequestId}\n`
  );
  return 0;
}

async function cmdApprove(
  rawArgs: string[],
  env: CliEnv,
  confirm: Confirm,
  interactive: boolean
): Promise<number> {
  const { args, set } = takeBooleans(rawArgs, ['yes']);
  const { flags, positional } = parseFlags(args);
  const bare = missingValue(flags, 'budget-tier', 'idempotency-key');
  if (bare) {
    process.stderr.write(`--${bare} requires a value\n`);
    return 1;
  }
  if (flags['idempotency-key'] === '') {
    process.stderr.write('--idempotency-key requires a non-empty value\n');
    return 1;
  }
  const id = positional[0];
  if (!id || !UUID_RE.test(id)) {
    process.stderr.write(
      'Usage: plan approve <planId> [--budget-tier=T] [--idempotency-key=KEY] [--yes]\n'
    );
    return 1;
  }
  const tier = checkBudgetTier(flags['budget-tier']);
  if (tier === 'invalid') {
    process.stderr.write(`--budget-tier must be one of: ${BUDGET_TIERS.join(', ')}\n`);
    return 1;
  }
  if (!set.has('yes')) {
    if (!interactive) {
      process.stderr.write(
        'plan approve: refusing to approve without confirmation in a non-interactive session. ' +
          'Review the plan with `auto-swe plan show` and pass --yes to approve it.\n'
      );
      return 1;
    }
    const plan = await apiRequest<PlanView>(env, 'GET', `/api/v1/run-plans/${id}`);
    printPlan(plan);
    process.stdout.write('\n');
    if (!(await confirm('Approve this plan and start the run?'))) {
      process.stdout.write('Not approved; nothing ran.\n');
      return 1;
    }
  }
  return approvePlan(env, id, tier, flags['idempotency-key']);
}

async function cmdReject(rawArgs: string[], env: CliEnv): Promise<number> {
  const { positional } = parseFlags(rawArgs);
  const id = positional[0];
  if (!id || !UUID_RE.test(id)) {
    process.stderr.write('Usage: plan reject <planId>\n');
    return 1;
  }
  await apiRequest(env, 'POST', `/api/v1/run-plans/${id}/reject`, {});
  process.stdout.write(`Plan ${id} rejected.\n`);
  return 0;
}

async function cmdRun(rawArgs: string[], env: CliEnv): Promise<number> {
  const parsed = await parseGoal(
    rawArgs,
    env,
    'plan run "<goal>" --repo=<org/name> [--agent=<key>] [--idempotency-key=KEY] --yes',
    ['yes']
  );
  if ('exit' in parsed) {
    return parsed.exit;
  }
  if (parsed.flags['idempotency-key'] === '') {
    process.stderr.write('--idempotency-key requires a non-empty value\n');
    return 1;
  }
  const timeout = parseTimeout(parsed.flags);
  if (timeout === 'invalid') {
    process.stderr.write('--timeout must be a positive integer (seconds)\n');
    return 1;
  }
  const tier = checkBudgetTier(parsed.flags['budget-tier']);
  if (tier === 'invalid') {
    process.stderr.write(`--budget-tier must be one of: ${BUDGET_TIERS.join(', ')}\n`);
    return 1;
  }
  const jobId = await startJob(env, parsed.goal, parsed.repoId, parsed.flags);
  process.stdout.write(`Plan generation started (job ${jobId}).\n`);
  const done = await waitForJob(env, jobId, timeout);
  if ('exit' in done) {
    return done.exit;
  }
  const plan = await apiRequest<PlanView>(env, 'GET', `/api/v1/run-plans/${done.planId}`);
  process.stdout.write('\n');
  printPlan(plan);
  process.stdout.write('\n');
  if (!parsed.set.has('yes')) {
    process.stdout.write(
      `Not approved (no --yes); nothing ran. To approve this plan:\n  auto-swe plan approve ${done.planId}\n`
    );
    return 0;
  }
  return approvePlan(env, done.planId, tier, parsed.flags['idempotency-key']);
}

interface SaveResult {
  templateId: string;
  name: string;
  version: number;
  status: string;
}

async function cmdSave(rawArgs: string[], env: CliEnv): Promise<number> {
  const { flags, positional } = parseFlags(rawArgs);
  if (missingValue(flags, 'name')) {
    process.stderr.write('--name requires a value\n');
    return 1;
  }
  const id = positional[0];
  if (!id || !UUID_RE.test(id)) {
    process.stderr.write('Usage: plan save <planId> [--name=NAME]\n');
    return 1;
  }
  const name = flags.name?.trim();
  if (flags.name !== undefined && (!name || name.length > 120)) {
    process.stderr.write('--name must be 1 to 120 characters\n');
    return 1;
  }
  const saved = await apiRequest<SaveResult>(
    env,
    'POST',
    `/api/v1/run-plans/${id}/save-as-template`,
    name ? { name } : {}
  );
  process.stdout.write(`Saved plan ${id} as a workflow template.\n`);
  process.stdout.write(`  Template: ${clean(saved.templateId)}\n`);
  process.stdout.write(`  Name:     ${clean(saved.name)}\n`);
  process.stdout.write(`  Status:   ${clean(saved.status)} (version ${saved.version})\n`);
  process.stdout.write(
    'It is a DRAFT: it runs nothing until another person reviews it, so ask a teammate to\n' +
      'review and promote it from the workflow library.\n'
  );
  return 0;
}

/**
 * `auto-swe run --describe "<goal>" --repo=<org/name> ...`: the goal-first spelling of
 * `plan run`. The goal moves from the flag to the position `plan run` reads it from; every other
 * flag is passed on as it is.
 */
export function describeAlias(args: string[]): string[] | { error: string } {
  const rest: string[] = [];
  let goal: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith('--describe=')) {
      goal = a.slice('--describe='.length);
    } else if (a === '--describe') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        return { error: '--describe requires a value' };
      }
      goal = next;
      i++;
    } else {
      rest.push(a);
    }
  }
  if (!goal?.trim()) {
    return { error: '--describe requires a value' };
  }
  if (rest.some((a) => a === '--ticket' || a.startsWith('--ticket='))) {
    return { error: '--describe starts a plan and cannot be combined with --ticket' };
  }
  return ['run', goal, ...rest];
}

/** True when `auto-swe run` was given `--describe`, which selects the plan path. */
export function hasDescribeFlag(args: string[]): boolean {
  return args.some((a) => a === '--describe' || a.startsWith('--describe='));
}

export async function runDescribeAlias(
  args: string[],
  env: CliEnv,
  deps: PlanDeps = {}
): Promise<number> {
  const mapped = describeAlias(args);
  if (!Array.isArray(mapped)) {
    process.stderr.write(`${mapped.error}\n`);
    return 1;
  }
  return runPlanCommand(mapped, env, deps);
}
