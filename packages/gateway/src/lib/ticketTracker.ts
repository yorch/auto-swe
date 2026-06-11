import type { ResolvedTrackerConfig } from '@auto-swe/shared/lib/systemConfig';

/**
 * Read-only issue-tracker connectors (EVOL-5). `fetchTicket` resolves an
 * external ticket ID against the configured tracker (Jira / Linear / GitHub
 * Issues) and returns a normalized summary plus the raw provider payload —
 * used at work-request submit time to seed `ContextSnapshot.rawTicketData`.
 *
 * Failure policy: this module NEVER throws. Any failure (no provider, bad
 * config, network error, timeout, 404, unparsable body) logs a warning and
 * returns null — ticket enrichment is strictly best-effort and must never
 * block a submission.
 *
 * Ticket ID formats:
 *   - jira:   the issue key, e.g. `PROJ-123`
 *   - linear: the issue identifier, e.g. `ENG-123` (Linear's GraphQL
 *             `issue(id:)` accepts identifiers as well as UUIDs)
 *   - github: `owner/repo#123`, or a bare issue number (`123` / `#123`)
 *             which resolves against `opts.defaultRepo` — the repository the
 *             work request targets. Anything else is rejected (null).
 *
 * SSRF: requests only ever go to the admin-configured `baseUrl` (Jira /
 * GitHub) or the fixed Linear endpoint.
 */

const FETCH_TIMEOUT_MS = 5_000;
const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

export interface FetchedTicket {
  title: string;
  description: string;
  status: string;
  labels: string[];
  url: string;
  /// Raw provider payload (Jira issue JSON / Linear issue node / GitHub issue).
  raw: unknown;
}

export interface FetchTicketOptions {
  /// Repository the work request targets — used to resolve bare-number
  /// GitHub ticket IDs (`123` / `#123`) to `owner/repo#123`.
  defaultRepo?: { owner: string; repo: string };
  log?: { warn: (obj: unknown, msg?: string) => void };
}

function warn(opts: FetchTicketOptions | undefined, obj: unknown, msg: string): void {
  opts?.log?.warn(obj, msg);
}

async function fetchJson(
  url: string,
  init: RequestInit
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const body = await res.json().catch(() => null);
  return { body, ok: res.ok, status: res.status };
}

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

// ─── Jira ─────────────────────────────────────────────────────────────────────

/// Atlassian Document Format → plain text. Walks the node tree collecting
/// `text` leaves; paragraphs/blocks become newlines. Best-effort.
export function adfToPlainText(node: unknown): string {
  if (typeof node === 'string') {
    return node;
  }
  if (!node || typeof node !== 'object') {
    return '';
  }
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (typeof n.text === 'string') {
    return n.text;
  }
  const children = Array.isArray(n.content) ? n.content.map(adfToPlainText) : [];
  const blockTypes = new Set([
    'paragraph',
    'heading',
    'blockquote',
    'codeBlock',
    'listItem',
    'bulletList',
    'orderedList',
    'rule',
  ]);
  const joined = children.join('');
  return n.type && blockTypes.has(n.type) ? `${joined}\n` : joined;
}

async function fetchJiraTicket(
  config: ResolvedTrackerConfig,
  ticketId: string,
  opts?: FetchTicketOptions
): Promise<FetchedTicket | null> {
  if (!config.baseUrl || !config.apiToken || !config.email) {
    warn(opts, { provider: 'jira' }, 'Tracker fetch skipped: Jira needs baseUrl, email and token');
    return null;
  }
  const base = stripTrailingSlash(config.baseUrl);
  const url = `${base}/rest/api/3/issue/${encodeURIComponent(ticketId)}`;
  const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
  const { ok, status, body } = await fetchJson(url, {
    headers: { Accept: 'application/json', Authorization: `Basic ${auth}` },
  });
  if (!ok) {
    warn(opts, { provider: 'jira', status, ticketId }, 'Tracker fetch failed');
    return null;
  }
  const issue = body as {
    key?: string;
    fields?: {
      summary?: string;
      description?: unknown;
      status?: { name?: string };
      labels?: string[];
    };
  };
  return {
    description: adfToPlainText(issue.fields?.description).trim(),
    labels: issue.fields?.labels ?? [],
    raw: body,
    status: issue.fields?.status?.name ?? 'unknown',
    title: issue.fields?.summary ?? ticketId,
    url: `${base}/browse/${encodeURIComponent(issue.key ?? ticketId)}`,
  };
}

// ─── Linear ───────────────────────────────────────────────────────────────────

const LINEAR_ISSUE_QUERY = `query Issue($id: String!) {
  issue(id: $id) {
    identifier
    title
    description
    url
    state { name }
    labels { nodes { name } }
  }
}`;

async function fetchLinearTicket(
  config: ResolvedTrackerConfig,
  ticketId: string,
  opts?: FetchTicketOptions
): Promise<FetchedTicket | null> {
  if (!config.apiToken) {
    warn(opts, { provider: 'linear' }, 'Tracker fetch skipped: Linear needs an API token');
    return null;
  }
  const { ok, status, body } = await fetchJson(LINEAR_GRAPHQL_URL, {
    body: JSON.stringify({ query: LINEAR_ISSUE_QUERY, variables: { id: ticketId } }),
    headers: {
      Authorization: config.apiToken,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  const data = (body as { data?: { issue?: unknown } } | null)?.data;
  const issue = data?.issue as
    | {
        identifier?: string;
        title?: string;
        description?: string | null;
        url?: string;
        state?: { name?: string };
        labels?: { nodes?: { name: string }[] };
      }
    | null
    | undefined;
  if (!ok || !issue) {
    warn(opts, { provider: 'linear', status, ticketId }, 'Tracker fetch failed');
    return null;
  }
  return {
    description: issue.description ?? '',
    labels: (issue.labels?.nodes ?? []).map((l) => l.name),
    raw: issue,
    status: issue.state?.name ?? 'unknown',
    title: issue.title ?? ticketId,
    url: issue.url ?? '',
  };
}

// ─── GitHub Issues ────────────────────────────────────────────────────────────

/// Parses `owner/repo#123`, `123`, or `#123` (the latter two resolved against
/// `defaultRepo`). Returns null when the ID doesn't look like a GitHub issue.
export function parseGitHubTicketId(
  ticketId: string,
  defaultRepo?: { owner: string; repo: string }
): { owner: string; repo: string; number: number } | null {
  const qualified = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(ticketId);
  if (qualified?.[1] && qualified[2] && qualified[3]) {
    return { number: Number(qualified[3]), owner: qualified[1], repo: qualified[2] };
  }
  const bare = /^#?(\d+)$/.exec(ticketId);
  if (bare?.[1] && defaultRepo) {
    return { number: Number(bare[1]), owner: defaultRepo.owner, repo: defaultRepo.repo };
  }
  return null;
}

async function fetchGitHubTicket(
  config: ResolvedTrackerConfig,
  ticketId: string,
  opts?: FetchTicketOptions
): Promise<FetchedTicket | null> {
  const parsed = parseGitHubTicketId(ticketId, opts?.defaultRepo);
  if (!parsed) {
    warn(
      opts,
      { provider: 'github', ticketId },
      'Tracker fetch skipped: GitHub ticket ID must be owner/repo#123 or a bare issue number'
    );
    return null;
  }
  const base = stripTrailingSlash(config.baseUrl ?? 'https://api.github.com');
  const url = `${base}/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'auto-swe/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (config.apiToken) {
    headers.Authorization = `Bearer ${config.apiToken}`;
  }
  const { ok, status, body } = await fetchJson(url, { headers });
  if (!ok) {
    warn(opts, { provider: 'github', status, ticketId }, 'Tracker fetch failed');
    return null;
  }
  const issue = body as {
    title?: string;
    body?: string | null;
    state?: string;
    labels?: ({ name?: string } | string)[];
    html_url?: string;
  };
  return {
    description: issue.body ?? '',
    labels: (issue.labels ?? [])
      .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
      .filter(Boolean),
    raw: body,
    status: issue.state ?? 'unknown',
    title: issue.title ?? ticketId,
    url: issue.html_url ?? '',
  };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function fetchTicket(
  config: ResolvedTrackerConfig,
  externalTicketId: string,
  opts?: FetchTicketOptions
): Promise<FetchedTicket | null> {
  try {
    switch (config.provider) {
      case 'jira':
        return await fetchJiraTicket(config, externalTicketId, opts);
      case 'linear':
        return await fetchLinearTicket(config, externalTicketId, opts);
      case 'github':
        return await fetchGitHubTicket(config, externalTicketId, opts);
      default:
        return null;
    }
  } catch (err) {
    warn(
      opts,
      { err, provider: config.provider, ticketId: externalTicketId },
      'Tracker fetch failed'
    );
    return null;
  }
}
