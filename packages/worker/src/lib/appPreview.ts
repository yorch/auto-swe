import { type PreviewConfigInput, PreviewConfigSchema } from '@auto-swe/shared/lib/previewConfig';
import type { Workspace } from '../activities/workspace.js';
import { shellQuote } from '../activities/workspace.js';
import { redactString } from './agentTracer.js';

const PREVIEW_LOG = '/tmp/.asw/preview.log';
const PREVIEW_PGID = '/tmp/.asw/preview.pgid';
const PREVIEW_MARK = `${PREVIEW_PGID}.mark`;
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
 * Launch the preview in its own session for process-group cleanup.
 * `detached` spawning calls setsid(2); the environment mark lets `stop()` find
 * descendants that daemonize out of the group.
 */
export const APP_PREVIEW_LAUNCHER = [
  'const crypto = require("node:crypto");',
  'const { spawn } = require("node:child_process");',
  'const fs = require("node:fs");',
  'const [command, pgidFile, logFile, markFile] = process.argv.slice(1);',
  'const mark = crypto.randomBytes(16).toString("hex");',
  'const out = fs.openSync(logFile, "a");',
  'const child = spawn("sh", ["-c", command], {',
  '  detached: true,',
  '  env: { ...process.env, AUTO_SWE_PREVIEW_MARK: mark },',
  '  stdio: ["ignore", out, out],',
  '});',
  'child.on("error", (error) => {',
  '  fs.appendFileSync(logFile, "preview failed to start: " + error.message + "\\n");',
  '  process.exitCode = 1;',
  '});',
  'child.on("spawn", () => {',
  '  fs.writeFileSync(pgidFile, String(child.pid));',
  '  fs.writeFileSync(markFile, mark);',
  '  child.unref();',
  '});',
].join('\n');

/** The stop side of {@link APP_PREVIEW_LAUNCHER}; exported for its contract test. */
export function previewStopScript(
  pgidPath: string = PREVIEW_PGID,
  markPath: string = `${pgidPath}.mark`
): string {
  return [
    '(async () => {',
    'const fs = require("node:fs");',
    `const pgidPath = ${JSON.stringify(pgidPath)};`,
    `const markPath = ${JSON.stringify(markPath)};`,
    'let pgid = 0;',
    'try { pgid = Number(fs.readFileSync(pgidPath, "utf8").trim()); } catch {}',
    'const hasGroup = Number.isSafeInteger(pgid) && pgid > 1;',
    'let mark = "";',
    'try { mark = fs.readFileSync(markPath, "utf8").trim(); } catch {}',
    'const hasMark = /^[a-f0-9]{32}$/.test(mark);',
    'const signalMarked = (signal) => {',
    '  if (!hasMark) return;',
    '  let entries;',
    '  try { entries = fs.readdirSync("/proc"); } catch { return; }',
    '  const expected = "AUTO_SWE_PREVIEW_MARK=" + mark;',
    '  for (const entry of entries) {',
    '    if (!/^\\d+$/.test(entry)) continue;',
    '    const pid = Number(entry);',
    '    if (pid <= 1 || pid === process.pid) continue;',
    '    try {',
    '      const environment = fs.readFileSync("/proc/" + entry + "/environ", "utf8");',
    '      if (environment.split("\\0").includes(expected)) process.kill(pid, signal);',
    '    } catch {}',
    '  }',
    '};',
    'if (hasGroup) {',
    '  try { process.kill(-pgid, "SIGTERM"); } catch {}',
    '}',
    'signalMarked("SIGTERM");',
    'await new Promise((resolve) => setTimeout(resolve, 1500));',
    'if (hasGroup) {',
    '  try { process.kill(-pgid, "SIGKILL"); } catch {}',
    '}',
    'signalMarked("SIGKILL");',
    'for (const file of [pgidPath, markPath]) {',
    '  try { fs.unlinkSync(file); } catch {}',
    '}',
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
    `mkdir -p /tmp/.asw && rm -f ${shellQuote(PREVIEW_PGID)} ${shellQuote(PREVIEW_MARK)} ${shellQuote(PREVIEW_LOG)} && ` +
    `node -e ${shellQuote(APP_PREVIEW_LAUNCHER)} -- ${shellQuote(config.start)} ` +
    `${shellQuote(PREVIEW_PGID)} ${shellQuote(PREVIEW_LOG)} ${shellQuote(PREVIEW_MARK)}`;
  try {
    await workspace.exec(startCommand, execOptions(10_000));
  } catch (error) {
    const detail = redactString(error instanceof Error ? error.message : String(error));
    throw new PreviewNotReadyError(`App preview failed to start: ${detail}`, detail);
  }

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
