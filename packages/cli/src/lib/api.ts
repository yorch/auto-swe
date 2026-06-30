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

/**
 * Thin fetch wrapper that decorates every request with the bearer token, parses
 * JSON, and turns non-2xx responses into a typed `GatewayError` so callers can
 * format a useful CLI message without rolling their own status handling.
 */
export async function apiRequest<T>(
  env: CliEnv,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${env.apiUrl}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${env.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    method,
  });
  const text = await res.text();
  const json = text ? (safeParseJson(text) as { data?: T } & GatewayErrorBody) : {};
  if (!res.ok) {
    throw new GatewayError(
      res.status,
      json.error?.code ?? 'HTTP_ERROR',
      json.error?.message ?? `HTTP ${res.status}`
    );
  }
  return (json.data ?? (json as unknown as T)) as T;
}

/**
 * Like {@link apiRequest} but returns the FULL response envelope rather than
 * just `.data`. Use when the endpoint returns sibling fields alongside `data`
 * (e.g. the workflow generator's `summary` / `warnings`).
 */
export async function apiRequestFull<T>(
  env: CliEnv,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${env.apiUrl}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${env.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    method,
  });
  const text = await res.text();
  const json = text ? (safeParseJson(text) as T & GatewayErrorBody) : ({} as T & GatewayErrorBody);
  if (!res.ok) {
    throw new GatewayError(
      res.status,
      json.error?.code ?? 'HTTP_ERROR',
      json.error?.message ?? `HTTP ${res.status}`
    );
  }
  return json as T;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
