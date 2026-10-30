import crypto from 'node:crypto';
import path from 'node:path';
import type { Workspace } from '../activities/workspace.js';
import { shellQuote } from '../activities/workspace.js';
import { BROWSER_DRIVER_SOURCE } from './driverSource.js';

const BROWSER_ROOT = '/tmp/.asw/browser';
const DRIVER_PATH = `${BROWSER_ROOT}/driver.mjs`;
const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024 * 1024;

export interface BrowserSessionOptions {
  allowedHosts: string[];
  recordVideo: boolean;
  trace: boolean;
  viewport?: { width: number; height: number };
  /** Bytes the worker will read back for a recording. Defaults to 100 MiB. */
  maxVideoBytes?: number;
  /** Bytes the worker will read back for a trace archive. Defaults to 100 MiB. */
  maxTraceBytes?: number;
}

export interface BrowserSessionOutputs {
  video?: Buffer;
  trace?: Buffer;
  /** Artifacts the driver finalized but the worker could not read back. */
  errors: string[];
}

export interface DriverCommand {
  cmd: string;
  [key: string]: unknown;
}

export interface DriverResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export class BrowserSession {
  private readonly sessionRoot: string;
  private readonly socketPath: string;
  private readonly outputDir: string;
  private queue: Promise<void> = Promise.resolve();
  private closing = false;
  private closeResponse?: Promise<DriverResult>;

  private constructor(
    private readonly workspace: Workspace,
    sessionId: string,
    private readonly options: BrowserSessionOptions
  ) {
    this.sessionRoot = `${BROWSER_ROOT}/${sessionId}`;
    this.socketPath = `${this.sessionRoot}/driver.sock`;
    this.outputDir = `${this.sessionRoot}/out`;
  }

  static async start(workspace: Workspace, opts: BrowserSessionOptions): Promise<BrowserSession> {
    const checkScript =
      'require.resolve("playwright"); const p=require("playwright"); require("node:fs").accessSync(p.chromium.executablePath())';
    try {
      await workspace.exec(`node -e ${shellQuote(checkScript)}`, { timeoutMs: 20_000 });
    } catch {
      throw new Error(
        'this workspace image has no browser; use defaults/Dockerfile.node-browser for UI validation'
      );
    }

    const session = new BrowserSession(workspace, crypto.randomBytes(8).toString('hex'), opts);
    await workspace.execStdin(
      `mkdir -p ${shellQuote(BROWSER_ROOT)} && cat > ${shellQuote(DRIVER_PATH)}`,
      BROWSER_DRIVER_SOURCE
    );
    const config = JSON.stringify({
      allowedHosts: opts.allowedHosts,
      recordVideo: opts.recordVideo,
      trace: opts.trace,
      ...(opts.viewport ? { viewport: opts.viewport } : {}),
    });
    const launch =
      `nohup node ${shellQuote(DRIVER_PATH)} serve --socket ${shellQuote(session.socketPath)} --out ${shellQuote(session.outputDir)} --config ${shellQuote(config)} > ${shellQuote(`${session.sessionRoot}/daemon.log`)} 2>&1 < /dev/null & ` +
      `echo $! > ${shellQuote(`${session.sessionRoot}/driver.pid`)}`;
    const command = `mkdir -p ${shellQuote(session.sessionRoot)} ${shellQuote(session.outputDir)} && (${launch})`;
    await workspace.exec(command, { timeoutMs: 10_000 });

    const readyScript = [
      'const fs=require("node:fs"); const socket=process.argv[1]; const root=process.argv[2];',
      'const deadline=Date.now()+20000;',
      'const check=()=>{',
      'if(fs.existsSync(socket)) process.exit(0);',
      'const pidFile=root+"/driver.pid";',
      'if(fs.existsSync(pidFile)){try{process.kill(Number(fs.readFileSync(pidFile,"utf8")),0)}catch{',
      'let log=""; try{log=fs.readFileSync(root+"/daemon.log","utf8")}catch{}',
      'process.stderr.write(log.slice(-4000)); process.exit(1)}}',
      'if(Date.now()>=deadline){',
      'let log=""; try{log=fs.readFileSync(root+"/daemon.log","utf8")}catch{}',
      'process.stderr.write(log.slice(-4000)); process.exit(1)}',
      'setTimeout(check,100)}; check();',
    ].join('');
    try {
      await workspace.exec(
        `node -e ${shellQuote(readyScript)} ${shellQuote(session.socketPath)} ${shellQuote(session.sessionRoot)}`,
        { timeoutMs: 25_000 }
      );
    } catch (error) {
      throw new Error(
        `browser driver did not start within 20 seconds: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return session;
  }

  call(command: DriverCommand): Promise<DriverResult> {
    if (command.cmd === 'close') {
      this.closing = true;
      this.closeResponse ??= this.enqueue(command);
      return this.closeResponse;
    }
    if (this.closing) {
      return Promise.reject(new Error('browser session is closing'));
    }
    return this.enqueue(command);
  }

  private enqueue(command: DriverCommand): Promise<DriverResult> {
    const result = this.queue.then(() => this.send(command));
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async readOutFile(filePath: string, maxBytes: number): Promise<Buffer> {
    const resolved = path.resolve(filePath);
    const relative = path.relative(this.outputDir, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('browser output path must be inside the session output directory');
    }
    return this.workspace.readFile(resolved, maxBytes);
  }

  async close(): Promise<BrowserSessionOutputs> {
    this.closing = true;
    this.closeResponse ??= this.enqueue({ cmd: 'close' });
    const result = await this.closeResponse;
    if (!result.ok) {
      throw new Error(result.error ?? 'browser session failed to close');
    }
    const errors: string[] = [];
    const read = async (
      file: unknown,
      maxBytes: number,
      label: string
    ): Promise<Buffer | undefined> => {
      if (typeof file !== 'string') {
        return undefined;
      }
      try {
        return await this.readOutFile(file, maxBytes);
      } catch (error) {
        // One unreadable artifact must not cost the other: the video is finalized
        // before the trace is read, and both are gone once the workspace dies.
        errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    };
    const video = await read(
      result.video,
      this.options.maxVideoBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      'recording'
    );
    const trace = await read(
      result.trace,
      this.options.maxTraceBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      'trace'
    );
    return {
      ...(video ? { video } : {}),
      ...(trace ? { trace } : {}),
      errors,
    };
  }

  private async send(command: DriverCommand): Promise<DriverResult> {
    const json = JSON.stringify(command);
    const script = `${shellQuote(DRIVER_PATH)} call --socket ${shellQuote(this.socketPath)} ${shellQuote(json)}`;
    const timeoutMs =
      typeof command.timeoutMs === 'number'
        ? Math.max(10_000, Math.min(125_000, command.timeoutMs + 5_000))
        : 35_000;
    const stdout = await this.workspace.exec(`node ${script}`, { timeoutMs });
    const line = stdout.trim().split('\n').at(-1);
    if (!line) {
      throw new Error(`browser driver returned no response for ${command.cmd}`);
    }
    const result = JSON.parse(line) as DriverResult;
    if (typeof result.ok !== 'boolean') {
      throw new Error('browser driver returned an invalid response');
    }
    return result;
  }
}
