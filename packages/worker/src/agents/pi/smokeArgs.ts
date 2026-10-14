import type { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { LanguageModel } from 'ai';

/**
 * The smoke tool's options and flag parsing. Nothing heavy is imported here, so
 * `--help` and a bad flag work without a database or the worker's modules.
 */

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
  /** Copy `.env*` files from `dir` too (left out by default: a real model drives the container). */
  includeEnv?: boolean;
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
  /** The container's command, in place of `sleep infinity` (tests that need a start that fails). */
  containerCommand?: string[];
  /** Ends the process after an interrupt has cleaned up; `process.exit` unless a test replaces it. */
  exit?: (code: number) => void;
  /** Where SIGINT and SIGTERM are heard; `process` unless a test supplies its own emitter. */
  signals?: EventEmitter;
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
  --dir <path>               local directory to copy in instead of cloning (no .git, no
                             node_modules, no .env* files unless --include-env)
  --include-env              also copy .env* files from --dir into the container
  --prompt <text>            the task              (default: write SMOKE.md)
  --max-steps <n>            model-call cap        (default 12)
  --deadline-seconds <n>     wall-clock deadline   (default 300)
  --trace-file <path>        full JSON trace       (default: a file under the system temp dir, path printed;
                             it holds the prompt and the diff)
  --no-db-scanners           scanners use the built-in pattern list, not the database
  --mock                     scripted model; no key, no network
  --help

Relative --dir and --trace-file paths mean the directory you ran the command from.
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
      'include-env': { type: 'boolean' },
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
    includeEnv: values['include-env'] ?? env.PI_SMOKE_INCLUDE_ENV === '1',
    maxSteps: positive(pick(values['max-steps'], 'MAX_STEPS'), 12, '--max-steps'),
    mock,
    model: pick(values.model, 'MODEL') || DEFAULT_MODEL,
    noDbScanners: values['no-db-scanners'] ?? env.PI_SMOKE_NO_DB_SCANNERS === '1',
    prompt: pick(values.prompt, 'PROMPT') || DEFAULT_PROMPT,
    repoUrl: dir ? undefined : repoUrl || DEFAULT_REPO,
    traceFile:
      pick(values['trace-file'], 'TRACE_FILE') ||
      path.join(tmpdir(), `pi-smoke-trace-${Date.now()}.json`),
  };
}

/** `text` with the userinfo of any URL in it (`https://user:token@host`) replaced, for logs, traces and errors. */
export function redactUrlCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');
}
