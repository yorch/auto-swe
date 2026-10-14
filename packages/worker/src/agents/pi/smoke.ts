import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import {
  BUILTIN_MODELS,
  builtinModelSpec,
  cacheMultipliers,
} from '@auto-swe/shared/lib/builtinModels';
import { BUILTIN_SCANNER_PATTERNS } from '@auto-swe/shared/scannerPatterns';
import { MockActivityEnvironment } from '@temporalio/testing';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { AgentTracer } from '../../lib/agentTracer.js';
import { WORKSPACE_DIR } from '../harness/adapter.js';
import { piRuntime } from './runtime.js';

/**
 * One real Pi implementer turn, end to end, outside Temporal and without a
 * database: a hardened container shaped like `createWorkspace`'s, the Pi runtime
 * with a real model binding, one `runTurn`, and a report of what happened. It is
 * the tool for the first run of the `pi` runtime against a real model; the CLI is
 * `packages/worker/scripts/piSmoke.ts`.
 */

const run = promisify(execFile);

export const DEFAULT_IMAGE = 'node:24-alpine';
export const DEFAULT_REPO = 'https://github.com/octocat/Hello-World.git';
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5-5';
export const DEFAULT_PROMPT =
  'Add a file named SMOKE.md at the repository root containing one sentence that says what this ' +
  'repository is, based on what you find in it. Then run `cat SMOKE.md` to confirm it, and reply ' +
  'with one sentence saying what you did.';
export const DEFAULT_SYSTEM =
  'You are the implementer. Work inside the repository checkout with your tools. Make the ' +
  'requested change, check it, then reply with a short summary.';

export interface SmokeOptions {
  model: string;
  /** Never read from a flag: `PI_SMOKE_API_KEY`. Not needed with `mock` or `languageModel`. */
  apiKey?: string;
  apiBase?: string;
  image: string;
  /** Cloned on the host (shallow) and copied in; the image needs no git. */
  repoUrl?: string;
  /** A local directory copied in instead of a clone. */
  dir?: string;
  prompt: string;
  maxSteps: number;
  deadlineSeconds: number;
  /** Where the full JSON trace is written. */
  traceFile?: string;
  /** A scripted model in place of the real one: no key, no network. */
  mock: boolean;
  /**
   * Run the scanners against the built-in pattern list instead of the database
   * (see {@link installBuiltinScannerPatterns}). Without it the scanners read
   * `scanner_patterns` through `DATABASE_URL`, as the worker does.
   */
  noDbScanners: boolean;
  /** A bound model in place of resolving `model` (tests). */
  languageModel?: LanguageModel;
  /** Progress lines while the turn runs. */
  log?: (line: string) => void;
}

export const SMOKE_USAGE = `Usage: yarn pi:smoke [options]

Runs ONE Pi implementer turn against a real model, in a hardened Docker container.

  PI_SMOKE_API_KEY=<key> yarn pi:smoke --model anthropic/claude-sonnet-5-5 --no-db-scanners

Options (each also reads the PI_SMOKE_<NAME> environment variable):
  --model <provider/model>   model spec            (default ${DEFAULT_MODEL})
  --api-base <url>           base URL, for an OpenAI-compatible provider
  --image <image>            workspace image       (default ${DEFAULT_IMAGE})
  --repo <url>               git repository to clone  (default ${DEFAULT_REPO})
  --dir <path>               local directory to copy in instead of cloning
  --prompt <text>            the task              (default: write SMOKE.md)
  --max-steps <n>            model-call cap        (default 12)
  --deadline-seconds <n>     wall-clock deadline   (default 300)
  --trace-file <path>        full JSON trace       (default ./pi-smoke-trace.json)
  --no-db-scanners           scanners use the built-in pattern list, not the database
  --mock                     scripted model; no key, no network
  --help

The API key is read only from PI_SMOKE_API_KEY, so it stays out of shell history.
Without --no-db-scanners the scanners load their patterns from the database
(DATABASE_URL); with neither, the script refuses to start rather than run unscanned.`;

/** Parses flags (falling back to `PI_SMOKE_*`) into options; throws a usage message on bad input. */
export function parseSmokeArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): SmokeOptions | 'help' {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'api-base': { type: 'string' },
      'deadline-seconds': { type: 'string' },
      dir: { type: 'string' },
      help: { type: 'boolean' },
      image: { type: 'string' },
      'max-steps': { type: 'string' },
      mock: { type: 'boolean' },
      model: { type: 'string' },
      'no-db-scanners': { type: 'boolean' },
      prompt: { type: 'string' },
      repo: { type: 'string' },
      'trace-file': { type: 'string' },
    },
    strict: true,
  });
  if (values.help) {
    return 'help';
  }
  const pick = (flag: string | undefined, name: string) => flag ?? env[`PI_SMOKE_${name}`];
  const positive = (raw: string | undefined, fallback: number, label: string) => {
    if (raw === undefined || raw === '') {
      return fallback;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`${label} must be a positive integer, got '${raw}'.`);
    }
    return n;
  };
  const dir = pick(values.dir, 'DIR');
  const repoUrl = pick(values.repo, 'REPO');
  if (dir && repoUrl) {
    throw new Error('Give --dir or --repo, not both.');
  }
  const mock = values.mock ?? false;
  const apiKey = env.PI_SMOKE_API_KEY || undefined;
  if (!mock && !apiKey) {
    throw new Error(
      'PI_SMOKE_API_KEY is not set. It is read only from the environment, never a flag. ' +
        'Pass --mock to run a scripted model instead.'
    );
  }
  return {
    apiBase: pick(values['api-base'], 'API_BASE') || undefined,
    apiKey,
    deadlineSeconds: positive(
      pick(values['deadline-seconds'], 'DEADLINE_SECONDS'),
      300,
      '--deadline-seconds'
    ),
    dir: dir || undefined,
    image: pick(values.image, 'IMAGE') || DEFAULT_IMAGE,
    maxSteps: positive(pick(values['max-steps'], 'MAX_STEPS'), 12, '--max-steps'),
    mock,
    model: pick(values.model, 'MODEL') || DEFAULT_MODEL,
    noDbScanners: values['no-db-scanners'] ?? env.PI_SMOKE_NO_DB_SCANNERS === '1',
    prompt: pick(values.prompt, 'PROMPT') || DEFAULT_PROMPT,
    repoUrl: dir ? undefined : repoUrl || DEFAULT_REPO,
    traceFile: pick(values['trace-file'], 'TRACE_FILE') || 'pi-smoke-trace.json',
  };
}

// ── Scanners ────────────────────────────────────────────────────────────────

/**
 * Make the worker's scanners (`scanShellCommand`, `checkSensitiveFilePath`, …)
 * read the built-in pattern list instead of the `scanner_patterns` table.
 *
 * Their loader (`makePatternLoader`) has no fallback: it reads the database, and
 * a scanner that cannot load its patterns blocks every call. So this replaces the
 * one method it calls on the shared Prisma singleton — `scannerPattern.findMany`
 * — with a filter over `BUILTIN_SCANNER_PATTERNS`. The scanners, their regex
 * executor and their windowing are unchanged. What differs from a deployment is
 * the pattern SET: patterns an admin added or disabled at `/govern/scanner` are
 * not seen. `DATABASE_URL` is given a placeholder when unset because constructing
 * the client needs one; nothing connects to it.
 *
 * Process-wide and meant for this tool only.
 */
export async function installBuiltinScannerPatterns(): Promise<void> {
  process.env.DATABASE_URL ||= 'postgresql://smoke:smoke@127.0.0.1:1/smoke';
  const { prisma } = await import('@auto-swe/shared/db');
  const delegate = prisma.scannerPattern as unknown as {
    findMany: (args?: { where?: { type?: string | { in: string[] } } }) => Promise<unknown[]>;
  };
  delegate.findMany = async (args) => {
    const wanted = args?.where?.type;
    const types = typeof wanted === 'string' ? [wanted] : wanted?.in;
    return BUILTIN_SCANNER_PATTERNS.filter((p) => !types || types.includes(p.type)).map((p) => ({
      flags: p.flags,
      isActive: true,
      label: p.label,
      pattern: p.pattern,
      type: p.type,
    }));
  };
}

// ── Mock model ──────────────────────────────────────────────────────────────

type MockStep = { text: string } | { calls: { name: string; input: Record<string, unknown> }[] };

/** A scripted AI SDK model that answers each call with the next step. */
export function scriptedModel(steps: MockStep[]): MockLanguageModelV4 {
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const step = steps[i++] ?? { text: 'done' };
      const usage = {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1000, total: 1000 },
        outputTokens: { reasoning: 0, text: 50, total: 50 },
      };
      return 'text' in step
        ? {
            content: [{ text: step.text, type: 'text' }],
            finishReason: { raw: 'end_turn', unified: 'stop' },
            usage,
            warnings: [],
          }
        : {
            content: step.calls.map((c, n) => ({
              input: JSON.stringify(c.input),
              toolCallId: `mock-${i}-${n}`,
              toolName: c.name,
              type: 'tool-call',
            })),
            finishReason: { raw: 'tool_use', unified: 'tool-calls' },
            usage,
            warnings: [],
          };
    },
  } as never);
}

/** The `--mock` model: writes `SMOKE.md`, reads it back, answers. */
export function defaultMockModel(): MockLanguageModelV4 {
  return scriptedModel([
    {
      calls: [
        {
          input: { content: 'A mock repository written by the Pi smoke run.\n', path: 'SMOKE.md' },
          name: 'write',
        },
      ],
    },
    { calls: [{ input: { command: 'cat SMOKE.md' }, name: 'bash' }] },
    { text: 'Wrote SMOKE.md and confirmed it with cat.' },
  ]);
}

// ── Tracer ──────────────────────────────────────────────────────────────────

interface TracedToolCall {
  toolName: string;
  inputJson?: unknown;
  outputJson?: unknown;
  error?: string;
  durationMs?: number;
}
interface TracedEvent {
  name: string;
  inputJson?: unknown;
  outputJson?: unknown;
  error?: string;
}

/** The two `AgentTracer` methods the harness runtime calls, kept in memory. */
class MemoryTracer {
  readonly toolCalls: TracedToolCall[] = [];
  readonly events: TracedEvent[] = [];
  addToolCall(call: TracedToolCall): void {
    this.toolCalls.push(call);
  }
  addActivityEvent(event: TracedEvent): void {
    this.events.push(event);
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

export interface SmokeToolCall {
  name: string;
  /** `ok`, `warning`, `blocked` (the worker refused it) or `failed` (it ran and errored). */
  decision: 'ok' | 'warning' | 'blocked' | 'failed';
  input: string;
  error?: string;
  durationMs?: number;
}

export interface SmokeModelCall {
  index: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}

export interface SmokeReport {
  model: string;
  image: string;
  mock: boolean;
  scannerSource: 'database' | 'built-in patterns (--no-db-scanners)';
  toolCalls: SmokeToolCall[];
  modelCalls: SmokeModelCall[];
  text?: string;
  stoppedReason?: string;
  steps?: number;
  toolCallCount: number;
  diffStat: string;
  /** The turn failed with this message; the rest of the report is what it did first. */
  error?: string;
  wallMs: number;
  /** Null when the model is not in `BUILTIN_MODELS`. */
  costUsd: number | null;
  costNote: string;
}

const clip = (value: unknown, max: number): string => {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** The decision a trace row records: the harness runtime writes a refusal as `{ result }`. */
function decisionOf(call: TracedToolCall): SmokeToolCall['decision'] {
  if (call.error === undefined) {
    return 'ok';
  }
  if (call.outputJson === undefined) {
    return 'failed';
  }
  return typeof call.outputJson === 'object' ? 'blocked' : 'warning';
}

/**
 * USD for one call at the built-in price, cache reads and writes at the model's
 * cache multipliers (the arithmetic of `costTracking.ts`, without the catalog,
 * which is in the database). Null for a model the table does not price.
 */
export function estimateCostUsd(
  spec: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
  }
): number | null {
  const key = spec.toLowerCase();
  const price = BUILTIN_MODELS.find((m) => builtinModelSpec(m) === key);
  if (!price) {
    return null;
  }
  const rates = cacheMultipliers(key);
  const read = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const write = Math.min(usage.cacheCreationInputTokens ?? 0, usage.inputTokens - read);
  const uncached = usage.inputTokens - read - write;
  return (
    ((uncached + read * rates.read + write * rates.write) * price.inputUsdPerMTok +
      usage.outputTokens * price.outputUsdPerMTok) /
    1_000_000
  );
}

export function formatReport(report: SmokeReport): string {
  const out: string[] = [];
  out.push('Pi smoke turn');
  out.push(
    `  model     ${report.model}${report.mock ? '  (MOCK: scripted model, no provider call)' : ''}`
  );
  out.push(`  image     ${report.image}`);
  out.push(`  scanners  ${report.scannerSource}`);
  out.push('');
  out.push(`Tool calls (${report.toolCalls.length})`);
  for (const [i, c] of report.toolCalls.entries()) {
    const flag = c.decision === 'ok' ? 'ok     ' : c.decision.padEnd(7);
    out.push(
      `  ${String(i + 1).padStart(2)}. ${c.name.padEnd(6)} ${flag} ${c.input}` +
        (c.durationMs === undefined ? '' : `  ${c.durationMs}ms`)
    );
    if (c.error) {
      out.push(`        error: ${clip(c.error, 200)}`);
    }
  }
  out.push('');
  out.push(`Model calls (${report.modelCalls.length})`);
  for (const m of report.modelCalls) {
    out.push(
      `  ${String(m.index).padStart(2)}. in ${m.inputTokens}` +
        (m.cachedInputTokens ? ` (cache read ${m.cachedInputTokens})` : '') +
        (m.cacheWriteTokens ? ` (cache write ${m.cacheWriteTokens})` : '') +
        `  out ${m.outputTokens}` +
        (m.costUsd === null ? '' : `  ~$${m.costUsd.toFixed(4)}`)
    );
  }
  out.push('');
  out.push('Final text');
  out.push(`  ${report.text ?? '(none)'}`);
  if (report.stoppedReason) {
    out.push(`  stopped: ${report.stoppedReason}`);
  }
  if (report.error) {
    out.push(`  TURN FAILED: ${report.error}`);
  }
  out.push('');
  out.push('git diff --stat');
  out.push(
    report.diffStat
      .trim()
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n') || '  (no changes)'
  );
  out.push('');
  out.push(
    `Wall time ${(report.wallMs / 1000).toFixed(1)}s   ` +
      (report.costUsd === null ? 'Cost unknown' : `Estimated cost ~$${report.costUsd.toFixed(4)}`) +
      `  (${report.costNote})`
  );
  return out.join('\n');
}

// ── Workspace ───────────────────────────────────────────────────────────────

const GIT_ENV = {
  GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
  GIT_AUTHOR_NAME: 'pi-smoke',
  GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
  GIT_COMMITTER_NAME: 'pi-smoke',
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-c', 'safe.directory=*', ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** A host directory holding the repository with a baseline commit, to copy into the container. */
async function prepareCheckout(options: SmokeOptions, root: string): Promise<string> {
  const target = path.join(root, 'repo');
  if (options.dir) {
    const source = path.resolve(options.dir);
    if (!(await stat(source)).isDirectory()) {
      throw new Error(`--dir ${source} is not a directory.`);
    }
    await cp(source, target, {
      filter: (src) => path.basename(src) !== 'node_modules',
      recursive: true,
    });
  } else if (options.repoUrl) {
    await run('git', ['clone', '--depth', '1', '--', options.repoUrl, target], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 180_000,
    });
  } else {
    await mkdir(target, { recursive: true });
  }
  const hasGit = (await readdir(target)).includes('.git');
  if (!hasGit) {
    await git(target, ['init', '-q']);
  }
  if (!hasGit || !(await git(target, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => ''))) {
    await git(target, ['add', '-A']);
    await git(target, ['commit', '-q', '--allow-empty', '-m', 'baseline']);
  }
  return target;
}

/** A container hardened as `createWorkspace`'s is, and the `Workspace` calls the runtime makes. */
async function startWorkspace(image: string) {
  const name = `workspace-smoke-${randomBytes(4).toString('hex')}`;
  await run('docker', [
    'run',
    '-d',
    '--init',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--memory=2g',
    '--cpus=2',
    '--pids-limit=512',
    '--name',
    name,
    '--',
    image,
    'sleep',
    'infinity',
  ]);
  const shell = async (command: string, o?: { timeoutMs?: number }) =>
    (
      await run('docker', ['exec', '-w', WORKSPACE_DIR, name, 'sh', '-c', command], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: o?.timeoutMs ?? 120_000,
      })
    ).stdout;
  const workspace = {
    containerId: name,
    exec: shell,
    execCapture: async (command: string, o?: { timeoutMs?: number }) => {
      try {
        return { exitCode: 0, stderr: '', stdout: await shell(command, o) };
      } catch (err) {
        const e = err as { code?: number; stderr?: string; stdout?: string };
        return {
          exitCode: typeof e.code === 'number' ? e.code : 1,
          stderr: e.stderr ?? '',
          stdout: e.stdout ?? '',
        };
      }
    },
    execStdin: (command: string, stdin: string | Buffer) =>
      new Promise<string>((resolve, reject) => {
        const child = execFile(
          'docker',
          ['exec', '-i', '-w', WORKSPACE_DIR, name, 'sh', '-c', command],
          { maxBuffer: 64 * 1024 * 1024 },
          (err, stdout) => (err ? reject(err) : resolve(stdout))
        );
        child.stdin?.end(stdin);
      }),
  };
  return { name, workspace };
}

// ── The run ─────────────────────────────────────────────────────────────────

/**
 * Run one Pi turn against a fresh container and report it. Always removes the
 * container. A failed turn is reported in `error`, not thrown; setup failures
 * (no Docker, a bad clone, a missing scanner source) throw.
 */
export async function runSmoke(options: SmokeOptions): Promise<{
  report: SmokeReport;
  trace: unknown;
}> {
  const log = options.log ?? (() => undefined);
  const mocked = options.mock || options.languageModel !== undefined;
  if (!mocked && !options.apiKey) {
    throw new Error('PI_SMOKE_API_KEY is required for a real model.');
  }
  if (options.noDbScanners) {
    await installBuiltinScannerPatterns();
  } else if (!process.env.DATABASE_URL) {
    throw new Error(
      'The scanners read their patterns from the database and DATABASE_URL is not set. ' +
        'Set it, or pass --no-db-scanners to run them against the built-in pattern list ' +
        '(an explicit, labelled mode: admin-added patterns are not applied).'
    );
  }

  const root = await mkdtemp(path.join(tmpdir(), 'pi-smoke-'));
  let containerName: string | undefined;
  try {
    log(`Preparing the checkout (${options.dir ?? options.repoUrl ?? 'empty'})…`);
    const checkout = await prepareCheckout(options, root);

    log(`Starting a workspace container from ${options.image}…`);
    const { name, workspace } = await startWorkspace(options.image);
    containerName = name;
    await run('docker', ['exec', name, 'mkdir', '-p', '/workspace']);
    await run('docker', ['cp', `${checkout}/.`, `${name}:${WORKSPACE_DIR}`]);

    const tracer = new MemoryTracer();
    const modelCalls: SmokeModelCall[] = [];
    const runtime = piRuntime({
      access: { apiBase: options.apiBase, apiKey: options.apiKey ?? 'unused', spec: options.model },
      deadline: AbortSignal.timeout(options.deadlineSeconds * 1000),
      languageModel: options.languageModel ?? (options.mock ? defaultMockModel() : undefined),
      loadProjectSettings: true,
      maxTurns: options.maxSteps,
      tracer: tracer as unknown as AgentTracer,
      workspace: workspace as never,
    });

    log('Running the turn…');
    const startedAt = Date.now();
    let outcome: Awaited<ReturnType<typeof runtime.runTurn>> | undefined;
    let error: string | undefined;
    try {
      // The runtime heartbeats and reads cancellation from the Temporal activity context.
      outcome = await new MockActivityEnvironment().run(() =>
        runtime.runTurn({
          onCallSpent: async (spent) => {
            for (const s of spent) {
              const call: SmokeModelCall = {
                cachedInputTokens: s.usage.cachedInputTokens ?? 0,
                cacheWriteTokens: s.usage.cacheCreationInputTokens ?? 0,
                costUsd: estimateCostUsd(s.modelSpec, {
                  cacheCreationInputTokens: s.usage.cacheCreationInputTokens,
                  cachedInputTokens: s.usage.cachedInputTokens,
                  inputTokens: s.usage.inputTokens ?? 0,
                  outputTokens: s.usage.outputTokens ?? 0,
                }),
                index: modelCalls.length + 1,
                inputTokens: s.usage.inputTokens ?? 0,
                outputTokens: s.usage.outputTokens ?? 0,
              };
              modelCalls.push(call);
              log(`  model call ${call.index}: in ${call.inputTokens} out ${call.outputTokens}`);
            }
          },
          system: DEFAULT_SYSTEM,
          user: options.prompt,
        })
      );
    } catch (err) {
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    const wallMs = Date.now() - startedAt;

    let diffStat = '';
    let diff = '';
    try {
      const after = path.join(root, 'after');
      await run('docker', ['cp', `${name}:${WORKSPACE_DIR}`, after]);
      await git(after, ['add', '-A']);
      diffStat = await git(after, ['diff', '--cached', '--stat', 'HEAD']);
      diff = await git(after, ['diff', '--cached', 'HEAD']);
    } catch (err) {
      diffStat = `(could not read the diff: ${err instanceof Error ? err.message : String(err)})`;
    }

    const known = modelCalls.every((m) => m.costUsd !== null) && modelCalls.length > 0;
    const costUsd = known ? modelCalls.reduce((n, m) => n + (m.costUsd ?? 0), 0) : null;
    const report: SmokeReport = {
      costNote: options.mock
        ? 'MOCK token counts, priced from BUILTIN_MODELS'
        : 'BUILTIN_MODELS prices; a model-catalog override in the database is not consulted',
      costUsd,
      diffStat,
      error,
      image: options.image,
      mock: mocked,
      model: options.model,
      modelCalls,
      scannerSource: options.noDbScanners ? 'built-in patterns (--no-db-scanners)' : 'database',
      steps: outcome?.steps,
      stoppedReason: outcome?.stoppedReason,
      text: outcome?.text,
      toolCallCount: outcome?.toolCallCount ?? tracer.toolCalls.length,
      toolCalls: tracer.toolCalls.map((c) => ({
        decision: decisionOf(c),
        durationMs: c.durationMs,
        error: c.error,
        input: clip(c.inputJson, 100),
        name: c.toolName,
      })),
      wallMs,
    };
    const trace = {
      activityEvents: tracer.events,
      diff,
      options: {
        apiBase: options.apiBase,
        deadlineSeconds: options.deadlineSeconds,
        dir: options.dir,
        image: options.image,
        maxSteps: options.maxSteps,
        mock: mocked,
        model: options.model,
        noDbScanners: options.noDbScanners,
        prompt: options.prompt,
        repoUrl: options.repoUrl,
      },
      outcome,
      report,
      toolCalls: tracer.toolCalls,
    };
    if (options.traceFile) {
      await writeFile(options.traceFile, `${JSON.stringify(trace, null, 2)}\n`);
    }
    return { report, trace };
  } finally {
    if (containerName) {
      await run('docker', ['rm', '-f', containerName]).catch(() => undefined);
    }
    await rm(root, { force: true, recursive: true });
  }
}
