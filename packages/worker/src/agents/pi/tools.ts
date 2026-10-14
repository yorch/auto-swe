import path from 'node:path';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type {
  EditOperations,
  FindOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from '@mariozechner/pi-coding-agent';
import type { Workspace } from '../../activities/workspace.js';
import { type HarnessExec, type HarnessTurn, WORKSPACE_DIR } from '../harness/adapter.js';
import { offloadIfLarge, TOOL_OUTPUT_OFFLOAD_DIR } from '../toolOutputOffload.js';
import type { PiTool } from './policy.js';

/** A file operation's ceiling; the `bash` tool has its own. */
const FILE_OP_TIMEOUT_MS = 60_000;

/** A `bash` call's ceiling, and its default: the Mastra `bash` tool's. */
export const BASH_TIMEOUT_MS = 600_000;

/** Runs `bash` when the image has it, else POSIX `sh`; output and errors interleaved. */
const BASH_SCRIPT =
  'if command -v bash >/dev/null 2>&1; then exec bash -c "$1" 2>&1; fi; exec sh -c "$1" 2>&1';

/**
 * Lists a directory's entries, NUL-separated, each prefixed `d` or `f`, so `ls`
 * learns which entries are directories from one command instead of one per
 * entry. Dot-entries are included and `.`/`..` are not.
 */
const LIST_SCRIPT =
  'cd "$1" || exit 1; for e in * .[!.]* ..?*; do if [ -e "$e" ] || [ -L "$e" ]; then ' +
  'if [ -d "$e" ]; then printf \'d%s\\0\' "$e"; else printf \'f%s\\0\' "$e"; fi; fi; done';

/**
 * Lists every file under a directory, one path per line relative to it, without
 * descending into `.git` or `node_modules`. `find` filters the list in the worker
 * ({@link matchFiles}), so the container needs only POSIX `find`.
 */
const LIST_FILES_SCRIPT =
  'cd "$1" || exit 1; find . \\( -name .git -o -name node_modules \\) -prune -o -type f -print';

/** A `grep` call's ceiling. */
const GREP_TIMEOUT_MS = 120_000;
/** `grep`'s default and greatest number of matches, and its greatest context. */
const GREP_DEFAULT_LIMIT = 100;
const GREP_MAX_LIMIT = 1000;
const GREP_MAX_CONTEXT = 20;

/** The turn whose `exec` the tools run through; set for the length of each turn. */
export interface TurnHolder {
  current?: HarnessTurn;
}

function within(root: string, p: string): boolean {
  const rel = path.posix.relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !path.posix.isAbsolute(rel));
}

/**
 * Every file operation re-checks its path against the places the policy lets
 * the tool reach. The policy already decided the call on this path; this is
 * what holds if Pi's own path handling ever opens a different one (its `read`
 * tries alternative spellings of a name that does not exist).
 */
function confine(p: string, roots: readonly string[]): void {
  if (p.includes('\0') || !path.posix.isAbsolute(p) || !roots.some((root) => within(root, p))) {
    throw new Error(`Path rejected: ${p} is outside the workspace.`);
  }
}

const READ_ROOTS = [WORKSPACE_DIR, TOOL_OUTPUT_OFFLOAD_DIR] as const;
const WRITE_ROOTS = [WORKSPACE_DIR] as const;

/** What a failed file command said, for the error Pi shows the model. */
function failure(what: string, p: string, stderr: Buffer): Error {
  const detail = stderr.toString('utf8').trim();
  return new Error(detail ? `${what} ${p}: ${detail}` : `${what} ${p}`);
}

/**
 * The container-side file operations Pi's tools run on. Each is one tagged
 * command in the workspace through the current turn's `exec`; a path travels as
 * a positional parameter, never inside the script.
 */
export function containerOperations(holder: TurnHolder) {
  const run = async (exec: Omit<HarnessExec, 'timeoutMs'>) => {
    const turn = holder.current;
    if (!turn) {
      throw new Error('No turn is running.');
    }
    return turn.exec({ timeoutMs: FILE_OP_TIMEOUT_MS, ...exec });
  };
  const ok = async (script: string, p: string) => (await run({ args: [p], script })).exitCode === 0;

  const readFile = async (p: string) => {
    confine(p, READ_ROOTS);
    const out = await run({ args: [p], script: 'cat -- "$1"' });
    if (out.exitCode !== 0) {
      throw failure('Cannot read', p, out.stderr);
    }
    if (out.droppedBytes > 0) {
      throw new Error(`Cannot read ${p}: the file is too large to read whole.`);
    }
    return out.stdout;
  };

  const writeFile = async (p: string, content: string) => {
    confine(p, WRITE_ROOTS);
    const out = await run({ args: [p], script: 'cat > "$1"', stdin: content });
    if (out.exitCode !== 0) {
      throw failure('Cannot write', p, out.stderr);
    }
  };

  // Which entries of the directory `ls` last listed are directories, so it can
  // mark them without a command per entry. Reset when an `ls` starts (its first
  // operation is `exists`), so nothing from an earlier listing is trusted.
  let listed = new Map<string, boolean>();

  const read: ReadOperations = {
    access: async (p) => {
      confine(p, READ_ROOTS);
      if (!(await ok('test -r "$1"', p))) {
        throw new Error(`File not found or not readable: ${p}`);
      }
    },
    readFile,
  };
  const write: WriteOperations = {
    mkdir: async (dir) => {
      confine(dir, WRITE_ROOTS);
      const out = await run({ args: [dir], script: 'mkdir -p -- "$1"' });
      if (out.exitCode !== 0) {
        throw failure('Cannot create directory', dir, out.stderr);
      }
    },
    writeFile,
  };
  const edit: EditOperations = {
    access: async (p) => {
      confine(p, WRITE_ROOTS);
      if (!(await ok('test -r "$1" && test -w "$1"', p))) {
        throw new Error(`File not found or not writable: ${p}`);
      }
    },
    readFile,
    writeFile,
  };
  const ls: LsOperations = {
    exists: async (p) => {
      listed = new Map();
      confine(p, READ_ROOTS);
      return ok('test -e "$1"', p);
    },
    readdir: async (dir) => {
      confine(dir, READ_ROOTS);
      const out = await run({ args: [dir], script: LIST_SCRIPT });
      if (out.exitCode !== 0) {
        throw failure('Cannot list', dir, out.stderr);
      }
      const names: string[] = [];
      for (const entry of out.stdout.toString('utf8').split('\0')) {
        if (entry.length > 1) {
          const name = entry.slice(1);
          listed.set(path.posix.join(dir, name), entry[0] === 'd');
          names.push(name);
        }
      }
      return names;
    },
    stat: async (p) => {
      const known = listed.get(p);
      if (known !== undefined) {
        return { isDirectory: () => known };
      }
      confine(p, READ_ROOTS);
      const out = await run({
        args: [p],
        script: 'if [ -d "$1" ]; then echo d; elif [ -e "$1" ]; then echo f; else exit 1; fi',
      });
      if (out.exitCode !== 0) {
        throw new Error(`Path not found: ${p}`);
      }
      const isDir = out.stdout.toString('utf8').trim() === 'd';
      return { isDirectory: () => isDir };
    },
  };
  const find: FindOperations = {
    exists: async (p) => {
      confine(p, READ_ROOTS);
      return ok('test -e "$1"', p);
    },
    glob: async (pattern, root, { limit }) => {
      confine(root, READ_ROOTS);
      const out = await run({ args: [root], script: LIST_FILES_SCRIPT });
      if (out.exitCode !== 0) {
        throw failure('Cannot search', root, out.stderr);
      }
      return matchFiles(out.stdout.toString('utf8'), pattern, root, limit);
    },
  };
  return { edit, find, ls, read, write };
}

/**
 * The files of a `find` listing that match `pattern`, as absolute paths under
 * `root`, at most `limit` of them. A pattern without a `/` matches a file's name
 * at any depth (`*.ts`), as Pi's `fd` does; one with a `/` matches its path from
 * the root (`src/**\/*.spec.ts`). Dot-directories are not matched by `*` or `**`.
 */
export function matchFiles(
  listing: string,
  pattern: string,
  root: string,
  limit: number
): string[] {
  const byName = !pattern.includes('/');
  const found: string[] = [];
  for (const line of listing.split('\n')) {
    const rel = line.startsWith('./') ? line.slice(2) : line;
    if (!rel) {
      continue;
    }
    if (path.posix.matchesGlob(byName ? path.posix.basename(rel) : rel, pattern)) {
      found.push(path.posix.join(root, rel));
      if (found.length >= limit) {
        break;
      }
    }
  }
  return found;
}

/** One `grep` result line's file, for a `file:line:` match or a `file-line-` context line. */
const GREP_LINE = /^(.+?)([:-])(\d+)[:-]/;

/**
 * `grep` output cut to `limit` matches, paths without a leading `./`, and with
 * what the fallback `grep` could not filter itself removed: files outside
 * `glob`, and anything under `.git` or `node_modules`. Returns the text and
 * whether matches were dropped.
 */
export function trimGrepOutput(
  output: string,
  options: { glob?: string; limit: number; filter: boolean }
): { text: string; truncated: boolean } {
  const kept: string[] = [];
  let matches = 0;
  let truncated = false;
  for (const raw of output.split('\n')) {
    // `grep -r .` prefixes every path with `./`; ripgrep does not.
    const line = raw.startsWith('./') ? raw.slice(2) : raw;
    const parsed = GREP_LINE.exec(line);
    if (options.filter && parsed) {
      const file = parsed[1] ?? '';
      const segments = file.split('/');
      if (segments.includes('.git') || segments.includes('node_modules')) {
        continue;
      }
      if (options.glob) {
        const subject = options.glob.includes('/') ? file : path.posix.basename(file);
        if (!path.posix.matchesGlob(subject, options.glob)) {
          continue;
        }
      }
    }
    if (parsed?.[2] === ':') {
      if (matches >= options.limit) {
        truncated = true;
        break;
      }
      matches += 1;
    }
    kept.push(line);
  }
  return { text: kept.join('\n').trim(), truncated };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}

/**
 * The model's `grep` tool, in Pi's shape (`pattern`, `path`, `glob`,
 * `ignoreCase`, `literal`, `context`, `limit`) but not Pi's implementation,
 * which always runs ripgrep on the machine the loop runs on. This one runs
 * ripgrep in the container when the image has it (which honours `.gitignore`),
 * else `grep -rn`, filtering the fallback's results by `glob` and leaving out
 * `.git` and `node_modules` in the worker. Arguments reach the command as its
 * argv, never through a shell.
 */
export function piGrepTool(options: {
  holder: TurnHolder;
  maxToolOutputChars: number;
  parameters: AgentTool['parameters'];
  workspace: Workspace;
}): AgentTool {
  const { holder, maxToolOutputChars, parameters, workspace } = options;
  // Whether the container has ripgrep, learned on first use.
  let ripgrep: Promise<boolean> | undefined;
  return {
    description:
      'Search file contents for a pattern. Returns matching lines as path:line:text, with paths ' +
      `relative to ${WORKSPACE_DIR}. Uses ripgrep when the workspace has it (respecting ` +
      `.gitignore), else grep; .git and node_modules are skipped. At most ${GREP_MAX_LIMIT} matches.`,
    async execute(_id, params, signal): Promise<AgentToolResult<undefined>> {
      const turn = holder.current;
      if (!turn) {
        throw new Error('No turn is running.');
      }
      const {
        context,
        glob,
        ignoreCase,
        literal,
        limit,
        path: root,
        pattern,
      } = params as {
        context?: number;
        glob?: string;
        ignoreCase?: boolean;
        literal?: boolean;
        limit?: number;
        path?: string;
        pattern: string;
      };
      const searchRoot = typeof root === 'string' && root ? root : WORKSPACE_DIR;
      confine(searchRoot, READ_ROOTS);
      const target = path.posix.relative(WORKSPACE_DIR, searchRoot) || '.';
      const lines = clampInt(context, 0, GREP_MAX_CONTEXT, 0);
      ripgrep ??= turn
        .exec({ script: 'command -v rg >/dev/null 2>&1', timeoutMs: 30_000 })
        .then((r) => r.exitCode === 0);
      const useRipgrep = await ripgrep;
      const flags = [...(ignoreCase ? ['-i'] : []), ...(lines > 0 ? ['-C', String(lines)] : [])];
      const argv = useRipgrep
        ? [
            'rg',
            '--line-number',
            '--no-heading',
            '--color',
            'never',
            ...(literal ? ['-F'] : []),
            ...flags,
            ...(glob ? ['-g', glob] : []),
            '-e',
            pattern,
            '--',
            target,
          ]
        : ['grep', '-rn', literal ? '-F' : '-E', ...flags, '-e', pattern, '--', target];
      const out = await turn.exec({
        args: argv,
        script: 'exec "$@"',
        signal,
        timeoutMs: GREP_TIMEOUT_MS,
      });
      if (signal?.aborted) {
        throw new Error('Search aborted');
      }
      if (out.timedOut) {
        throw new Error(`The search timed out after ${GREP_TIMEOUT_MS / 1000} seconds.`);
      }
      if (out.exitCode === 1) {
        return { content: [{ text: 'No matches found', type: 'text' }], details: undefined };
      }
      if (out.exitCode !== 0) {
        throw new Error(
          out.stderr.toString('utf8').trim() || `The search failed (exit ${out.exitCode}).`
        );
      }
      const max = clampInt(limit, 1, GREP_MAX_LIMIT, GREP_DEFAULT_LIMIT);
      const trimmed = trimGrepOutput(out.stdout.toString('utf8'), {
        filter: !useRipgrep,
        glob,
        limit: max,
      });
      if (!trimmed.text) {
        return { content: [{ text: 'No matches found', type: 'text' }], details: undefined };
      }
      const notes = [
        ...(trimmed.truncated ? [`${max} matches limit reached`] : []),
        ...(out.droppedBytes > 0 ? ['output was cut short'] : []),
      ];
      const { text } = await offloadIfLarge({
        maxChars: maxToolOutputChars,
        output: notes.length ? `${trimmed.text}\n\n[${notes.join('. ')}]` : trimmed.text,
        toolName: 'grep',
        workspace,
      });
      return { content: [{ text, type: 'text' }], details: undefined };
    },
    label: 'grep',
    name: 'grep',
    parameters,
  };
}

/**
 * The model's `bash` tool, in Pi's shape (`command`, optional `timeout` in
 * seconds) but not Pi's implementation: Pi's writes the full text of a long
 * result to the local temp directory and tells the model that path, which here
 * would be on the worker. This one runs the command in the checkout, under the
 * turn's exec tag, and offloads a long result into the workspace beside the
 * checkout (`toolOutputOffload.ts`), where the model's `read` can reach it.
 */
export function piBashTool(options: {
  holder: TurnHolder;
  maxToolOutputChars: number;
  parameters: AgentTool['parameters'];
  workspace: Workspace;
}): AgentTool {
  const { holder, maxToolOutputChars, parameters, workspace } = options;
  return {
    description:
      'Execute a shell command in the repository checkout (bash when the workspace has it, else sh). ' +
      'Returns stdout and stderr together. A non-zero exit status is reported as an error. ' +
      `Each call starts in ${WORKSPACE_DIR}. A call is stopped after its timeout ` +
      `(seconds; at most ${BASH_TIMEOUT_MS / 1000}). Output over ${maxToolOutputChars} characters ` +
      'is cut to its head and tail, and the full text saved to a file you can read.',
    async execute(_id, params, signal): Promise<AgentToolResult<undefined>> {
      const turn = holder.current;
      if (!turn) {
        throw new Error('No turn is running.');
      }
      const { command, timeout } = params as { command: string; timeout?: number };
      const timeoutMs =
        typeof timeout === 'number' && timeout > 0
          ? Math.min(timeout * 1000, BASH_TIMEOUT_MS)
          : BASH_TIMEOUT_MS;
      const out = await turn.exec({ args: [command], script: BASH_SCRIPT, signal, timeoutMs });
      if (signal?.aborted) {
        throw new Error('Command aborted');
      }
      let output = out.stdout.toString('utf8');
      if (out.droppedBytes > 0) {
        output += `\n[${out.droppedBytes} more bytes of output were discarded]`;
      }
      const { text } = await offloadIfLarge({
        maxChars: maxToolOutputChars,
        output: output.trim() || '(no output)',
        toolName: 'bash',
        workspace,
      });
      if (out.timedOut) {
        throw new Error(`${text}\n\nCommand timed out after ${timeoutMs / 1000} seconds`);
      }
      if (out.exitCode !== 0) {
        throw new Error(`${text}\n\nCommand exited with code ${out.exitCode ?? 'unknown'}`);
      }
      return { content: [{ text, type: 'text' }], details: undefined };
    },
    label: 'bash',
    name: 'bash',
    parameters,
  };
}

/**
 * The Pi tools a session offers, in Pi's own implementation where it can act on
 * the container (`read`, `write`, `edit`, `ls`, `find` over
 * {@link containerOperations}) and the worker's `bash` and `grep`
 * ({@link piBashTool}, {@link piGrepTool}). Only `granted` are built.
 */
export async function buildPiTools(options: {
  granted: readonly PiTool[];
  holder: TurnHolder;
  maxToolOutputChars: number;
  workspace: Workspace;
}): Promise<AgentTool[]> {
  const pi = await import('@mariozechner/pi-coding-agent');
  const ops = containerOperations(options.holder);
  const build: Record<PiTool, () => AgentTool> = {
    bash: () =>
      piBashTool({
        holder: options.holder,
        maxToolOutputChars: options.maxToolOutputChars,
        parameters: pi.createBashTool(WORKSPACE_DIR).parameters,
        workspace: options.workspace,
      }),
    edit: () => pi.createEditTool(WORKSPACE_DIR, { operations: ops.edit }),
    find: () => pi.createFindTool(WORKSPACE_DIR, { operations: ops.find }),
    grep: () =>
      piGrepTool({
        holder: options.holder,
        maxToolOutputChars: options.maxToolOutputChars,
        parameters: pi.createGrepTool(WORKSPACE_DIR).parameters,
        workspace: options.workspace,
      }),
    ls: () => pi.createLsTool(WORKSPACE_DIR, { operations: ops.ls }),
    // No image detection: a file is read as text, so no image is resized on the worker.
    read: () => pi.createReadTool(WORKSPACE_DIR, { operations: ops.read }),
    write: () => pi.createWriteTool(WORKSPACE_DIR, { operations: ops.write }),
  };
  return options.granted.map((tool) => build[tool]());
}
