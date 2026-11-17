import { ApplicationFailure } from '@temporalio/activity';
import { notSent, notSentRetryable } from '../lib/externalWrite.js';
import { capturingFetch } from '../lib/httpCapture.js';
import {
  isDnsFailure,
  isUsableTokenValue,
  readCappedBody,
  sanitizedCause,
  statusFailure,
} from './httpApi.js';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const HUBSPOT_TIMEOUT_MS = 30_000;

/** Standard names (`contacts`, `deals`), custom `p_…` names, and `2-1234` type ids. */
const OBJECT_TYPE_RE = /^(?:[a-z][a-z0-9_]{0,63}|\d+-\d+)$/i;
const OBJECT_ID_RE = /^[0-9]{1,32}$/;
const PROPERTY_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_PROPERTIES = 200;
const MAX_FILTER_GROUPS = 5;
const MAX_FILTERS_PER_GROUP = 6;
const MAX_SEARCH_LIMIT = 100;
const FILTER_OPERATORS = new Set([
  'EQ',
  'NEQ',
  'LT',
  'LTE',
  'GT',
  'GTE',
  'BETWEEN',
  'IN',
  'NOT_IN',
  'HAS_PROPERTY',
  'NOT_HAS_PROPERTY',
  'CONTAINS_TOKEN',
  'NOT_CONTAINS_TOKEN',
]);

export interface HubSpotConnectionLike {
  apiToken: string | null;
}

export type HubSpotPropertyValue = string | number | boolean | null;

export interface HubSpotRecord {
  archived?: boolean;
  createdAt?: string;
  id: string;
  properties: Record<string, string | null>;
  updatedAt?: string;
}

export interface HubSpotSearchFilter {
  highValue?: string | number;
  operator: string;
  propertyName: string;
  value?: string | number | boolean;
  values?: Array<string | number>;
}

export interface HubSpotSearchResult {
  /** Cursor for the next page, when there is one. */
  nextAfter?: string;
  results: HubSpotRecord[];
  total: number;
}

function requireToken(conn: HubSpotConnectionLike): string {
  if (!conn.apiToken) {
    throw notSent('hubspot connection has no private-app token stored');
  }
  if (!isUsableTokenValue(conn.apiToken)) {
    // Never echoes the token: undici quotes a bad header value in its error.
    throw notSent('hubspot connection token is not a valid bearer credential');
  }
  return conn.apiToken;
}

/** Per-call options. `signal` is the activity's cancellation signal. */
export interface HubSpotCallOptions {
  signal?: AbortSignal;
}

function checkObjectType(objectType: unknown): string {
  if (typeof objectType !== 'string' || !OBJECT_TYPE_RE.test(objectType)) {
    throw notSent('hubspot objectType must be a name like "contacts" or a type id like "2-1234"');
  }
  return encodeURIComponent(objectType);
}

function checkObjectId(objectId: unknown): string {
  if (typeof objectId !== 'string' || !OBJECT_ID_RE.test(objectId)) {
    throw notSent('hubspot objectId must be a numeric string');
  }
  return objectId;
}

function checkPropertyNames(names: unknown, what: string): string[] {
  if (!Array.isArray(names) || names.length > MAX_PROPERTIES) {
    throw notSent(`hubspot ${what} must be a list of at most ${MAX_PROPERTIES} property names`);
  }
  for (const name of names) {
    if (typeof name !== 'string' || !PROPERTY_NAME_RE.test(name)) {
      throw notSent(`hubspot ${what} contains an invalid property name`);
    }
  }
  return names as string[];
}

function checkWriteProperties(properties: unknown): Record<string, string | number | boolean> {
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    throw notSent('hubspot properties must be an object');
  }
  const entries = Object.entries(properties);
  if (entries.length === 0 || entries.length > MAX_PROPERTIES) {
    throw notSent(`hubspot properties must hold between 1 and ${MAX_PROPERTIES} entries`);
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [name, value] of entries) {
    if (!PROPERTY_NAME_RE.test(name)) {
      throw notSent('hubspot properties contain an invalid property name');
    }
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      !(typeof value === 'number' && Number.isFinite(value))
    ) {
      throw notSent(`hubspot property ${name} must be a string, number, boolean or null`);
    }
    // HubSpot clears a property by setting it to the empty string.
    out[name] = value === null ? '' : value;
  }
  return out;
}

function checkFilterGroups(groups: unknown): Array<{ filters: HubSpotSearchFilter[] }> {
  if (!Array.isArray(groups) || groups.length > MAX_FILTER_GROUPS) {
    throw notSent(`hubspot filterGroups must hold at most ${MAX_FILTER_GROUPS} groups`);
  }
  return groups.map((group) => {
    const filters = (group as { filters?: unknown } | null)?.filters;
    if (!Array.isArray(filters) || filters.length === 0 || filters.length > MAX_FILTERS_PER_GROUP) {
      throw notSent(`hubspot filter groups must hold 1 to ${MAX_FILTERS_PER_GROUP} filters`);
    }
    return {
      filters: filters.map((raw) => {
        const f = raw as Partial<HubSpotSearchFilter> | null;
        if (
          !f ||
          typeof f.propertyName !== 'string' ||
          !PROPERTY_NAME_RE.test(f.propertyName) ||
          typeof f.operator !== 'string' ||
          !FILTER_OPERATORS.has(f.operator)
        ) {
          throw notSent('hubspot filter needs a valid propertyName and operator');
        }
        const out: HubSpotSearchFilter = { operator: f.operator, propertyName: f.propertyName };
        if (f.value !== undefined) {
          out.value = f.value;
        }
        if (f.values !== undefined) {
          out.values = f.values;
        }
        if (f.highValue !== undefined) {
          out.highValue = f.highValue;
        }
        return out;
      }),
    };
  });
}

async function hubspotFetch(
  conn: HubSpotConnectionLike,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body: unknown,
  opts: HubSpotCallOptions
): Promise<unknown> {
  const token = requireToken(conn);
  const timeoutSignal = AbortSignal.timeout(HUBSPOT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;
  let response: Response;
  try {
    // Fixed host, so no SSRF guard is needed; a redirect is an error so the token is never
    // followed off it.
    response = await capturingFetch(globalThis.fetch, 'connector')(`${HUBSPOT_API_BASE}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      method,
      redirect: 'error',
      signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) {
      throw err;
    }
    if (isDnsFailure(err)) {
      // The name never resolved, so no connection was made and nothing was sent.
      throw notSentRetryable(`HubSpot ${method} ${path} failed: the host could not be resolved`);
    }
    // The transport error's own message can quote a header value, so only its name and code stay.
    throw ApplicationFailure.create({
      cause: ApplicationFailure.create({
        message: JSON.stringify(sanitizedCause(err)),
        nonRetryable: false,
        type: 'TransportError',
      }),
      message: `HubSpot ${method} ${path} failed: the request did not complete`,
      type: 'HubSpotNetworkError',
    });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw statusFailure('HubSpot', method, path, response.status);
  }
  const { text, truncated } = await readCappedBody(response);
  if (truncated) {
    throw ApplicationFailure.nonRetryable(
      `HubSpot ${method} ${path} response exceeded the size limit`,
      'HubSpotResponseTooLarge'
    );
  }
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw ApplicationFailure.nonRetryable(
      `HubSpot ${method} ${path} returned a body that is not JSON`,
      'HubSpotBadResponse'
    );
  }
}

function toRecord(raw: unknown): HubSpotRecord {
  const r = (raw ?? {}) as Partial<HubSpotRecord> & { id?: unknown };
  if (r.id === undefined || r.id === null) {
    throw ApplicationFailure.nonRetryable('HubSpot returned a record without an id');
  }
  const record: HubSpotRecord = {
    id: String(r.id),
    properties: (r.properties as HubSpotRecord['properties'] | undefined) ?? {},
  };
  if (typeof r.createdAt === 'string') {
    record.createdAt = r.createdAt;
  }
  if (typeof r.updatedAt === 'string') {
    record.updatedAt = r.updatedAt;
  }
  if (typeof r.archived === 'boolean') {
    record.archived = r.archived;
  }
  return record;
}

/** GET /crm/v3/objects/{objectType}/{objectId} */
export async function fetchHubSpotRecord(
  conn: HubSpotConnectionLike,
  input: { objectId: string; objectType: string; properties?: string[] },
  opts: HubSpotCallOptions = {}
): Promise<HubSpotRecord> {
  const type = checkObjectType(input.objectType);
  const id = checkObjectId(input.objectId);
  const props = input.properties ? checkPropertyNames(input.properties, 'properties') : [];
  const query = props.length > 0 ? `?properties=${props.map(encodeURIComponent).join(',')}` : '';
  return toRecord(
    await hubspotFetch(conn, 'GET', `/crm/v3/objects/${type}/${id}${query}`, undefined, opts)
  );
}

/** POST /crm/v3/objects/{objectType} */
export async function createHubSpotRecord(
  conn: HubSpotConnectionLike,
  input: { objectType: string; properties: Record<string, HubSpotPropertyValue> },
  opts: HubSpotCallOptions = {}
): Promise<HubSpotRecord> {
  const type = checkObjectType(input.objectType);
  const properties = checkWriteProperties(input.properties);
  return toRecord(
    await hubspotFetch(conn, 'POST', `/crm/v3/objects/${type}`, { properties }, opts)
  );
}

/** PATCH /crm/v3/objects/{objectType}/{objectId} */
export async function updateHubSpotRecord(
  conn: HubSpotConnectionLike,
  input: {
    objectId: string;
    objectType: string;
    properties: Record<string, HubSpotPropertyValue>;
  },
  opts: HubSpotCallOptions = {}
): Promise<HubSpotRecord> {
  const type = checkObjectType(input.objectType);
  const id = checkObjectId(input.objectId);
  const properties = checkWriteProperties(input.properties);
  return toRecord(
    await hubspotFetch(conn, 'PATCH', `/crm/v3/objects/${type}/${id}`, { properties }, opts)
  );
}

/** POST /crm/v3/objects/{objectType}/search */
export async function searchHubSpotRecords(
  conn: HubSpotConnectionLike,
  input: {
    after?: string;
    filterGroups?: Array<{ filters: HubSpotSearchFilter[] }>;
    limit?: number;
    objectType: string;
    properties?: string[];
    query?: string;
  },
  opts: HubSpotCallOptions = {}
): Promise<HubSpotSearchResult> {
  const type = checkObjectType(input.objectType);
  const body: Record<string, unknown> = {};
  if (input.filterGroups !== undefined) {
    body.filterGroups = checkFilterGroups(input.filterGroups);
  }
  if (input.query !== undefined) {
    if (typeof input.query !== 'string' || input.query.length > 500) {
      throw notSent('hubspot query must be a string of at most 500 characters');
    }
    body.query = input.query;
  }
  if (input.properties !== undefined) {
    body.properties = checkPropertyNames(input.properties, 'properties');
  }
  const limit = input.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw notSent(`hubspot limit must be an integer from 1 to ${MAX_SEARCH_LIMIT}`);
  }
  body.limit = limit;
  if (input.after !== undefined) {
    if (typeof input.after !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.after)) {
      throw notSent('hubspot after must be a paging cursor from a previous search');
    }
    body.after = input.after;
  }
  const raw = (await hubspotFetch(conn, 'POST', `/crm/v3/objects/${type}/search`, body, opts)) as {
    paging?: { next?: { after?: string } };
    results?: unknown[];
    total?: number;
  } | null;
  const results = (raw?.results ?? []).map(toRecord);
  const out: HubSpotSearchResult = { results, total: raw?.total ?? results.length };
  const nextAfter = raw?.paging?.next?.after;
  if (typeof nextAfter === 'string') {
    out.nextAfter = nextAfter;
  }
  return out;
}
