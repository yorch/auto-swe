import type { McpServer } from '@modelcontextprotocol/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
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

export function createToolKit(server: McpServer, deps: McpToolDeps, caller: McpCaller): ToolKit {
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

  return { app, caller, get, origin: deps.dashboardOrigin.replace(/\/+$/, ''), readTool };
}
