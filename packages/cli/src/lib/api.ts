import type { CliEnv } from './env.js';

interface GatewayErrorBody {
  error?: { code?: string; details?: unknown; message?: string };
}

export class GatewayError extends Error {
  readonly statusCode: number;
  readonly code: string;
  /** The gateway's `error.details`, when it sends some. Untrusted. */
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
    this.statusCode = statusCode;
  }
}

/**
 * Rewords the gateway's refusal of an unchanged request after a not-actionable stop for a
 * terminal: it names the CLI's flag, not the API's field. Any other error passes through.
 */
export function withAcknowledgeHint(err: unknown): unknown {
  if (!(err instanceof GatewayError) || err.code !== 'UNCHANGED_AFTER_NOT_ACTIONABLE') {
    return err;
  }
  const previous =
    typeof err.details === 'object' && err.details !== null && 'previousRunId' in err.details
      ? ` ${String(err.details.previousRunId)}`
      : '';
  return new GatewayError(
    err.statusCode,
    err.code,
    `This request stopped as not actionable (run${previous}) and has not changed. ` +
      'If you have fixed what stopped it (for example tracker access), pass --acknowledge-unchanged to launch it again; ' +
      'otherwise add the ticket text or acceptance criteria and run it again.',
    err.details
  );
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * The request never produced a response — DNS, refused connection, TLS. Node's
 * fetch reports all of these as a bare "fetch failed" and hides the reason in
 * `cause`, so this names the URL and unwraps the cause into the message.
 */
export class NetworkError extends Error {
  constructor(method: HttpMethod, url: string, err: unknown) {
    super(
      `${method} ${url} failed: ${describeCause(err)} — is the gateway running and AUTO_SWE_API_URL correct?`,
      { cause: err }
    );
    this.name = 'NetworkError';
  }
}

function describeCause(err: unknown): string {
  const cause = err instanceof Error && err.cause !== undefined ? err.cause : err;
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code && !cause.message.includes(code) ? `${code} ${cause.message}` : cause.message;
  }
  return String(cause);
}

/**
 * Shared fetch core: decorate with the bearer token, parse JSON, and turn a
 * non-2xx response into a typed `GatewayError`. Returns the FULL parsed envelope.
 */
async function requestEnvelope(
  env: CliEnv,
  method: HttpMethod,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<Record<string, unknown>> {
  const url = `${env.apiUrl}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${env.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(extraHeaders ?? {}),
      },
      method,
    });
  } catch (err) {
    throw new NetworkError(method, url, err);
  }
  const text = await res.text();
  const json = (text ? safeParseJson(text) : {}) as Record<string, unknown> & GatewayErrorBody;
  if (!res.ok) {
    throw new GatewayError(
      res.status,
      json.error?.code ?? 'HTTP_ERROR',
      json.error?.message ?? `HTTP ${res.status}`,
      json.error?.details
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
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<T> {
  const json = await requestEnvelope(env, method, path, body, extraHeaders);
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

/**
 * Returned from a dispatcher's `runWithExitCodes` body when no branch matched,
 * so the caller can fall through to its "Unknown subcommand" message. Negative
 * so it can never collide with a real exit code.
 */
export const UNKNOWN_SUBCOMMAND = -1;

/**
 * Run a subcommand and map its failure modes onto the documented exit codes:
 * a `GatewayError` (HTTP non-2xx) is 2, anything else is a user error, 1.
 * Every gateway-backed command funnels through here so the mapping is defined
 * exactly once.
 */
export async function runWithExitCodes(fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GatewayError) {
      process.stderr.write(`${err.code}: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
