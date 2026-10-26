/**
 * The one worker-side client for Qodo's review of a pull request. Features that read what Qodo
 * said about a PR depend on {@link QodoFindingsClient}, never on the MCP plumbing.
 *
 * The client calls a single read tool, `get-pr-review-findings`, through the team's Qodo `mcp`
 * Connection and the shared MCP loader, so the connection's tool allowlist and result screening
 * apply. It never throws: every failure is an `unavailable` state carrying a fixed reason string,
 * so no error text, URL, header or response body can leak through it.
 */
import { resolveSetting } from '@auto-swe/shared/config';
import { z } from 'zod';
import { MCP_LEAF_WITHHELD } from '../../agents/mcpScreen.js';
import {
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_LIST_TIMEOUT_MS,
  loadMcpTools,
  type McpTracer,
  sanitizeToolName,
} from '../../agents/mcpTools.js';
import { resolveQodoConnection } from './connection.js';

export const QODO_FINDINGS_TOOL = 'get-pr-review-findings';

export const MAX_FINDINGS = 50;
export const MAX_TITLE_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 2000;
/** Headroom over the loader's own list + call timeouts, so the loader reports its own failure. */
export const QODO_READ_SLACK_MS = 5_000;
/** The longest one read may take however long the connection's own timeouts are set. */
export const MAX_QODO_READ_MS = 120_000;

/**
 * Overall budget for one read: the loader's list timeout plus its call timeout plus slack, so the
 * budget is only reached when the loader's own timeouts did not fire, and never above
 * {@link MAX_QODO_READ_MS}. A connection that sets larger timeouts is cut off at the maximum.
 */
export function qodoReadBudgetMs(target: {
  listTimeoutMs?: number;
  callTimeoutMs?: number;
}): number {
  const composite =
    (target.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS) +
    (target.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS) +
    QODO_READ_SLACK_MS;
  return Math.min(composite, MAX_QODO_READ_MS);
}

export type QodoSessionStatus = 'completed' | 'failed' | 'other';
export type QodoActionLevel =
  | 'action_required'
  | 'remediation_recommended'
  | 'informational'
  | 'unknown';
export type QodoAttributionStatus = 'pending' | 'implemented' | 'dismissed' | 'unknown';

export type QodoUnavailableReason =
  | 'disabled'
  | 'not_configured'
  | 'connection_refused'
  | 'tool_missing'
  | 'call_failed'
  | 'bad_response'
  | 'timeout';

export interface QodoFinding {
  id: string;
  title: string;
  description: string;
  category: string;
  actionLevel: QodoActionLevel;
  attributionStatus: QodoAttributionStatus;
  source: string;
}

export type QodoPrReviewState =
  | {
      kind: 'ok';
      session: { runId: number; status: QodoSessionStatus; commitSha: string; startedAt: string };
      findings: QodoFinding[];
      findingCount: number;
      truncated: boolean;
      /** Findings whose attribution status is not one this client knows; never counted as open. */
      unrecognisedStatuses: number;
      /**
       * Strings the result screen replaced with a placeholder. A finding whose title or
       * description was withheld is still a finding, listed and counted with the placeholder.
       */
      withheldFields: number;
    }
  | { kind: 'no_session' }
  | { kind: 'unavailable'; reason: QodoUnavailableReason };

export interface QodoFindingsClient {
  getPrReviewState(prUrl: string): Promise<QodoPrReviewState>;
}

// ── Contract: the observed default output of `get-pr-review-findings` ───────────────────────────
// Unknown extra fields are ignored. Enumerated vocabularies are read as strings and normalised
// below, so a value Qodo adds later degrades to 'other' / 'unknown' instead of failing the parse.

const SessionSchema = z.object({
  commit_sha: z.string(),
  run_id: z.number(),
  started_at: z.string(),
  status: z.string(),
});

const FindingSchema = z.object({
  action_level: z.string().nullish(),
  attribution_status: z.string().nullish(),
  category: z.string().nullish(),
  description: z.string().nullish(),
  finding_source: z.string().nullish(),
  id: z.string(),
  title: z.string().nullish(),
});

export const QodoFindingsResponseSchema = z.object({
  finding_count: z.number().int().nonnegative().nullish(),
  findings: z.array(FindingSchema).nullish(),
  review_session: SessionSchema.nullish(),
});

function sessionStatus(raw: string): QodoSessionStatus {
  return raw === 'completed' || raw === 'failed' ? raw : 'other';
}

function actionLevel(raw: string | null | undefined): QodoActionLevel {
  return raw === 'action_required' || raw === 'remediation_recommended' || raw === 'informational'
    ? raw
    : 'unknown';
}

function attributionStatus(raw: string | null | undefined): QodoAttributionStatus {
  return raw === 'pending' || raw === 'implemented' || raw === 'dismissed' ? raw : 'unknown';
}

/** Drops control characters; tabs and newlines survive only when `keepWhitespace` is set. */
function stripControl(text: string, keepWhitespace: boolean): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      if (code === 9 || code === 10 || code === 13) {
        out += keepWhitespace ? ch : ' ';
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function bounded(
  text: string | null | undefined,
  max: number,
  keepWhitespace: boolean
): { cut: boolean; text: string } {
  const clean = stripControl(text ?? '', keepWhitespace);
  return clean.length > max
    ? { cut: true, text: clean.slice(0, max) }
    : { cut: false, text: clean };
}

type ParsedResponse = z.infer<typeof QodoFindingsResponseSchema>;

/** Strings in a value that are exactly the screen's placeholder. */
function countWithheld(value: unknown): number {
  if (typeof value === 'string') {
    return value === MCP_LEAF_WITHHELD ? 1 : 0;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((n, item) => n + countWithheld(item), 0);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).reduce<number>((n, item) => n + countWithheld(item), 0);
  }
  return 0;
}

/** Maps a parsed response onto the exported state, bounding every text field. */
export function toQodoPrReviewState(parsed: ParsedResponse): QodoPrReviewState {
  const session = parsed.review_session;
  if (!session) {
    return { kind: 'no_session' };
  }
  const all = parsed.findings ?? [];
  let truncated = all.length > MAX_FINDINGS;
  let unrecognisedStatuses = 0;
  const findings = all.slice(0, MAX_FINDINGS).map((f): QodoFinding => {
    const title = bounded(f.title, MAX_TITLE_CHARS, false);
    const description = bounded(f.description, MAX_DESCRIPTION_CHARS, true);
    truncated ||= title.cut || description.cut;
    const status = attributionStatus(f.attribution_status);
    if (status === 'unknown') {
      unrecognisedStatuses += 1;
    }
    return {
      actionLevel: actionLevel(f.action_level),
      attributionStatus: status,
      category: bounded(f.category, MAX_TITLE_CHARS, false).text,
      description: description.text,
      id: bounded(f.id, MAX_TITLE_CHARS, false).text,
      source: bounded(f.finding_source, MAX_TITLE_CHARS, false).text,
      title: title.text,
    };
  });
  return {
    findingCount: parsed.finding_count ?? all.length,
    findings,
    kind: 'ok',
    session: {
      commitSha: session.commit_sha,
      runId: session.run_id,
      startedAt: session.started_at,
      status: sessionStatus(session.status),
    },
    truncated,
    unrecognisedStatuses,
    withheldFields: countWithheld(parsed),
  };
}

/** A finding still awaiting a decision. An unrecognised status is NOT open. */
export function isOpenFinding(finding: QodoFinding): boolean {
  return finding.attributionStatus === 'pending';
}

/** Whether the result screen replaced this finding's title or description with its placeholder. */
export function isFindingTextWithheld(finding: QodoFinding): boolean {
  return finding.title === MCP_LEAF_WITHHELD || finding.description === MCP_LEAF_WITHHELD;
}

const ACTION_RANK: Record<QodoActionLevel, number> = {
  action_required: 3,
  informational: 1,
  remediation_recommended: 2,
  unknown: 0,
};

/** Whether the finding's action level is at least `min` (informational < recommended < required). */
export function actionLevelAtLeast(
  finding: QodoFinding,
  min: Exclude<QodoActionLevel, 'unknown'>
): boolean {
  return ACTION_RANK[finding.actionLevel] >= ACTION_RANK[min];
}

/** An https URL whose path contains `/pull/<number>`. */
export function isValidPrUrl(prUrl: string): boolean {
  try {
    const url = new URL(prUrl);
    return url.protocol === 'https:' && /\/pull\/\d+(\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

// ── Reading the tool result ─────────────────────────────────────────────────────────────────────

const FENCE_BEGIN = /^BEGIN UNTRUSTED MCP OUTPUT[^\n]*\n/;
const FENCE_END = /\nEND UNTRUSTED MCP OUTPUT\s*$/;

function unfence(text: string): string {
  return text.trim().replace(FENCE_BEGIN, '').replace(FENCE_END, '');
}

/** Unfences every string in a parsed value: the result screen fences each string on its own. */
function unfenceLeaves(value: unknown): unknown {
  if (typeof value === 'string') {
    return unfence(value);
  }
  if (Array.isArray(value)) {
    return value.map(unfenceLeaves);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unfenceLeaves(v)]));
  }
  return value;
}

/**
 * The JSON the tool returned, whether bare, MCP content blocks, or fenced by the result screen.
 * Fencing is per block and per string, so each is unfenced on its own before blocks are joined.
 */
function payloadOf(result: unknown): unknown {
  if (typeof result === 'string') {
    return unfenceLeaves(JSON.parse(unfence(result)));
  }
  if (typeof result === 'object' && result !== null) {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((c) =>
          typeof c === 'object' && c !== null && typeof (c as { text?: unknown }).text === 'string'
            ? unfence((c as { text: string }).text)
            : ''
        )
        .join('');
      return unfenceLeaves(JSON.parse(text));
    }
    return unfenceLeaves(result);
  }
  throw new Error('unreadable');
}

export function parseQodoFindingsResult(result: unknown): QodoPrReviewState {
  try {
    const parsed = QodoFindingsResponseSchema.safeParse(payloadOf(result));
    return parsed.success
      ? toQodoPrReviewState(parsed.data)
      : { kind: 'unavailable', reason: 'bad_response' };
  } catch {
    return { kind: 'unavailable', reason: 'bad_response' };
  }
}

export interface QodoFindingsClientDeps {
  /** The run's repository team: the only authority for which Qodo connection is used. */
  teamId: string;
  orgId?: string;
  /** The caller's tracer. It records the MCP loader's events; the caller persists it. */
  tracer: McpTracer;
  /** Overall budget for one read. Default: {@link qodoReadBudgetMs} of the connection. */
  timeoutMs?: number;
}

class QodoTimeout extends Error {}

function unavailable(reason: QodoUnavailableReason): QodoPrReviewState {
  return { kind: 'unavailable', reason };
}

export function createQodoFindingsClient(deps: QodoFindingsClientDeps): QodoFindingsClient {
  async function read(prUrl: string): Promise<QodoPrReviewState> {
    const enabled = await resolveSetting('qodo.enabled', {
      orgId: deps.orgId,
      teamId: deps.teamId,
    });
    if (!enabled) {
      return unavailable('disabled');
    }
    const connection = await resolveQodoConnection({ teamId: deps.teamId });
    if (!connection) {
      return unavailable('not_configured');
    }
    const readTool = async (): Promise<QodoPrReviewState> => {
      const loaded = await loadMcpTools(connection.target, deps.tracer);
      try {
        if (Object.keys(loaded.tools).length === 0) {
          return unavailable('connection_refused');
        }
        const tool = loaded.tools[`mcp_${sanitizeToolName(QODO_FINDINGS_TOOL)}`];
        if (!tool?.execute) {
          return unavailable('tool_missing');
        }
        const execute = tool.execute as (input: Record<string, unknown>) => Promise<unknown>;
        let result: unknown;
        try {
          result = await execute({ pr_url: prUrl });
        } catch {
          return unavailable('call_failed');
        }
        return parseQodoFindingsResult(result);
      } finally {
        await loaded.close();
      }
    };
    // The budget starts when the MCP client does, and defaults to more than the loader's own
    // list + call timeouts, so a slow server is reported by the loader and its client is closed
    // by `readTool`'s own `finally` rather than left open behind a lost race.
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        readTool(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new QodoTimeout()),
            deps.timeoutMs ?? qodoReadBudgetMs(connection.target)
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getPrReviewState(prUrl) {
      if (!isValidPrUrl(prUrl)) {
        return unavailable('bad_response');
      }
      try {
        return await read(prUrl);
      } catch (err) {
        return unavailable(err instanceof QodoTimeout ? 'timeout' : 'call_failed');
      }
    },
  };
}

// ── Test double ─────────────────────────────────────────────────────────────────────────────────

/**
 * A scripted client for sibling features' tests. Each call returns the next scripted state and
 * repeats the last one when the script runs out; `calls` records the PR URLs asked about.
 */
export function createFakeQodoFindingsClient(
  script: readonly QodoPrReviewState[]
): QodoFindingsClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getPrReviewState(prUrl) {
      calls.push(prUrl);
      const index = Math.min(calls.length - 1, script.length - 1);
      return script[index] ?? unavailable('not_configured');
    },
  };
}
