import {
  CHILD_RESULT_MAX_CHARS,
  type ChildResult,
  ChildResultSchema,
  fenceChildResult,
} from '@auto-swe/shared/lib/orchestration';
import { memoryInjectionMatches } from './memoryGuard.js';
import type { OrchestrationEvent } from './orchestrationTypes.js';

/**
 * Assembles what the orchestrator reads each turn, in fixed code: the transcript, a state block
 * listing the children and the repository state, the new events as quoted data, and each finished
 * child's result — and a child's words reach the model ONLY through `fenceChildResult`, screened
 * with the memory guard's INJECTION patterns first (spec §4.2). The orchestrator never sees a
 * child's tool calls, retries or reasoning.
 */

/** What screening did to one child's text. */
export interface ScreenedText {
  text: string;
  /** Lines removed for matching an injection pattern. */
  droppedLines: number;
  /** The whole text was replaced: the scan could not complete or the match spans lines. */
  withheld: boolean;
}

const WITHHELD_TEXT = '[result withheld: it could not be screened for prompt injection]';
const LINE_NOTICE = '[a line was removed: it matched a prompt-injection pattern]';
/** More lines than this are not screened one by one; the text is withheld instead. */
const MAX_LINES = 1500;

/**
 * Screen `text` line by line. Fails closed: a scan that cannot finish withholds the text, and a
 * match that no single line reproduces (it spans lines) withholds the whole of it.
 */
export async function screenChildText(text: string): Promise<ScreenedText> {
  const whole = await memoryInjectionMatches([text]).catch(() => null);
  if (whole === null || whole.loadFailed) {
    return { droppedLines: 0, text: WITHHELD_TEXT, withheld: true };
  }
  if (whole.matches.length === 0 && !whole.incomplete) {
    return { droppedLines: 0, text, withheld: false };
  }
  const lines = text.split('\n');
  if (lines.length > MAX_LINES) {
    return { droppedLines: 0, text: WITHHELD_TEXT, withheld: true };
  }
  let dropped = 0;
  const kept: string[] = [];
  for (const line of lines) {
    const scan = await memoryInjectionMatches([line]).catch(() => null);
    if (scan === null || scan.loadFailed || scan.incomplete || scan.matches.length > 0) {
      dropped += 1;
      kept.push(LINE_NOTICE);
    } else {
      kept.push(line);
    }
  }
  if (dropped === 0) {
    // The whole text matched but no line did: the pattern spans lines.
    return { droppedLines: 0, text: WITHHELD_TEXT, withheld: true };
  }
  return { droppedLines: dropped, text: kept.join('\n'), withheld: false };
}

const MAX_FILES_LISTED = 30;

/** The structured result as the plain text that is fenced. Paths are agent-controlled. */
export function childResultText(result: ChildResult): string {
  const lines = [result.summary || '(no summary)'];
  if (result.branch) {
    lines.push(`Branch: ${result.branch}`);
  }
  if (result.prUrl) {
    lines.push(`Pull request: ${result.prUrl}`);
  }
  if (result.filesChanged.length > 0) {
    lines.push(`Files changed (${result.filesChanged.length}):`);
    for (const f of result.filesChanged.slice(0, MAX_FILES_LISTED)) {
      lines.push(`- ${f.path} (+${f.added}/-${f.removed})`);
    }
  }
  if (result.gate) {
    lines.push(`Gate: ${result.gate}`);
  }
  if (result.stoppedReason) {
    lines.push(`Stopped: ${result.stoppedReason}`);
  }
  lines.push(`Cost: $${result.costUsd.toFixed(4)}`);
  return lines.join('\n').slice(0, CHILD_RESULT_MAX_CHARS);
}

export interface FencedChild {
  block: string;
  droppedLines: number;
  withheld: boolean;
}

/** One finished child as the fenced block the orchestrator reads, or null if it has no result. */
export async function fenceFinishedChild(child: {
  id: string;
  agentKey: string;
  status: string;
  resultJson: unknown;
}): Promise<FencedChild | null> {
  const parsed = ChildResultSchema.safeParse(child.resultJson);
  if (!parsed.success) {
    return null;
  }
  const screened = await screenChildText(childResultText(parsed.data));
  return {
    block: fenceChildResult({
      agent: child.agentKey,
      childId: child.id,
      status: parsed.data.status,
      text: screened.text,
    }),
    droppedLines: screened.droppedLines,
    withheld: screened.withheld,
  };
}

export interface StateChild {
  id: string;
  agentKey: string;
  role: 'READER' | 'WRITER';
  status: string;
  label: string;
  pathScopes: string[];
}

const RUNNING_CHILD_STATUSES = new Set(['STARTING', 'RUNNING']);

/** Labels are model-written; keep them to one short line. */
function oneLine(value: string, max = 80): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

export interface RepoState {
  state: 'none' | 'requested' | 'attached';
  name?: string;
}

/**
 * The state block. Only STARTING and RUNNING writers hold path scopes, so a finished writer's
 * scopes are not listed: they are free to be given to a new writer.
 */
export function renderStateBlock(input: {
  allowlist: readonly string[];
  children: readonly StateChild[];
  repo: RepoState;
  title: string;
}): string {
  const lines = [
    '## Orchestration state',
    `Title: ${oneLine(input.title, 120)}`,
    `Spawnable agents (allowlist): ${input.allowlist.join(', ') || '(none)'}`,
    input.repo.state === 'attached'
      ? `Repository: attached (${input.repo.name ?? 'unnamed'}). Writers and delivery are available.`
      : input.repo.state === 'requested'
        ? 'Repository: requested, waiting for the person to confirm. Do not ask again.'
        : 'Repository: none attached. Writers are not available.',
    `Children started: ${input.children.length}`,
  ];
  if (input.children.length === 0) {
    lines.push('(no children yet)');
  }
  for (const c of input.children) {
    const holdsScopes = c.role === 'WRITER' && RUNNING_CHILD_STATUSES.has(c.status);
    lines.push(
      `- id=${c.id} agent=${c.agentKey} role=${c.role.toLowerCase()} status=${c.status} label="${oneLine(c.label)}"${
        holdsScopes ? ` path-scopes-held=${c.pathScopes.join(',')}` : ''
      }`
    );
  }
  lines.push('Only STARTING and RUNNING writers hold path scopes; finished writers do not.');
  return lines.join('\n');
}

export interface TranscriptRow {
  role: 'USER' | 'ORCHESTRATOR' | 'SYSTEM';
  kind: string;
  body: string;
  payload?: unknown;
}

const MESSAGE_CHARS = 4000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function payloadCode(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const code = (payload as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code.slice(0, 60);
    }
  }
  return '';
}

/** The transcript, oldest first. A child's result is not repeated here: it was fenced once. */
export function renderTranscript(rows: readonly TranscriptRow[]): string {
  const lines = ['## Conversation so far'];
  for (const row of rows) {
    const body = clip(row.body, MESSAGE_CHARS);
    if (row.role === 'USER') {
      lines.push(`[person] ${body}`);
    } else if (row.role === 'ORCHESTRATOR') {
      lines.push(
        row.kind === 'ATTACH_REQUEST'
          ? `[you] (asked the person to attach a repository) ${body}`
          : `[you] ${body}`
      );
    } else if (row.kind === 'NOTICE') {
      const code = payloadCode(row.payload);
      lines.push(`[platform notice${code ? ` ${code}` : ''}] ${body}`);
    } else if (row.kind === 'APPROVAL_REQUEST') {
      lines.push(`[platform] ${body}`);
    } else {
      lines.push(`[platform] ${body}`);
    }
  }
  if (rows.length === 0) {
    lines.push('(empty)');
  }
  return lines.join('\n');
}

export interface EventRenderInput {
  events: readonly OrchestrationEvent[];
  /** Fenced blocks for the children that finished, by child id. */
  fencedByChild: ReadonlyMap<string, string>;
  /** `owner/name` of the repository once attached. */
  attachedRepoName?: string;
}

/** The new events as quoted data. Anything model- or child-authored is already fenced. */
export function renderEvents(input: EventRenderInput): string {
  const lines = ['## New since your last turn'];
  const seen = new Set<string>();
  for (const e of input.events) {
    switch (e.type) {
      case 'userMessage':
        if (!seen.has('user')) {
          lines.push('- The person sent a message (see the conversation above).');
          seen.add('user');
        }
        break;
      case 'childFinished': {
        const block = input.fencedByChild.get(e.childId);
        if (block) {
          lines.push('- A child finished. Its result, as quoted data:', block);
        } else {
          lines.push(
            `- A child (id=${e.childId.slice(0, 64)}) finished; its result was already reported or is unavailable.`
          );
        }
        break;
      }
      case 'attachResolved':
        lines.push(
          e.accepted
            ? `- The person attached a repository${input.attachedRepoName ? ` (${input.attachedRepoName})` : ''}. Writers are now possible.`
            : '- The person declined to attach a repository.'
        );
        break;
      case 'approvalResolved':
        lines.push(
          `- An MCP write approval (id=${e.approvalId.slice(0, 64)}) was ${e.status.toLowerCase()}.`
        );
        break;
      case 'notices':
        if (!seen.has('notices')) {
          lines.push('- The platform left notices in the conversation above; read them.');
          seen.add('notices');
        }
        break;
    }
  }
  if (lines.length === 1) {
    lines.push('(nothing new)');
  }
  return lines.join('\n');
}

export const TURN_INSTRUCTIONS =
  'Respond to the above. Use your tools only to record what you ask for; reply to the person in plain text. If nothing needs doing and nothing is outstanding, say so briefly.';
