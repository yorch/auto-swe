import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { getArtifact } from '@auto-swe/shared/lib/artifactStore';
import { MEMORY_SECURITY_EVENTS } from '@auto-swe/shared/lib/scannerCache';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import {
  type NormalizedCall,
  type NormalizedPart,
  normalizeTranscriptRecord,
} from '@auto-swe/shared/lib/transcripts/normalize';
import { SECURITY_CHECK_FAILED_PREFIX } from '../agents/preWriteSecurityCheck.js';
import type { AgentTracer } from './agentTracer.js';
import type { ResolveCtx } from './config/types.js';
import { memoryInjectionMatches } from './memoryGuard.js';

/**
 * A digest of what the implementer did, read from the run's agent transcripts
 * (`docs/transcripts.md`) for the lesson writer: the non-shell tool calls that
 * failed, the shell commands that failed (listed there only), the files written
 * over and over, and each session's last words. Extracted by code — no model
 * call — and bounded like the attempt history (`lessonAttemptHistory.ts`),
 * because it goes into a prompt.
 *
 * Records are folded into the extraction one at a time and dropped, so the heap
 * holds one decompressed part plus a bounded summary, never a whole transcript.
 *
 * Best-effort throughout: a digest that cannot be built is traced as
 * {@link DIGEST_UNAVAILABLE} and the lesson is written without it.
 */

/** The activities whose sessions are the implementer's: the first pass, the fixers, the merge resolver. */
export const IMPLEMENTER_ACTIVITY_TYPES = [
  'executeImplementation',
  'executeCIFixImplementation',
  'executeReviewFixImplementation',
  'executeGateFixImplementation',
  'resolveMergeConflict',
] as const;
/** Newest transcripts read, after retries are collapsed. */
export const TRANSCRIPTS_READ = 3;
/** Transcript rows considered before retries are collapsed. */
export const TRANSCRIPT_ROWS_CONSIDERED = 50;
/** Uncompressed bytes read across every part of every transcript. */
export const READ_BYTE_LIMIT = 8 * 1024 * 1024;
/** The whole digest — the setting, reading, parsing and scanning — must finish within this. */
export const DIGEST_TIMEOUT_MS = 20_000;
/** Most entries kept of each kind; the latest ones win. */
export const DIGEST_ENTRIES_KEPT = 5;
/** Characters shared by every kept entry of every kind, in equal shares. */
export const DIGEST_TEXT_LIMIT = 4_000;
/** A file written at least this many times is churn. */
export const CHURN_WRITES = 3;

const INPUT_LIMIT = 200;
const ERROR_LIMIT = 300;
const OUTPUT_LIMIT = 300;
const PATH_LIMIT = 200;
const NOTE_LIMIT = 400;

export const DIGEST_EVENT = 'memory.transcript_digest';
export const DIGEST_UNAVAILABLE = 'memory.transcript_digest_unavailable';

/**
 * How the Mastra workspace tools (`agents/workspaceTools.ts`) report a failure:
 * they catch it and return text, so the result is not marked as an error.
 * `Write blocked:` is the sensitive-file check (`lib/sensitiveFileScanner.ts`).
 */
export const MASTRA_FAILURE_PREFIXES = [
  'Error reading file: ',
  'Error writing file: ',
  'Error listing directory: ',
  'Write blocked: ',
  SECURITY_CHECK_FAILED_PREFIX,
] as const;
const MASTRA_FILE_TOOLS = new Set(['readFile', 'writeFile', 'listDirectory']);
/** The Mastra tools whose results come back as the tool's JSON output, as text. */
const MASTRA_TOOLS = new Set([...MASTRA_FILE_TOOLS, 'bash']);
const BASH_TOOLS = new Set(['bash', 'Bash']);
/** Tool name → the input field naming the file it writes (Mastra, then Claude Code). */
const WRITE_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  writeFile: 'path',
};

export interface FailedTool {
  tool: string;
  input: string;
  error: string;
}
export interface FailedCommand {
  command: string;
  output: string;
}
export interface ChurnFile {
  path: string;
  writes: number;
}

export interface TranscriptDigest {
  /** The transcripts that contributed an entry, oldest first. */
  transcriptIds: string[];
  failedTools: FailedTool[];
  failedCommands: FailedCommand[];
  churnFiles: ChurnFile[];
  finalNotes: string[];
  /** Entries left out because they matched an injection pattern. */
  dropped: number;
}

interface Extracted {
  failedTools: FailedTool[];
  failedCommands: FailedCommand[];
  churnFiles: ChurnFile[];
  finalNotes: string[];
}

/** Does the digest carry anything for the lesson writer? */
export function digestHasEntries(digest: TranscriptDigest | null | undefined): boolean {
  return Boolean(
    digest &&
      (digest.failedTools.length ||
        digest.failedCommands.length ||
        digest.churnFiles.length ||
        digest.finalNotes.length)
  );
}

class DigestUnavailable extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

interface Cancel {
  cancelled: boolean;
}

/** Stop the work, not just the wait: called at every step a timed-out digest could still take. */
function checkCancelled(cancel: Cancel): void {
  if (cancel.cancelled) {
    throw new DigestUnavailable('timeout');
  }
}

const gunzipAsync = promisify(gunzip);

/**
 * The run's digest, or null when `memory.lessonTranscriptEvidence` is off (no
 * read at all) or the digest could not be built in {@link DIGEST_TIMEOUT_MS}.
 */
export async function transcriptDigest(
  workflowRunId: string,
  tracer: AgentTracer,
  settingCtx: ResolveCtx = {}
): Promise<TranscriptDigest | null> {
  const cancel: Cancel = { cancelled: false };
  let timer: NodeJS.Timeout | undefined;
  try {
    const digest = await Promise.race([
      (async () => {
        if (!(await resolveSetting('memory.lessonTranscriptEvidence', settingCtx))) {
          return null;
        }
        checkCancelled(cancel);
        return buildDigest(workflowRunId, tracer, cancel);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          cancel.cancelled = true;
          reject(new DigestUnavailable('timeout'));
        }, DIGEST_TIMEOUT_MS);
      }),
    ]);
    if (!digest) {
      return null;
    }
    tracer.addActivityEvent({
      name: DIGEST_EVENT,
      outputJson: {
        churnFiles: digest.churnFiles.length,
        dropped: digest.dropped,
        failedCommands: digest.failedCommands.length,
        failedTools: digest.failedTools.length,
        finalNotes: digest.finalNotes.length,
        transcriptIds: digest.transcriptIds,
      },
    });
    return digest;
  } catch (err) {
    cancel.cancelled = true;
    tracer.addActivityEvent({
      ...(err instanceof DigestUnavailable
        ? {}
        : { error: err instanceof Error ? err.message : String(err) }),
      name: DIGEST_UNAVAILABLE,
      outputJson: { reason: err instanceof DigestUnavailable ? err.reason : 'error' },
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface TranscriptRow {
  id: string;
  activityType: string;
  recordingId: string | null;
  stepAttempt: number | null;
  attempt: number;
}

/**
 * The newest {@link TRANSCRIPTS_READ} transcripts once retries are collapsed:
 * of the attempts of one scheduled activity — the same activity type, recording
 * id and step attempt — only the highest Temporal attempt is kept. A row
 * without a recording id cannot be matched to its retries and is kept. Pure;
 * `rows` newest first.
 */
export function latestAttempts(rows: readonly TranscriptRow[]): TranscriptRow[] {
  const best = new Map<string, TranscriptRow>();
  for (const row of rows) {
    if (row.recordingId == null) {
      continue;
    }
    const key = `${row.activityType}|${row.recordingId}|${row.stepAttempt ?? ''}`;
    const seen = best.get(key);
    if (!seen || row.attempt > seen.attempt) {
      best.set(key, row);
    }
  }
  return rows
    .filter((row) => {
      if (row.recordingId == null) {
        return true;
      }
      return best.get(`${row.activityType}|${row.recordingId}|${row.stepAttempt ?? ''}`) === row;
    })
    .slice(0, TRANSCRIPTS_READ);
}

async function buildDigest(
  runId: string,
  tracer: AgentTracer,
  cancel: Cancel
): Promise<TranscriptDigest> {
  const rows = await runUnscoped(
    'scoped to the one run the lesson is written about',
    ['AgentTranscript'],
    () =>
      prisma.agentTranscript.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          activityType: true,
          attempt: true,
          id: true,
          recordingId: true,
          stepAttempt: true,
        },
        take: TRANSCRIPT_ROWS_CONSIDERED,
        where: {
          activityType: { in: [...IMPLEMENTER_ACTIVITY_TYPES] },
          runId,
          status: { not: 'open' },
        },
      })
  );
  checkCancelled(cancel);
  // Newest first, so the read bound leaves out the oldest session.
  const budget = { remaining: READ_BYTE_LIMIT };
  const folded: { id: string; staged: Staged }[] = [];
  for (const { id } of latestAttempts(rows)) {
    if (budget.remaining <= 0) {
      break;
    }
    checkCancelled(cancel);
    const staged = await readTranscript(id, budget, cancel);
    if (staged && contributed(staged)) {
      folded.push({ id, staged });
    }
  }
  folded.reverse();
  const extracted = merge(folded.map((t) => t.staged));
  const transcriptIds = folded.map((t) => t.id);
  return scanDigest({ ...bounded(extracted), transcriptIds }, tracer, cancel);
}

/**
 * One transcript, folded part by part, line by line. Null when a part's sha256
 * does not match: the transcript is skipped whole. Reading stops at the part
 * that would take the total past {@link READ_BYTE_LIMIT}, keeping what came
 * before it.
 */
async function readTranscript(
  transcriptId: string,
  budget: { remaining: number },
  cancel: Cancel
): Promise<Staged | null> {
  const parts = await prisma.agentTranscriptPart.findMany({
    orderBy: { seq: 'asc' },
    select: { artifactId: true, sha256: true },
    where: { transcriptId },
  });
  const fold = new TranscriptFold();
  for (const part of parts) {
    if (budget.remaining <= 0) {
      break;
    }
    checkCancelled(cancel);
    const { body } = await getArtifact(part.artifactId);
    checkCancelled(cancel);
    if (createHash('sha256').update(body).digest('hex') !== part.sha256) {
      return null;
    }
    let bytes: Buffer;
    try {
      bytes = await gunzipAsync(body, { maxOutputLength: budget.remaining });
    } catch (err) {
      if (
        (err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ||
        err instanceof RangeError
      ) {
        budget.remaining = 0;
        break;
      }
      throw err;
    }
    budget.remaining -= bytes.length;
    const text = bytes.toString('utf8');
    let start = 0;
    while (start < text.length) {
      checkCancelled(cancel);
      const end = text.indexOf('\n', start);
      const line = text.slice(start, end === -1 ? text.length : end);
      start = end === -1 ? text.length : end + 1;
      if (line.trim() === '') {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const call =
        record && typeof record === 'object' ? normalizeTranscriptRecord(record as never) : null;
      if (call) {
        fold.add(call);
      }
    }
  }
  return fold.staged;
}

// ── Extraction ──────────────────────────────────────────────────────────────

type ToolCall = Extract<NormalizedPart, { type: 'tool_call' }>;
type ToolResult = Extract<NormalizedPart, { type: 'tool_result' }>;

/** What one transcript contributes, already bounded: the latest distinct entries of each kind. */
interface Staged {
  failedTools: FailedTool[];
  failedCommands: FailedCommand[];
  writes: Map<string, number>;
  note: string;
}

/** The part of a tool call kept until its result arrives: capped strings, never the input. */
interface PendingCall {
  name: string;
  command: string;
  input: string;
}

function contributed(staged: Staged): boolean {
  return Boolean(
    staged.failedTools.length || staged.failedCommands.length || staged.writes.size || staged.note
  );
}

/**
 * Fold one transcript's calls into its {@link Staged} summary.
 *
 * A model call's request repeats the conversation so far, so the same tool call
 * and result appear in every later record. With unique call ids, both are keyed
 * by id and a result is paired with its call by that id — across records, as a
 * Claude Code harness turn carries the call and the next turn its result.
 *
 * A provider whose calls have no unique id (Google's are keyed by the tool's
 * name) is paired by position within the record: the k-th call named X with
 * the k-th result named X. Its replays are told apart by the call's name and
 * input, plus the result's text, so a write counts once however often the
 * history repeats it.
 */
export class TranscriptFold {
  readonly staged: Staged = { failedCommands: [], failedTools: [], note: '', writes: new Map() };
  private readonly pending = new Map<string, PendingCall>();
  private readonly done = new Set<string>();

  add(call: NormalizedCall): void {
    const calls: ToolCall[] = [];
    const results: ToolResult[] = [];
    for (const part of [...call.messages.flatMap((m) => m.content), ...call.response.content]) {
      if (part.type === 'tool_call') {
        calls.push(part);
      } else if (part.type === 'tool_result') {
        results.push(part);
      }
    }
    const ids = new Set(calls.map((c) => c.id));
    const positional = ids.size !== calls.length || calls.some((c) => !c.id || c.id === c.name);
    if (positional) {
      this.addPositional(calls, results);
    } else {
      this.addById(calls, results);
    }
    const note = assistantText(call);
    if (note) {
      this.staged.note = head(note, NOTE_LIMIT);
    }
  }

  private addById(calls: ToolCall[], results: ToolResult[]): void {
    for (const c of calls) {
      const key = `id:${c.id}`;
      if (!this.done.has(key) && !this.pending.has(c.id)) {
        this.countWrite(c);
        this.pending.set(c.id, pendingCall(c));
      }
    }
    for (const r of results) {
      const p = this.pending.get(r.id);
      if (p) {
        this.pending.delete(r.id);
        this.done.add(`id:${r.id}`);
        this.emit(p, r);
      }
    }
  }

  private addPositional(calls: ToolCall[], results: ToolResult[]): void {
    const resultsByName = new Map<string, ToolResult[]>();
    for (const r of results) {
      resultsByName.set(r.id, [...(resultsByName.get(r.id) ?? []), r]);
    }
    const nth = new Map<string, number>();
    for (const c of calls) {
      const k = nth.get(c.name) ?? 0;
      nth.set(c.name, k + 1);
      const callKey = `${c.name}\u0000${stableJson(c.input)}`;
      const writeKey = `write:${hash(callKey)}`;
      if (!this.done.has(writeKey)) {
        this.done.add(writeKey);
        this.countWrite(c);
      }
      const r = resultsByName.get(c.name)?.[k];
      if (!r) {
        continue;
      }
      const text = resultText(r.output, MASTRA_TOOLS.has(c.name));
      const pairKey = `pair:${hash(`${callKey}\u0000${text}`)}`;
      if (!this.done.has(pairKey)) {
        this.done.add(pairKey);
        this.emit(pendingCall(c), r, text);
      }
    }
  }

  private countWrite(c: ToolCall): void {
    const field = WRITE_TOOLS[c.name];
    const path = field ? asRecord(c.input)[field] : undefined;
    if (typeof path === 'string' && path !== '') {
      bump(this.staged.writes, path, 1);
    }
  }

  private emit(p: PendingCall, r: ToolResult, known?: string): void {
    const text = known ?? resultText(r.output, MASTRA_TOOLS.has(p.name));
    const isError = r.isError === true;
    if (BASH_TOOLS.has(p.name)) {
      if (commandFailed(p.name, text, isError)) {
        pushLatest(this.staged.failedCommands, {
          command: p.command,
          output: tail(text, OUTPUT_LIMIT),
        });
      }
      return;
    }
    if (toolFailed(p.name, text, isError)) {
      pushLatest(this.staged.failedTools, {
        error: head(text, ERROR_LIMIT),
        input: p.input,
        tool: p.name,
      });
    }
  }
}

function pendingCall(c: ToolCall): PendingCall {
  const input = asRecord(c.input);
  return {
    command: head(typeof input.command === 'string' ? input.command : '', INPUT_LIMIT),
    input: head(toolInputText(input, c.input), INPUT_LIMIT),
    name: c.name,
  };
}

/** Merge the transcripts' summaries, oldest first, into the four kinds. */
function merge(staged: readonly Staged[]): Extracted {
  const failedTools: FailedTool[] = [];
  const failedCommands: FailedCommand[] = [];
  const finalNotes: string[] = [];
  const writes = new Map<string, number>();
  for (const s of staged) {
    for (const t of s.failedTools) {
      pushLatest(failedTools, t);
    }
    for (const c of s.failedCommands) {
      pushLatest(failedCommands, c);
    }
    for (const [path, n] of s.writes) {
      bump(writes, path, n);
    }
    if (s.note) {
      pushLatest(finalNotes, s.note);
    }
  }
  return {
    churnFiles: [...writes]
      .filter(([, n]) => n >= CHURN_WRITES)
      .map(([path, n]) => ({ path: head(path, PATH_LIMIT), writes: n }))
      .slice(-DIGEST_ENTRIES_KEPT),
    failedCommands,
    failedTools,
    finalNotes,
  };
}

/** Add to a count, re-inserting so the map's order is the order of each key's last bump. */
function bump(map: Map<string, number>, key: string, by: number): void {
  const n = (map.get(key) ?? 0) + by;
  map.delete(key);
  map.set(key, n);
}

/**
 * Append, dropping an identical earlier copy, and keep the latest
 * {@link DIGEST_ENTRIES_KEPT}. Keeping each transcript's latest distinct entries
 * loses nothing the merged latest-distinct could have kept.
 */
function pushLatest<T>(list: T[], entry: T): void {
  const key = JSON.stringify(entry);
  const i = list.findIndex((e) => JSON.stringify(e) === key);
  if (i !== -1) {
    list.splice(i, 1);
  }
  list.push(entry);
  if (list.length > DIGEST_ENTRIES_KEPT) {
    list.shift();
  }
}

/** The text the assistant wrote in this call, if any. */
function assistantText(call: NormalizedCall): string {
  const parts = [
    ...call.response.content,
    // A Claude Code harness message carries the assistant's turn as a message.
    ...(call.provider === 'claude-code'
      ? call.messages.filter((m) => m.role === 'assistant').flatMap((m) => m.content)
      : []),
  ];
  return parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n')
    .trim();
}

const MASTRA_EXIT = /^Command finished \(exit code (\d+)\)/;
const CLAUDE_CODE_EXIT = /^Exit code (\d+)/;

/**
 * A shell call failed when its result is marked as an error, or in the tool's
 * own format: the Mastra `bash` tool's `Command finished (exit code N)` (or
 * `Command failed:` when the command could not run) at the start of its output,
 * Claude Code's `Exit code N` on the first line. An `exit code` anywhere else in
 * the output is the command's own text and says nothing.
 */
function commandFailed(tool: string, output: string, isError: boolean): boolean {
  if (isError) {
    return true;
  }
  if (tool === 'bash') {
    if (output.startsWith('Command failed:')) {
      return true;
    }
    const match = MASTRA_EXIT.exec(output);
    return match !== null && Number(match[1]) !== 0;
  }
  const match = CLAUDE_CODE_EXIT.exec(output);
  return match !== null && Number(match[1]) !== 0;
}

/** A non-shell tool failed when its result is marked as an error, or a Mastra tool said so. */
function toolFailed(tool: string, output: string, isError: boolean): boolean {
  return (
    isError ||
    (MASTRA_FILE_TOOLS.has(tool) && MASTRA_FAILURE_PREFIXES.some((p) => output.startsWith(p)))
  );
}

/** A failed tool's input: the file it named, else the input itself. */
function toolInputText(input: Record<string, unknown>, raw: unknown): string {
  for (const key of ['file_path', 'path']) {
    if (typeof input[key] === 'string') {
      return input[key] as string;
    }
  }
  return typeof raw === 'string' ? raw : (JSON.stringify(raw) ?? '');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** JSON with object keys sorted, so equal inputs give equal text. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * A tool result's text. Providers carry it as a string, an array of text
 * blocks, or an object. A Mastra tool's result is the tool's own JSON output as
 * text (`{"output":"…"}`), which `unwrapJson` reads back into its field.
 */
export function resultText(value: unknown, unwrapJson = false, depth = 0): string {
  if (depth > 4 || value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (unwrapJson && trimmed.startsWith('{')) {
      try {
        return resultText(JSON.parse(trimmed), false, depth + 1);
      } catch {
        // plain text that happens to start with a brace
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((v) => resultText(v, unwrapJson, depth + 1))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['output', 'result', 'text', 'content', 'error', 'listing']) {
      if (obj[key] !== undefined) {
        return resultText(obj[key], unwrapJson, depth + 1);
      }
    }
    return JSON.stringify(value) ?? '';
  }
  return String(value);
}

// ── Bounds ──────────────────────────────────────────────────────────────────

/**
 * Drop identical entries (the latest copy stays), keep the latest
 * {@link DIGEST_ENTRIES_KEPT} of each kind, and fit everything into
 * {@link DIGEST_TEXT_LIMIT}: the kinds that have entries share it equally, the
 * entries of a kind share its part equally, and an entry's fields share its
 * part in proportion to their length. Pure.
 */
export function bounded(extracted: Extracted): Extracted {
  const failedTools = latest(extracted.failedTools);
  const failedCommands = latest(extracted.failedCommands);
  const churnFiles = latest(extracted.churnFiles);
  const finalNotes = latest(extracted.finalNotes);
  const kinds = [failedTools, failedCommands, churnFiles, finalNotes].filter((k) => k.length);
  const kindShare = Math.floor(DIGEST_TEXT_LIMIT / Math.max(1, kinds.length));
  const share = (n: number) => Math.floor(kindShare / Math.max(1, n));
  const tools = share(failedTools.length);
  const commands = share(failedCommands.length);
  const files = share(churnFiles.length);
  const notes = share(finalNotes.length);
  return {
    churnFiles: churnFiles.map((f) => ({
      path: fit([[f.path, head]], files)[0] ?? '',
      writes: f.writes,
    })),
    failedCommands: failedCommands.map((c) => {
      const [command = '', output = ''] = fit(
        [
          [c.command, head],
          [c.output, tail],
        ],
        commands
      );
      return { command, output };
    }),
    failedTools: failedTools.map((t) => {
      const [tool = '', input = '', error = ''] = fit(
        [
          [t.tool, head],
          [t.input, head],
          [t.error, head],
        ],
        tools
      );
      return { error, input, tool };
    }),
    finalNotes: finalNotes.map((n) => fit([[n, head]], notes)[0] ?? ''),
  };
}

function latest<T>(entries: readonly T[]): T[] {
  const keys = entries.map((e) => JSON.stringify(e));
  return entries
    .filter((_, i) => keys.lastIndexOf(keys[i] as string) === i)
    .slice(-DIGEST_ENTRIES_KEPT);
}

type Cut = (text: string, limit: number) => string;

/** Cut the fields so their lengths add up to at most `limit`, each in proportion to its length. */
function fit(fields: [string, Cut][], limit: number): string[] {
  const total = fields.reduce((sum, [text]) => sum + text.length, 0);
  if (total <= limit) {
    return fields.map(([text]) => text);
  }
  return fields.map(([text, cut]) => cut(text, Math.floor((limit * text.length) / total)));
}

/** At most `limit` characters, the marker included. */
function head(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return limit <= 0 ? '' : `${text.slice(0, limit - 1)}…`;
}

function tail(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return limit <= 0 ? '' : `…${text.slice(text.length - limit + 1)}`;
}

// ── Safety ──────────────────────────────────────────────────────────────────

/**
 * Drop every entry whose text matches an INJECTION pattern — the memory gate's
 * own scan — and record the drop as a memory security event naming the
 * patterns, never the text. A scan that cannot complete makes the whole digest
 * unavailable: nothing can say the rest is clean.
 */
async function scanDigest(
  digest: Extracted & { transcriptIds: string[] },
  tracer: AgentTracer,
  cancel: Cancel
): Promise<TranscriptDigest> {
  const patterns = new Set<string>();
  let dropped = 0;
  const keep = async <T>(entries: T[], texts: (e: T) => string[]): Promise<T[]> => {
    const kept: T[] = [];
    for (const entry of entries) {
      checkCancelled(cancel);
      let scan: Awaited<ReturnType<typeof memoryInjectionMatches>>;
      try {
        scan = await memoryInjectionMatches(texts(entry));
      } catch {
        throw new DigestUnavailable('scan_unavailable');
      }
      if (scan.loadFailed || scan.incomplete) {
        throw new DigestUnavailable('scan_unavailable');
      }
      if (scan.matches.length === 0) {
        kept.push(entry);
      } else {
        dropped += 1;
        for (const p of scan.matches) {
          patterns.add(p);
        }
      }
    }
    return kept;
  };
  const failedTools = await keep(digest.failedTools, (t) => [t.tool, t.input, t.error]);
  const failedCommands = await keep(digest.failedCommands, (c) => [c.command, c.output]);
  const churnFiles = await keep(digest.churnFiles, (f) => [f.path]);
  const finalNotes = await keep(digest.finalNotes, (n) => [n]);
  checkCancelled(cancel);
  if (dropped > 0) {
    tracer.addActivityEvent({
      name: MEMORY_SECURITY_EVENTS.TRANSCRIPT_DIGEST_DROPPED,
      outputJson: { count: dropped, patterns: [...patterns], transcriptIds: digest.transcriptIds },
    });
  }
  return {
    churnFiles,
    dropped,
    failedCommands,
    failedTools,
    finalNotes,
    transcriptIds: digest.transcriptIds,
  };
}
