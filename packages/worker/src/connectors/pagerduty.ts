import { ApplicationFailure } from '@temporalio/activity';
import { capturingFetch } from '../lib/httpCapture.js';

const PAGERDUTY_API = 'https://api.pagerduty.com';
const PAGERDUTY_TIMEOUT_MS = 30_000;
/** PagerDuty object ids are short uppercase alphanumerics (`PT4KHLK`, `Q2ZH7Y2SD3X0RE`). */
const PAGERDUTY_ID_RE = /^[A-Z0-9]{1,32}$/;
/** How many alerts and log entries a read returns: enough to triage on, bounded for the model. */
const CONTEXT_LIMIT = 25;
/** PagerDuty's note content limit. */
export const PAGERDUTY_NOTE_MAX_CHARS = 25_000;

export interface PagerDutyConnectionLike {
  apiToken: string;
  config: { fromEmail?: string | null };
}

export function assertPagerDutyId(value: string, what = 'incident id'): string {
  if (!PAGERDUTY_ID_RE.test(value)) {
    throw ApplicationFailure.nonRetryable(
      `PagerDuty ${what} must be 1-32 uppercase letters or digits`
    );
  }
  return value;
}

async function pagerdutyFetch<T>(
  connection: PagerDutyConnectionLike,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(PAGERDUTY_TIMEOUT_MS);
  const response = await capturingFetch(globalThis.fetch, 'connector')(`${PAGERDUTY_API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.pagerduty+json;version=2',
      Authorization: `Token token=${connection.apiToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    // Never follow a redirect off the PagerDuty host with the credential attached.
    redirect: 'error',
    signal: init.signal ? AbortSignal.any([timeoutSignal, init.signal]) : timeoutSignal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => 'unknown');
    const status = response.status;
    if (status === 401 || status === 403) {
      throw ApplicationFailure.nonRetryable(`PagerDuty API authentication failed (${status})`);
    }
    if (status === 404) {
      throw ApplicationFailure.nonRetryable(`PagerDuty incident not found (${status})`);
    }
    if (status >= 500 || status === 429) {
      throw ApplicationFailure.create({
        message: `PagerDuty API transient error (${status}): ${body}`,
        type: 'PagerDutyTransientError',
      });
    }
    throw ApplicationFailure.nonRetryable(`PagerDuty API error (${status}): ${body}`);
  }

  return response.json() as Promise<T>;
}

/** The incident fields a triage reads; PagerDuty returns more, which are dropped. */
export interface PagerDutyIncidentSummary {
  createdAt: string | null;
  description: string | null;
  htmlUrl: string | null;
  id: string;
  incidentKey: string | null;
  number: number | null;
  priority: string | null;
  service: { id: string | null; name: string | null };
  status: string | null;
  title: string | null;
  urgency: string | null;
}

export interface PagerDutyAlertSummary {
  body: unknown;
  createdAt: string | null;
  id: string | null;
  severity: string | null;
  summary: string | null;
}

export interface PagerDutyLogEntrySummary {
  createdAt: string | null;
  summary: string | null;
  type: string | null;
}

export interface PagerDutyIncidentNoteSummary {
  author: string | null;
  content: string | null;
  createdAt: string | null;
}

export interface PagerDutyIncidentContext {
  alerts: PagerDutyAlertSummary[];
  incident: PagerDutyIncidentSummary;
  logEntries: PagerDutyLogEntrySummary[];
  /** The incident's notes, oldest first: responders' and earlier runs' (a triage diagnosis). */
  notes: PagerDutyIncidentNoteSummary[];
}

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null ? (v as Json) : {});
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);

/** Longest alert body kept, serialised: a monitoring payload can be large. */
export const PAGERDUTY_ALERT_BODY_MAX_CHARS = 4000;

function boundedBody(details: unknown): unknown {
  if (details === undefined || details === null) {
    return null;
  }
  const text = typeof details === 'string' ? details : JSON.stringify(details);
  if (text.length <= PAGERDUTY_ALERT_BODY_MAX_CHARS) {
    return details;
  }
  return `${text.slice(0, PAGERDUTY_ALERT_BODY_MAX_CHARS)}… (truncated)`;
}

/** Longest note content kept: a note can hold 25,000 characters. */
export const PAGERDUTY_NOTE_CONTENT_MAX_CHARS = 4000;

function boundedText(v: unknown, max: number): string | null {
  const text = str(v);
  return text !== null && text.length > max ? `${text.slice(0, max)}… (truncated)` : text;
}

function summarizeIncident(raw: Json, id: string): PagerDutyIncidentSummary {
  const service = obj(raw.service);
  return {
    createdAt: str(raw.created_at),
    description: str(raw.description),
    htmlUrl: str(raw.html_url),
    id,
    incidentKey: str(raw.incident_key),
    number: typeof raw.number === 'number' ? raw.number : null,
    priority: str(obj(raw.priority).summary),
    service: { id: str(service.id), name: str(service.summary) },
    status: str(raw.status),
    title: str(raw.title),
    urgency: str(raw.urgency),
  };
}

/**
 * An incident with its most recent alerts, log entries and notes, reduced to the fields a triage
 * or a postmortem reads. The alert `body` is the monitoring tool's own payload and is returned as
 * PagerDuty holds it, bounded in length.
 */
export async function fetchPagerDutyIncident(
  connection: PagerDutyConnectionLike,
  incidentId: string
): Promise<PagerDutyIncidentContext> {
  const id = assertPagerDutyId(incidentId);
  const base = `/incidents/${id}`;
  const [incident, alerts, logEntries, notes] = await Promise.all([
    pagerdutyFetch<Json>(connection, base),
    pagerdutyFetch<Json>(connection, `${base}/alerts?limit=${CONTEXT_LIMIT}&include[]=body`),
    pagerdutyFetch<Json>(connection, `${base}/log_entries?limit=${CONTEXT_LIMIT}&is_overview=true`),
    pagerdutyFetch<Json>(connection, `${base}/notes`),
  ]);
  return {
    alerts: list(alerts.alerts).map((a) => ({
      body: boundedBody(obj(a.body).details),
      createdAt: str(a.created_at),
      id: str(a.id),
      severity: str(a.severity),
      summary: str(a.summary),
    })),
    incident: summarizeIncident(obj(incident.incident), id),
    logEntries: list(logEntries.log_entries).map((e) => ({
      createdAt: str(e.created_at),
      summary: str(e.summary),
      type: str(e.type),
    })),
    // The notes endpoint is not paginated: keep the most recent ones.
    notes: list(notes.notes)
      .slice(-CONTEXT_LIMIT)
      .map((n) => ({
        author: str(obj(n.user).summary),
        content: boundedText(n.content, PAGERDUTY_NOTE_CONTENT_MAX_CHARS),
        createdAt: str(n.created_at),
      })),
  };
}

export interface PagerDutyNoteResult {
  incidentId: string;
  noteId: string | null;
}

/**
 * Add a note to an incident. PagerDuty attributes the note to the user whose email is in `From`,
 * so the connection's `fromEmail` must name a user on the account.
 */
export async function postPagerDutyNote(
  connection: PagerDutyConnectionLike,
  incidentId: string,
  content: string
): Promise<PagerDutyNoteResult> {
  const id = assertPagerDutyId(incidentId);
  const from = connection.config.fromEmail;
  if (!from) {
    throw ApplicationFailure.nonRetryable(
      'PagerDuty connection is missing fromEmail, which PagerDuty requires to write a note'
    );
  }
  const trimmed = content.trim();
  if (!trimmed) {
    throw ApplicationFailure.nonRetryable('PagerDuty note content is empty');
  }
  const result = await pagerdutyFetch<Json>(connection, `/incidents/${id}/notes`, {
    body: JSON.stringify({
      note: { content: trimmed.slice(0, PAGERDUTY_NOTE_MAX_CHARS) },
    }),
    headers: { From: from },
    method: 'POST',
  });
  return { incidentId: id, noteId: str(obj(result.note).id) };
}
