import { resolveSettings } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import type { EgressPolicy } from '@auto-swe/shared/lib/egressPolicy';
import {
  type ResolvedTool,
  type ToolCatalogEntry,
  ToolInstallError,
  type ToolRequest,
} from '@auto-swe/shared/lib/toolCatalog';
import {
  MAX_TOOLS_FILE_BYTES,
  mergeToolRequests,
  parseToolsFile,
  TOOLS_FILE_PATH,
  ToolRequestSchema,
  ToolsFileError,
} from '@auto-swe/shared/lib/toolsFile';
import { ApplicationFailure } from '@temporalio/activity';
import { z } from 'zod';
import { persistActivityTrace } from './activityContext.js';
import { AgentTracer } from './agentTracer.js';
import { shellQuote } from './shellQuote.js';
import { loadToolCatalog } from './toolCatalogLoader.js';
import {
  classifyToolInstallFailure,
  resolveToolRequests,
  toolInstallScript,
} from './toolInstall.js';

/**
 * Everything one workspace needs to install catalog tools, kept free of Docker so the Docker and
 * Kubernetes backends share it: it only ever talks through the exec the caller hands it.
 */

/** Runs a shell command in the workspace container and resolves with stdout; rejects on failure. */
export type ToolExec = (command: string, timeoutMs?: number) => Promise<string>;

export const TOOL_INSTALL_TIMEOUT_MS = 300_000;
/** Failed late installs a workspace tolerates, at least, before refusing more. */
const MIN_FAILED_INSTALL_ATTEMPTS = 3;
const READ_TIMEOUT_MS = 60_000;
const REPO_DIR = '/workspace/target-repo';

export interface InstalledTool {
  key: string;
  version: string;
  warning?: string;
}

/**
 * Read `.auto-swe/tools.yml` as it is at `ref` — a commit that is the base, never the agent's
 * branch and never the working tree — with `git show`. Resolves with the text, or `null` when the
 * file does not exist at that ref (no file means no file entries, not an error). A file over the
 * size cap is refused before it is read; `prepare` runs first (an authenticated fetch of the base
 * when the clone holds a candidate branch instead).
 */
export async function readToolsFileFromBase(options: {
  exec: ToolExec;
  ref: string;
  prepare?: () => Promise<void>;
}): Promise<string | null> {
  if (options.ref.startsWith('-')) {
    throw new ToolsFileError(`${TOOLS_FILE_PATH} cannot be read at ref ${options.ref}`);
  }
  await options.prepare?.();
  const object = shellQuote(`${options.ref}:${TOOLS_FILE_PATH}`);
  const script = [
    `cd ${shellQuote(REPO_DIR)}`,
    `if ! git cat-file -e ${object} 2>/dev/null; then echo absent; exit 0; fi`,
    `size=$(git cat-file -s ${object})`,
    `if [ "$size" -gt ${MAX_TOOLS_FILE_BYTES} ]; then echo toolarge; exit 0; fi`,
    'echo present',
    `git show ${object} | head -c ${MAX_TOOLS_FILE_BYTES + 1}`,
  ].join('\n');
  const out = await options.exec(script, READ_TIMEOUT_MS);
  const newline = out.indexOf('\n');
  const status = (newline === -1 ? out : out.slice(0, newline)).trim();
  if (status === 'absent') {
    return null;
  }
  if (status === 'toolarge') {
    throw new ToolsFileError(`${TOOLS_FILE_PATH} is larger than ${MAX_TOOLS_FILE_BYTES} bytes`);
  }
  if (status !== 'present') {
    throw new ToolsFileError(`${TOOLS_FILE_PATH} could not be read at ${options.ref}`);
  }
  return out.slice(newline + 1);
}

const AdminToolsSchema = z.array(ToolRequestSchema);

/**
 * The tools this connection's runs ask for, or none. Nothing is requested unless
 * `workspace.toolInstall.enabled` resolves true; the repository's file is read (through
 * `readFile`, at most once) only when the connection also enables it. A malformed admin list or
 * file is a non-retryable {@link ToolInstallError}; more than `maxTools` is too.
 */
export async function planWorkspaceTools(options: {
  connectionId: string;
  teamId?: string | null;
  readFile: () => Promise<string | null>;
}): Promise<{ requests: ToolRequest[] }> {
  const team = options.teamId
    ? await prisma.team.findUnique({ select: { orgId: true }, where: { id: options.teamId } })
    : null;
  const settings = await resolveSettings(
    ['workspace.toolInstall.enabled', 'workspace.toolInstall.maxTools'],
    {
      ...(options.teamId ? { teamId: options.teamId } : {}),
      ...(team?.orgId ? { orgId: team.orgId } : {}),
    }
  );
  if (!settings['workspace.toolInstall.enabled']) {
    return { requests: [] };
  }

  const connection = await prisma.connection.findUnique({
    select: { tools: true, toolsDeny: true, toolsFileEnabled: true },
    where: { id: options.connectionId },
  });
  if (!connection) {
    throw new ToolInstallError(`connection ${options.connectionId} not found for tool install`);
  }
  const admin = AdminToolsSchema.safeParse(connection.tools ?? []);
  if (!admin.success) {
    throw new ToolInstallError(
      `the connection's tool list is invalid: ${admin.error.issues
        .map((i) => `${i.path.join('.') || 'tools'}: ${i.message}`)
        .join('; ')}`
    );
  }
  let file: ToolRequest[] = [];
  if (connection.toolsFileEnabled) {
    const text = await options.readFile();
    file = text === null ? [] : parseToolsFile(text);
  }
  return {
    requests: mergeToolRequests(
      { admin: admin.data, deny: connection.toolsDeny, file },
      settings['workspace.toolInstall.maxTools']
    ),
  };
}

/** The message `sh` printed for a failed install: our `fail()` line when there is one. */
function installFailureMessage(err: unknown): string {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  const text = typeof stderr === 'string' ? stderr : '';
  const line = text
    .split('\n')
    .reverse()
    .find((l) => l.includes('auto-swe tool install:'));
  if (line) {
    return line
      .slice(line.indexOf('auto-swe tool install:') + 'auto-swe tool install:'.length)
      .trim();
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Install the resolved entries through `exec`. A failure becomes a {@link ToolInstallError}:
 * retryable only for the script's network-failure exit code. A deprecated entry installs and its
 * warning comes back with it.
 */
export async function installResolvedTools(
  exec: ToolExec,
  resolved: readonly ResolvedTool[]
): Promise<{ installed: InstalledTool[]; durationMs: number }> {
  const started = Date.now();
  if (resolved.length === 0) {
    return { durationMs: 0, installed: [] };
  }
  try {
    await exec(toolInstallScript(resolved.map((r) => r.entry)), TOOL_INSTALL_TIMEOUT_MS);
  } catch (err) {
    const e = err as {
      code?: unknown;
      exitCode?: unknown;
      killed?: unknown;
      signal?: unknown;
    } | null;
    const exit = typeof e?.exitCode === 'number' ? e.exitCode : e?.code;
    // The outer timeout killed the script: a stalled download, so a retry can succeed.
    // Exit 124 is the `timeout(1)` convention the Kubernetes exec reports a kill with.
    const timedOut =
      exit === 124 ||
      (typeof exit !== 'number' &&
        (e?.killed === true ||
          typeof e?.signal === 'string' ||
          (err instanceof Error && /timed? ?out/i.test(err.message))));
    if (timedOut) {
      throw new ToolInstallError(
        `the install did not finish within ${TOOL_INSTALL_TIMEOUT_MS / 1000} seconds`,
        { retryable: true }
      );
    }
    throw classifyToolInstallFailure(
      typeof exit === 'number' ? exit : null,
      installFailureMessage(err)
    );
  }
  return {
    durationMs: Date.now() - started,
    installed: resolved.map((r) => ({
      key: r.entry.key,
      version: r.entry.version,
      ...(r.warning ? { warning: r.warning } : {}),
    })),
  };
}

/**
 * What an activity should throw for a tool-install failure: a retryable one stays a plain
 * `Error` (Temporal retries it), everything else is a non-retryable `TOOL_INSTALL_FAILED`.
 * Any other error is returned unchanged.
 */
export function toToolInstallFailure(err: unknown): unknown {
  if (!(err instanceof ToolInstallError)) {
    return err;
  }
  return err.retryable
    ? new Error(err.message)
    : ApplicationFailure.nonRetryable(err.message, 'TOOL_INSTALL_FAILED');
}

/**
 * Record the `workspace.tools_installed` activity event: what was installed, or the error that
 * stopped it. Best-effort and never throws, because a trace that cannot be written must not fail
 * workspace creation.
 */
export async function recordToolInstallEvent(event: {
  installed: readonly InstalledTool[];
  durationMs: number;
  error?: string;
}): Promise<void> {
  try {
    const tracer = new AgentTracer();
    tracer.addActivityEvent({
      durationMs: event.durationMs,
      ...(event.error ? { error: event.error } : {}),
      name: 'workspace.tools_installed',
      outputJson: {
        durationMs: event.durationMs,
        keys: event.installed.map((t) => t.key),
        tools: event.installed.map((t) => `${t.key}@${t.version}`),
        warnings: event.installed.flatMap((t) => (t.warning ? [t.warning] : [])),
      },
    });
    await persistActivityTrace(tracer, 'workspace');
  } catch (err) {
    console.warn(
      `[workspace] workspace.tools_installed not recorded: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * A refusal whose message this module wrote itself — a policy decision (denied, over the cap, not
 * in the catalog, a version conflict, an unreadable catalog), never text from a shell or a
 * database — so it is safe to show an agent. Any other {@link ToolInstallError} may carry script
 * output (a download URL) and must not reach one.
 */
export class ToolRefusal extends ToolInstallError {}

/**
 * Install more tools into a running workspace, for an agent that asked. Authority is the
 * connection's, exactly as at creation: a denied key is refused, the tools already installed plus
 * the new ones may not exceed `workspace.toolInstall.maxTools`, and every request must resolve
 * against the catalog (fail closed when it cannot be read). A key already installed is a no-op; a
 * different version of it is refused rather than replaced. Only the new entries run through the
 * install script. Resolves with one result per distinct requested key (`results`) and the subset
 * that was installed by this call (`fresh`).
 */
export async function installLateTools(options: {
  connectionId: string;
  teamId?: string | null;
  requests: readonly ToolRequest[];
  installed: readonly InstalledTool[];
  exec: ToolExec;
  catalog?: readonly ToolCatalogEntry[];
  /** The workspace's egress policy: a late install cannot download once the network is locked. */
  egressPolicy?: EgressPolicy;
  /** Installs that already failed in this workspace; capped so a failing key cannot loop. */
  failedAttempts?: number;
}): Promise<{ results: InstalledTool[]; fresh: InstalledTool[]; durationMs: number }> {
  const team = options.teamId
    ? await prisma.team.findUnique({ select: { orgId: true }, where: { id: options.teamId } })
    : null;
  const settings = await resolveSettings(
    ['workspace.toolInstall.enabled', 'workspace.toolInstall.maxTools'],
    {
      ...(options.teamId ? { teamId: options.teamId } : {}),
      ...(team?.orgId ? { orgId: team.orgId } : {}),
    }
  );
  if (!settings['workspace.toolInstall.enabled']) {
    throw new ToolRefusal('tool installation is not enabled for this workspace');
  }
  const connection = await prisma.connection.findUnique({
    select: { toolsDeny: true },
    where: { id: options.connectionId },
  });
  if (!connection) {
    throw new ToolRefusal('the repository connection for this workspace was not found');
  }
  if (options.egressPolicy === 'blocked' || options.egressPolicy === 'restricted') {
    throw new ToolRefusal(
      `tool installs after workspace start are unavailable under the ${options.egressPolicy} egress policy`
    );
  }
  const denied = new Set(connection.toolsDeny);
  const have = new Map(options.installed.map((t) => [t.key, t]));
  const results = new Map<string, InstalledTool>();
  const fresh: ToolRequest[] = [];
  for (const request of options.requests) {
    if (results.has(request.key) || fresh.some((r) => r.key === request.key)) {
      continue;
    }
    if (denied.has(request.key)) {
      throw new ToolRefusal(`tool '${request.key}' is denied for this repository`);
    }
    const existing = have.get(request.key);
    if (existing) {
      if (request.version && request.version !== existing.version) {
        throw new ToolRefusal(
          `tool '${request.key}' is already installed at version ${existing.version}; ${request.version} cannot replace it`
        );
      }
      results.set(request.key, existing);
      continue;
    }
    fresh.push(request);
  }
  if (fresh.length === 0) {
    return { durationMs: 0, fresh: [], results: [...results.values()] };
  }
  const max = settings['workspace.toolInstall.maxTools'];
  if ((options.failedAttempts ?? 0) >= Math.max(MIN_FAILED_INSTALL_ATTEMPTS, max)) {
    throw new ToolRefusal('too many failed install attempts in this workspace');
  }
  if (options.installed.length + fresh.length > max) {
    throw new ToolRefusal(
      `installing ${fresh.length} more would exceed the limit of ${max} tools per run (${options.installed.length} already installed)`
    );
  }
  let catalog: readonly ToolCatalogEntry[];
  try {
    catalog = options.catalog ?? (await loadToolCatalog());
  } catch (err) {
    throw new ToolRefusal('the tool catalog could not be read, so nothing was installed', {
      retryable: err instanceof ToolInstallError && err.retryable,
    });
  }
  let resolved: ResolvedTool[];
  try {
    resolved = resolveToolRequests(fresh, catalog);
  } catch (err) {
    throw new ToolRefusal(err instanceof Error ? err.message : 'the request did not resolve');
  }
  // An agent may not pin a deprecated row; only the admin list and the repository file may.
  const deprecated = resolved.find((r) => r.entry.status === 'DEPRECATED');
  if (deprecated) {
    throw new ToolRefusal(
      `tool '${deprecated.entry.key}@${deprecated.entry.version}' is deprecated and cannot be installed on request`
    );
  }
  const outcome = await installResolvedTools(options.exec, resolved);
  for (const t of outcome.installed) {
    results.set(t.key, t);
  }
  return {
    durationMs: outcome.durationMs,
    fresh: outcome.installed,
    results: [...results.values()],
  };
}
