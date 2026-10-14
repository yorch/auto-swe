import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  BUILTIN_MODELS,
  builtinModelSpec,
  cacheMultipliers,
} from '@auto-swe/shared/lib/builtinModels';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { BUILTIN_SCANNER_PATTERNS } from '@auto-swe/shared/scannerPatterns';
import { MockActivityEnvironment } from '@temporalio/testing';
import { MockLanguageModelV4 } from 'ai/test';
import { buildMetadataBlockArgs } from '../../activities/workspace.js';
import type { AgentTracer } from '../../lib/agentTracer.js';
import { WORKSPACE_DIR } from '../harness/adapter.js';
import { piRuntime } from './runtime.js';
import { DEFAULT_SYSTEM, redactUrlCredentials, type SmokeOptions } from './smokeArgs.js';

export * from './smokeArgs.js';

/**
 * One real Pi implementer turn, end to end, outside Temporal and without a
 * database: a hardened container shaped like `createWorkspace`'s, the Pi runtime
 * with a real model binding, one `runTurn`, and a report of what happened. It is
 * the tool for the first run of the `pi` runtime against a real model; the CLI is
 * `packages/worker/scripts/piSmoke.ts`.
 */

const run = promisify(execFile);

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

// ── Host side ───────────────────────────────────────────────────────────────
//
// Everything that comes OUT of the container (the copied-back tree, above all its
// `.git`) is untrusted: the agent can write `core.fsmonitor`, hooks, a `gitdir:`
// file. So no host git ever runs against it. The diff is taken with a git
// directory the host made before the container existed, the container's tree as a
// bare work tree whose own `.git` entries have been deleted, a scratch index, and
// the config switches that run programs turned off.

/** Variables a host git or docker needs to reach the network; the API key is never among them. */
const NETWORK_ENV = [
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

/** The host environment for docker: everything but the provider key. */
function dockerEnv(): NodeJS.ProcessEnv {
  const { PI_SMOKE_API_KEY: _key, ...rest } = process.env;
  return rest;
}

/** A minimal environment for host git: no key, no user or system git config. */
function gitEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_AUTHOR_EMAIL: 'smoke@example.invalid',
    GIT_AUTHOR_NAME: 'pi-smoke',
    GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
    GIT_COMMITTER_NAME: 'pi-smoke',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    HOME: home,
    PATH: process.env.PATH,
  };
  for (const name of NETWORK_ENV) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  return { ...env, ...extra };
}

/** Config that stops git running a program named by the repository's own config. */
const NO_PROGRAMS = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'protocol.ext.allow=never',
];

async function git(
  root: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}
): Promise<string> {
  const { stdout } = await run('git', [...NO_PROGRAMS, ...args], {
    cwd: options.cwd ?? root,
    env: gitEnv(root, options.env),
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout,
  });
  return stdout;
}

const ENV_FILE = /^\.env(\..*)?$/;
const ENV_TEMPLATE = /\.(example|sample|template|dist)$/;

/**
 * Put the repository's files in `<root>/repo` with a fresh baseline commit made
 * by the host, and keep the baseline's git directory at `<root>/baseline.git`.
 * The user's own `.git` is never carried over (not for `--repo`, not for `--dir`,
 * not a nested one): a linked worktree's `.git` file points at the user's real
 * repository, and pre-existing changes in a dirty `--dir` would otherwise be
 * attributed to the agent.
 */
async function prepareCheckout(
  options: SmokeOptions,
  root: string
): Promise<{ checkout: string; baselineGitDir: string }> {
  const checkout = path.join(root, 'repo');
  if (options.dir) {
    const source = path.resolve(options.dir);
    if (!(await stat(source)).isDirectory()) {
      throw new Error(`--dir ${source} is not a directory.`);
    }
    await cp(source, checkout, {
      filter: (src) => {
        const base = path.basename(src);
        if (src === source) {
          return true;
        }
        if (base === 'node_modules' || base === '.git') {
          return false;
        }
        return options.includeEnv || !ENV_FILE.test(base) || ENV_TEMPLATE.test(base);
      },
      recursive: true,
      verbatimSymlinks: true,
    });
  } else if (options.repoUrl) {
    await git(root, ['clone', '--depth', '1', '--', options.repoUrl, checkout], {
      timeout: 180_000,
    });
    await rm(path.join(checkout, '.git'), { force: true, recursive: true });
  } else {
    await mkdir(checkout, { recursive: true });
  }
  await git(root, ['init', '-q'], { cwd: checkout });
  await git(root, ['add', '-A'], { cwd: checkout });
  await git(root, ['commit', '-q', '--allow-empty', '-m', 'baseline'], { cwd: checkout });
  // The baseline is a host-made copy, taken before the container exists.
  const baselineGitDir = path.join(root, 'baseline.git');
  await cp(path.join(checkout, '.git'), baselineGitDir, { recursive: true });
  return { baselineGitDir, checkout };
}

/**
 * The agent's changes: the container's tree compared with the baseline. Deletes
 * every `.git` entry in the copy first, then runs git against the host-made
 * directory with a scratch index.
 */
async function diffAgainstBaseline(
  root: string,
  baselineGitDir: string,
  after: string
): Promise<{ diff: string; diffStat: string }> {
  await run('find', [after, '-name', '.git', '-prune', '-exec', 'rm', '-rf', '{}', '+']);
  const env = {
    GIT_DIR: baselineGitDir,
    GIT_INDEX_FILE: path.join(root, 'index-after'),
    GIT_WORK_TREE: after,
  };
  await git(root, ['read-tree', 'HEAD'], { env });
  await git(root, ['add', '-A'], { env });
  const flags = ['--cached', '--no-ext-diff', '--no-textconv'];
  return {
    diff: await git(root, ['diff', ...flags, 'HEAD'], { env }),
    diffStat: await git(root, ['diff', ...flags, '--stat', 'HEAD'], { env }),
  };
}

// ── Workspace ───────────────────────────────────────────────────────────────

/**
 * A container hardened as `createWorkspace`'s is: the same limits and DNS from
 * `resolveWorkspaceInfra()`, `--cap-drop=ALL`, `no-new-privileges`, the
 * metadata hostnames blackholed and the metadata-IP sidecar (best effort, as
 * there). The harness model proxy's host alias is not added: the model is called
 * from this process. The name is chosen by the caller before this runs, so a
 * container created but never started is still removed by name.
 */
async function startWorkspace(
  name: string,
  image: string,
  command: string[],
  log: (line: string) => void
) {
  const infra = resolveWorkspaceInfra();
  await run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      name,
      '--init',
      ...infra.dns.map((server) => `--dns=${server}`),
      `--memory=${infra.memory}`,
      `--cpus=${infra.cpus}`,
      `--pids-limit=${infra.pidsLimit}`,
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--add-host=metadata.google.internal:0.0.0.0',
      '--add-host=metadata.gke.internal:0.0.0.0',
      ...(infra.network ? [`--network=${infra.network}`] : []),
      '--',
      image,
      ...command,
    ],
    { env: dockerEnv() }
  );
  if (infra.blockMetadata) {
    try {
      await run('sh', ['-c', buildMetadataBlockArgs(name, image)], {
        env: dockerEnv(),
        timeout: 60_000,
      });
    } catch (err) {
      log(
        `warning: metadata-IP egress block failed, continuing without it: ${
          err instanceof Error ? err.message.split('\n')[0]?.slice(0, 160) : String(err)
        }`
      );
    }
  }
  const shell = async (command: string, o?: { timeoutMs?: number }) =>
    (
      await run('docker', ['exec', '-w', WORKSPACE_DIR, name, 'sh', '-c', command], {
        env: dockerEnv(),
        maxBuffer: 64 * 1024 * 1024,
        timeout: o?.timeoutMs ?? 120_000,
      })
    ).stdout;
  return {
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
          { env: dockerEnv(), maxBuffer: 64 * 1024 * 1024 },
          (err, stdout) => (err ? reject(err) : resolve(stdout))
        );
        child.stdin?.end(stdin);
      }),
  };
}

// ── The run ─────────────────────────────────────────────────────────────────

/** The most of the diff the trace file keeps. */
const MAX_TRACE_DIFF_CHARS = 1_000_000;

/**
 * Run one Pi turn against a fresh container and report it. The container and the
 * temporary directories are removed however the run ends, an interrupt (SIGINT,
 * SIGTERM) included. A failed turn is reported in `error`, not thrown; setup
 * failures (no Docker, a bad clone, a missing scanner source) throw, with URL
 * credentials removed from the message.
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
  // Named before `docker run`, so a container that was created but failed to start is removed too.
  const containerName = `workspace-smoke-${randomBytes(4).toString('hex')}`;
  let cleaned: Promise<void> | undefined;
  const cleanup = () => {
    cleaned ??= (async () => {
      await run('docker', ['rm', '-f', containerName], { env: dockerEnv() }).catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    })();
    return cleaned;
  };
  const interrupt = new AbortController();
  const signals = options.signals ?? process;
  const onSignal = (signal: string) => {
    interrupt.abort();
    log(`${signal}: removing the container and temporary files…`);
    void cleanup().finally(() => (options.exit ?? process.exit)(signal === 'SIGINT' ? 130 : 143));
  };
  const onInt = () => onSignal('SIGINT');
  const onTerm = () => onSignal('SIGTERM');
  signals.once('SIGINT', onInt);
  signals.once('SIGTERM', onTerm);

  try {
    log(
      `Preparing the checkout (${redactUrlCredentials(options.dir ?? options.repoUrl ?? 'empty')})…`
    );
    const { baselineGitDir, checkout } = await prepareCheckout(options, root);

    log(`Starting a workspace container from ${options.image}…`);
    const workspace = await startWorkspace(
      containerName,
      options.image,
      options.containerCommand ?? ['sleep', 'infinity'],
      log
    );
    await run('docker', ['exec', containerName, 'mkdir', '-p', '/workspace'], {
      env: dockerEnv(),
    });
    await run('docker', ['cp', `${checkout}/.`, `${containerName}:${WORKSPACE_DIR}`], {
      env: dockerEnv(),
    });

    const tracer = new MemoryTracer();
    const modelCalls: SmokeModelCall[] = [];
    const runtime = piRuntime({
      access: { apiBase: options.apiBase, apiKey: options.apiKey ?? 'unused', spec: options.model },
      deadline: AbortSignal.any([
        AbortSignal.timeout(options.deadlineSeconds * 1000),
        interrupt.signal,
      ]),
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
      error = redactUrlCredentials(
        err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      );
    }
    const wallMs = Date.now() - startedAt;

    let diffStat = '';
    let diff = '';
    try {
      const after = path.join(root, 'after');
      await run('docker', ['cp', `${containerName}:${WORKSPACE_DIR}`, after], {
        env: dockerEnv(),
      });
      ({ diff, diffStat } = await diffAgainstBaseline(root, baselineGitDir, after));
    } catch (err) {
      diffStat = `(could not read the diff: ${redactUrlCredentials(
        err instanceof Error ? err.message : String(err)
      )})`;
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
      diff: diff.slice(0, MAX_TRACE_DIFF_CHARS),
      options: {
        apiBase: options.apiBase && redactUrlCredentials(options.apiBase),
        deadlineSeconds: options.deadlineSeconds,
        dir: options.dir,
        image: options.image,
        includeEnv: options.includeEnv ?? false,
        maxSteps: options.maxSteps,
        mock: mocked,
        model: options.model,
        noDbScanners: options.noDbScanners,
        prompt: options.prompt,
        repoUrl: options.repoUrl && redactUrlCredentials(options.repoUrl),
      },
      outcome,
      report,
      toolCalls: tracer.toolCalls,
    };
    if (options.traceFile) {
      // It holds the prompt, the tool output and the diff: readable by the owner only.
      await writeFile(options.traceFile, `${JSON.stringify(trace, null, 2)}\n`, { mode: 0o600 });
    }
    return { report, trace };
  } catch (err) {
    throw err instanceof Error
      ? Object.assign(new Error(redactUrlCredentials(err.message)), { name: err.name })
      : err;
  } finally {
    signals.off('SIGINT', onInt);
    signals.off('SIGTERM', onTerm);
    await cleanup();
  }
}
