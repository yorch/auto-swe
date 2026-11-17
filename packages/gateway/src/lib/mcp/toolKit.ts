import type { McpServer } from '@modelcontextprotocol/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MCP_SCOPE_ADMIN } from '../mcpOAuth.js';
import type { BridgeResponse, McpBridge, McpCaller } from './bridge.js';

/**
 * What every tool module shares: the result and failure shapes, and `readTool`, which chooses a
 * request, runs it through the bridge and reduces the response to an allowlisted shape. A domain
 * module (`domains/*.ts`) receives a {@link ToolKit} and registers its tools on it, so no module
 * has to know how a refusal is phrased or how an internal error is kept from the agent.
 */

export interface McpToolDeps {
  app: FastifyInstance;
  bridge: McpBridge;
  /** The dashboard's public origin, for the links tools return. */
  dashboardOrigin: string;
  /** The `host[:port]` of every GitHub this platform is configured for; a PR link must be on one. */
  getGitHubHosts: () => Promise<readonly string[]>;
  serverVersion: string;
}

export const pageInput = {
  limit: z.number().int().min(1).max(100).optional().describe('Page size, 1-100 (default 50)'),
  offset: z.number().int().min(0).optional().describe('How many results to skip (default 0)'),
};

export const READ_ONLY = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
} as const;

/** Annotations of a write tool: not read-only, never destructive, and it reaches beyond the platform. */
export const WRITE = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: false,
} as const;

/**
 * The longest a tool may wait, in seconds: 600 when the request asked for progress (a client that
 * sent a `progressToken` is watching and keeps its connection alive on each notification), 50
 * otherwise, which stays under the usual proxy idle timeout.
 */
export const maxWaitSeconds = (progressToken: unknown): number =>
  progressToken === undefined ? 50 : 600;

/** The signal that ends a wait: the MCP request's, joined with the HTTP request's when there is one. */
export function requestSignal(extra: {
  http?: { req?: { signal: AbortSignal } };
  mcpReq: { signal: AbortSignal };
}): AbortSignal {
  return extra.http?.req
    ? AbortSignal.any([extra.mcpReq.signal, extra.http.req.signal])
    : extra.mcpReq.signal;
}

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

export function ok(output: Record<string, unknown>): ToolResult {
  return { content: [{ text: JSON.stringify(output), type: 'text' }], structuredContent: output };
}

export function failure(text: string): ToolResult {
  return { content: [{ text, type: 'text' }], isError: true };
}

/**
 * A fixed message per status, never the route's own message: a REST error can echo input or name
 * what exists, and the agent needs only to know what to do next.
 */
export function failureFor(status: number, notFound = 'Not found.'): ToolResult {
  switch (status) {
    case 401:
      return failure('Your access was revoked or has expired. Reconnect to this server.');
    case 403:
      return failure('You are not permitted to do that.');
    case 404:
      return failure(notFound);
    case 429:
      return failure('Rate limited. Wait a moment and try again.');
    default:
      return failure(
        status >= 500
          ? 'The platform is unavailable. Try again shortly.'
          : 'The platform refused the request.'
      );
  }
}

/** The route's error code (`{ error: { code } }`), if it sent one. */
export const errorCode = (body: unknown): string | undefined => {
  const code = (body as { error?: { code?: unknown } } | undefined)?.error?.code;
  return typeof code === 'string' ? code : undefined;
};

/**
 * A fixed message for a write refusal, chosen by status and, where several refusals share one,
 * by the route's error code. The route's own text is never relayed: it can echo input.
 */
export function writeFailure(response: BridgeResponse, notFound: string): ToolResult {
  const code = errorCode(response.body);
  switch (response.status) {
    case 402:
      return failure(
        "Your organization's monthly budget is used up, so no new run can start. Nothing was launched."
      );
    case 403:
      if (code === 'MCP_TEMPLATE_RUNS_DISABLED') {
        return failure(
          'Template launches through MCP are turned off. Ask an administrator to enable them. Nothing was launched.'
        );
      }
      if (code === 'MCP_DELIVER_MODE_NOT_ALLOWED') {
        return failure('This delivery mode is not allowed through MCP. Nothing was launched.');
      }
      return code === 'MCP_WRITE_DISABLED'
        ? failure('Write access is turned off on this platform.')
        : failureFor(403);
    case 409:
      if (code === 'IDEMPOTENCY_KEY_IN_PROGRESS' || code === 'IDEMPOTENCY_KEY_RETRY') {
        return failure(
          'A request with this idempotency key is still starting. Retry shortly with the same key.'
        );
      }
      // The override is deliberately not a tool input: a person decides to launch it as it is.
      return code === 'UNCHANGED_AFTER_NOT_ACTIONABLE'
        ? failure(
            'This same request stopped as not actionable before and nothing has changed. Change it (add the ticket text or acceptance criteria) and submit again, or have a person launch it as it is from the dashboard or the CLI. Nothing was launched.'
          )
        : failure('The run is not in a state where this can be done.');
    case 422:
      return code === 'IDEMPOTENCY_KEY_MISMATCH'
        ? failure(
            'That idempotency key was already used for a different request. Use a new key for a different request.'
          )
        : failure('The platform refused the request.');
    case 429:
      return code === 'MCP_RUN_CAP_REACHED'
        ? failure(
            'You already have the maximum number of runs in flight. Wait for one to finish, or cancel one, then try again.'
          )
        : failure('Too many write calls. Wait a minute and try again.');
    default:
      return failureFor(response.status, notFound);
  }
}

export const query = (entries: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  return params;
};

export interface ToolKit {
  app: FastifyInstance;
  /** For a tool that needs the request (`extra`) a {@link readTool} does not hand on: waits. */
  server: McpServer;
  caller: McpCaller;
  /** The dashboard origin without a trailing slash. */
  origin: string;
  /** One GET to a REST route, as the caller. */
  get: (path: string, params?: URLSearchParams) => Promise<BridgeResponse>;
  /** One read tool: choose the request, run it, reduce the response. */
  readTool: <Shape extends z.ZodRawShape>(
    name: string,
    config: {
      title: string;
      description: string;
      input: Shape;
      output: z.ZodType;
      notFound?: string;
    },
    run: (args: z.infer<z.ZodObject<Shape>>) => Promise<BridgeResponse>,
    project: (
      body: unknown,
      args: z.infer<z.ZodObject<Shape>>
    ) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>
  ) => void;
}

/**
 * `adminTools` names the tools the manifest declares as the admin tier (`domains/index.ts`): the
 * kit registers one only for a caller holding `mcp:admin`, so without it the tool is absent from
 * `tools/list`.
 */
export function createToolKit(
  server: McpServer,
  deps: McpToolDeps,
  caller: McpCaller,
  adminTools: readonly string[] = []
): ToolKit {
  const { app, bridge } = deps;
  const get = (path: string, params?: URLSearchParams) => bridge.get(app, caller, path, params);

  function readTool<Shape extends z.ZodRawShape>(
    name: string,
    config: {
      title: string;
      description: string;
      input: Shape;
      output: z.ZodType;
      notFound?: string;
    },
    run: (args: z.infer<z.ZodObject<Shape>>) => Promise<BridgeResponse>,
    project: (
      body: unknown,
      args: z.infer<z.ZodObject<Shape>>
    ) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>
  ) {
    if (adminTools.includes(name) && !caller.scopes.includes(MCP_SCOPE_ADMIN)) {
      return;
    }
    server.registerTool(
      name,
      {
        annotations: { ...READ_ONLY, title: config.title },
        description: config.description,
        inputSchema: z.object(config.input).strict(),
        outputSchema: config.output,
        title: config.title,
      },
      async (args: z.infer<z.ZodObject<Shape>>): Promise<ToolResult> => {
        // Nothing thrown below may reach the agent: the SDK would pass an error's message through
        // as the tool result, and an internal error can name hosts, ports and queries.
        try {
          const response = await run(args);
          if (response.status !== 200) {
            return failureFor(response.status, config.notFound);
          }
          const projected = await project(response.body, args);
          if (projected === null) {
            app.log.error({ tool: name }, 'mcp: a route returned a body the tool could not read');
            return failure('The platform returned an unexpected response.');
          }
          return ok(config.output.parse(projected) as Record<string, unknown>);
        } catch (err) {
          app.log.error({ err, tool: name }, 'mcp: a tool failed');
          return failureFor(500);
        }
      }
    );
  }

  return { app, caller, get, origin: deps.dashboardOrigin.replace(/\/+$/, ''), readTool, server };
}
