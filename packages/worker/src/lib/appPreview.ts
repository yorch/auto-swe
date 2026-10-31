import { type PreviewConfigInput, PreviewConfigSchema } from '@auto-swe/shared/lib/previewConfig';
import type { Workspace } from '../activities/workspace.js';
import { shellQuote } from '../activities/workspace.js';
import { redactString } from './agentTracer.js';

const PREVIEW_LOG = '/tmp/.asw/preview.log';
const PREVIEW_PGID = '/tmp/.asw/preview.pgid';
const SETUP_BUDGET_MS = 15 * 60 * 1000;

export class PreviewNotReadyError extends Error {
  constructor(
    message: string,
    public readonly logTail: string
  ) {
    super(message);
    this.name = 'PreviewNotReadyError';
  }
}

function readinessScript(readyUrl: string, timeoutMs: number): string {
  return [
    `const url = ${JSON.stringify(readyUrl)};`,
    `const deadline = Date.now() + ${timeoutMs};`,
    'const pause = () => new Promise((resolve) => setTimeout(resolve, 2000));',
    'while (Date.now() < deadline) {',
    '  try {',
    '    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2000) });',
    '    if (response.status < 500) process.exit(0);',
    '  } catch {}',
    '  await pause();',
    '}',
    'process.exit(1);',
  ].join('\n');
}

function tailScript(maxBytes: number): string {
  return [
    'const fs = require("node:fs");',
    `const path = ${JSON.stringify(PREVIEW_LOG)};`,
    `const maxBytes = ${maxBytes};`,
    'try {',
    '  const fd = fs.openSync(path, "r");',
    '  const size = fs.fstatSync(fd).size;',
    '  const buffer = Buffer.alloc(Math.min(size, maxBytes));',
    '  fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));',
    '  process.stdout.write(buffer);',
    '  fs.closeSync(fd);',
    '} catch {}',
  ].join('\n');
}

/**
 * Launch the preview in its own session, so its pid is also its process-group
 * id. A shell cannot do this portably: `set -m` needs a TTY (dash prints "job
 * control turned off" and the child keeps the shell's group), so `stop()` used
 * to signal a group that did not exist and the app outlived it until the
 * container was destroyed. `spawn(..., { detached: true })` calls setsid(2).
 */
export const APP_PREVIEW_LAUNCHER = [
  'const { spawn } = require("node:child_process");',
  'const fs = require("node:fs");',
  'const [command, pgidFile, logFile] = process.argv.slice(1);',
  'const out = fs.openSync(logFile, "a");',
  'const child = spawn("sh", ["-c", command], { detached: true, stdio: ["ignore", out, out] });',
  'child.on("error", (error) => {',
  '  fs.appendFileSync(logFile, "preview failed to start: " + error.message + "\\n");',
  '  process.exitCode = 1;',
  '});',
  'child.on("spawn", () => {',
  '  fs.writeFileSync(pgidFile, String(child.pid));',
  '  child.unref();',
  '});',
].join('\n');

/** The stop side of {@link APP_PREVIEW_LAUNCHER}; exported for its contract test. */
export function previewStopScript(pgidPath: string = PREVIEW_PGID): string {
  return [
    '(async () => {',
    'const fs = require("node:fs");',
    `const path = ${JSON.stringify(pgidPath)};`,
    'try {',
    '  const pgid = Number(fs.readFileSync(path, "utf8").trim());',
    '  if (Number.isSafeInteger(pgid) && pgid > 1) {',
    '    try { process.kill(-pgid, "SIGTERM"); } catch {}',
    '    await new Promise((resolve) => setTimeout(resolve, 1500));',
    '    try { process.kill(-pgid, "SIGKILL"); } catch {}',
    '  }',
    '  fs.unlinkSync(path);',
    '} catch {}',
    '})().catch(() => {});',
  ].join('\n');
}

export async function startAppPreview(
  workspace: Workspace,
  cfg: PreviewConfigInput,
  options: { timeoutMs?: number } = {}
): Promise<{ baseUrl: string; stop(): Promise<void>; logTail(maxBytes: number): Promise<string> }> {
  const config = PreviewConfigSchema.parse(cfg);
  const timeoutMs = options.timeoutMs ?? config.readyTimeoutMs;
  const execOptions = (commandTimeoutMs: number) => ({
    timeoutMs: commandTimeoutMs,
    ...(config.env ? { secretEnv: config.env } : {}),
  });

  if (config.setup) {
    try {
      await workspace.exec(
        `sh -c ${shellQuote(config.setup)}`,
        execOptions(config.readyTimeoutMs + SETUP_BUDGET_MS)
      );
    } catch (error) {
      const detail = redactString(error instanceof Error ? error.message : String(error));
      throw new PreviewNotReadyError(`App preview setup failed: ${detail}`, detail);
    }
  }

  const startCommand =
    `mkdir -p /tmp/.asw && rm -f ${shellQuote(PREVIEW_PGID)} ${shellQuote(PREVIEW_LOG)} && ` +
    `node -e ${shellQuote(APP_PREVIEW_LAUNCHER)} ${shellQuote(config.start)} ` +
    `${shellQuote(PREVIEW_PGID)} ${shellQuote(PREVIEW_LOG)}`;
  await workspace.exec(startCommand, execOptions(10_000));

  const logTail = async (maxBytes: number): Promise<string> => {
    const boundedBytes = Number.isFinite(maxBytes)
      ? Math.max(0, Math.min(1_000_000, Math.floor(maxBytes)))
      : 0;
    if (boundedBytes === 0) {
      return '';
    }
    try {
      const output = await workspace.exec(`node -e ${shellQuote(tailScript(boundedBytes))}`, {
        timeoutMs: 10_000,
      });
      return redactString(output);
    } catch {
      return '';
    }
  };

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    await workspace.exec(`node -e ${shellQuote(previewStopScript())}`, { timeoutMs: 5000 });
  };

  try {
    await workspace.exec(`node -e ${shellQuote(readinessScript(config.readyUrl, timeoutMs))}`, {
      timeoutMs: timeoutMs + 5000,
    });
  } catch (error) {
    const tail = await logTail(4000);
    await stop().catch(() => undefined);
    const cause = redactString(error instanceof Error ? error.message : String(error));
    const detail = tail || cause;
    throw new PreviewNotReadyError(
      `App preview did not become ready within ${timeoutMs}ms${detail ? `:\n${detail}` : ''}`,
      detail
    );
  }

  return { baseUrl: config.baseUrl, logTail, stop };
}
