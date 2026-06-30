import type { CliEnv } from './env.js';

interface GatewayErrorBody {
  error?: { code?: string; message?: string };
}

export class GatewayError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * Shared fetch core: decorate with the bearer token, parse JSON, and turn a
 * non-2xx response into a typed `GatewayError`. Returns the FULL parsed envelope.
 */
async function requestEnvelope(
  env: CliEnv,
  method: HttpMethod,
  path: string,
  body?: unknown
): Promise<Record<string, unknown>> {
  const res = await fetch(`${env.apiUrl}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${env.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    method,
  });
  const text = await res.text();
  const json = (text ? safeParseJson(text) : {}) as Record<string, unknown> & GatewayErrorBody;
  if (!res.ok) {
    throw new GatewayError(
      res.status,
      json.error?.code ?? 'HTTP_ERROR',
      json.error?.message ?? `HTTP ${res.status}`
    );
  }
  return json;
}

/**
 * Thin fetch wrapper that decorates every request with the bearer token, parses
 * JSON, and turns non-2xx responses into a typed `GatewayError`. Returns the
 * response's `data` field (or the whole body when there is no `data`).
 */
export async function apiRequest<T>(
  env: CliEnv,
  method: HttpMethod,
  path: string,
  body?: unknown
): Promise<T> {
  const json = await requestEnvelope(env, method, path, body);
  return (json.data ?? json) as T;
}

/**
 * Like {@link apiRequest} but returns the FULL response envelope rather than
 * just `.data`. Use when the endpoint returns sibling fields alongside `data`
 * (e.g. the workflow generator's `summary` / `warnings`).
 */
export async function apiRequestFull<T>(
  env: CliEnv,
  method: HttpMethod,
  path: string,
  body?: unknown
): Promise<T> {
  return (await requestEnvelope(env, method, path, body)) as T;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
