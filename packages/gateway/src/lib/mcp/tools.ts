import { type AuthInfo, McpServer } from '@modelcontextprotocol/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MCP_SCOPE_READ } from '../mcpOAuth.js';
import {
  type BridgeResponse,
  callerFromAuthInfo,
  type McpBridge,
  type McpCaller,
} from './bridge.js';
import {
  humanStepsOutput,
  projectRunResult,
  repositoriesOutput,
  restHumanSteps,
  restRepositories,
  restRun,
  restRuns,
  restWorkRequests,
  runOutput,
  runsOutput,
  workRequestsOutput,
} from './projections.js';

/**
 * The read tools. Each is one GET to a REST route made through the bridge, so the route's own
 * role check and visibility filter decide what comes back; the tool only chooses the request and
 * reduces the response to an allowlisted shape. No tool reads the database.
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

const pageInput = {
  limit: z.number().int().min(1).max(100).optional().describe('Page size, 1-100 (default 50)'),
  offset: z.number().int().min(0).optional().describe('How many results to skip (default 0)'),
};

const READ_ONLY = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
} as const;

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

function ok(output: Record<string, unknown>): ToolResult {
  return { content: [{ text: JSON.stringify(output), type: 'text' }], structuredContent: output };
}

function failure(text: string): ToolResult {
  return { content: [{ text, type: 'text' }], isError: true };
}

/**
 * A fixed message per status, never the route's own message: a REST error can echo input or name
 * what exists, and the agent needs only to know what to do next.
 */
function failureFor(status: number, notFound = 'Not found.'): ToolResult {
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

const query = (entries: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }
  return params;
};

/** Register the read tools on `server` for `caller`. */
export function registerReadTools(server: McpServer, deps: McpToolDeps, caller: McpCaller) {
  const { app, bridge } = deps;
  const origin = deps.dashboardOrigin.replace(/\/+$/, '');

  /** One tool: choose the request, run it, reduce the response. */
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
      }
    );
  }

  const get = (path: string, params?: URLSearchParams) => bridge.get(app, caller, path, params);

  readTool(
    'list_repositories',
    {
      description:
        'List the repositories you can submit work against: id, GitHub organization and name, default branch and owning team (50 per page by default; use offset to page).',
      input: pageInput,
      output: repositoriesOutput,
      title: 'List repositories',
    },
    (args) => get('/api/v1/repositories', query({ ...args, limit: args.limit ?? 50 })),
    (body) => {
      const parsed = restRepositories.safeParse(body);
      if (!parsed.success) {
        return null;
      }
      return {
        // Git repositories only: the route also lists the other kinds of connection.
        limit: parsed.data.meta.limit,
        offset: parsed.data.meta.offset,
        repositories: parsed.data.data
          .filter((r) => r.type === 'git_repo')
          .map(({ type: _type, ...r }) => r),
        total: parsed.data.meta.total,
      };
    }
  );

  readTool(
    'list_work_requests',
    {
      description:
        'List work requests (tickets submitted to the platform), newest first, with the state of their workflows. Descriptions and requester names are not returned.',
      input: {
        ...pageInput,
        ticket: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Only ticket ids containing this text'),
      },
      output: workRequestsOutput,
      title: 'List work requests',
    },
    (args) => get('/api/v1/work-requests', query(args)),
    (body) => {
      const parsed = restWorkRequests.safeParse(body);
      if (!parsed.success) {
        return null;
      }
      return {
        limit: parsed.data.meta.limit,
        offset: parsed.data.meta.offset,
        total: parsed.data.meta.total,
        workRequests: parsed.data.data.map((w) => ({
          activeWorkflows: w.activeWorkflows.map((a) => ({ id: a.id, status: a.currentStatus })),
          createdAt: w.createdAt,
          externalTicketId: w.externalTicketId,
          id: w.id,
          isMine: w.requestedBy?.id === caller.userId,
        })),
      };
    }
  );

  readTool(
    'list_runs',
    {
      description:
        'List workflow runs you can see, newest first: status, template, timing and cost. Use get_run for one run.',
      input: {
        ...pageInput,
        status: z
          .enum(['RUNNING', 'SUCCESS', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'SKIPPED'])
          .optional()
          .describe('Only runs in this status'),
        workRequestId: z.string().uuid().optional().describe('Only runs of this work request'),
      },
      output: runsOutput,
      title: 'List runs',
    },
    (args) => get('/api/v1/workflow-runs', query(args)),
    (body) => {
      const parsed = restRuns.safeParse(body);
      if (!parsed.success) {
        return null;
      }
      return {
        limit: parsed.data.meta.limit,
        offset: parsed.data.meta.offset,
        runs: parsed.data.data,
        total: parsed.data.meta.total,
      };
    }
  );

  readTool(
    'get_run',
    {
      description:
        'Get one workflow run: status, cost, token totals, timing, each step as node, status and attempt, the pull request it opened (when it did), and a dashboard link. Step errors, inputs, outputs and traces are not returned; open the dashboard link for those.',
      input: { runId: z.string().uuid().describe('The run id') },
      notFound: 'Run not found.',
      output: runOutput,
      title: 'Get a run',
    },
    // A run the caller cannot see is a 404, exactly as in REST.
    (args) => get(`/api/v1/workflow-runs/${args.runId}`),
    async (body) => {
      const parsed = restRun.safeParse(body);
      if (!parsed.success) {
        return null;
      }
      const { data } = parsed.data;
      return {
        costUsdAccrued: data.costUsdAccrued,
        dashboardUrl: `${origin}/runs/${data.id}`,
        endedAt: data.endedAt,
        id: data.id,
        result: projectRunResult(data.result, await deps.getGitHubHosts()),
        startedAt: data.startedAt,
        status: data.status,
        steps: data.steps.map((s) => ({
          attempt: s.attempt,
          failed: s.status === 'FAILED',
          nodeId: s.nodeId,
          status: s.status,
        })),
        templateName: data.templateName,
        tokensInputTotal: data.tokensInputTotal,
        tokensOutputTotal: data.tokensOutputTotal,
        workRequest: data.workRequest,
      };
    }
  );

  readTool(
    'list_pending_human_steps',
    {
      description:
        'List the pending human steps (approvals and answers) on runs you can see, which for an administrator is every team: which run, what kind, its title and deadline. At most 100, newest first; `truncated` is true when there may be more. What to answer is not returned and cannot be answered here; use the inbox link.',
      input: {},
      output: humanStepsOutput,
      title: 'List pending human steps',
    },
    () => get('/api/v1/human-steps'),
    (body) => {
      const parsed = restHumanSteps.safeParse(body);
      if (!parsed.success) {
        return null;
      }
      return {
        humanSteps: parsed.data.data.map((s) => ({ ...s, inboxUrl: `${origin}/govern/approvals` })),
        // The route takes 100 and reports no total: a full page may be hiding more.
        truncated: parsed.data.data.length >= 100,
      };
    }
  );
}

/**
 * The server for one HTTP request. The factory runs per request, so which tools exist is decided
 * here from the verified token: a call with no `mcp:read` sees none.
 */
export function createMcpToolServer(deps: McpToolDeps, authInfo: AuthInfo | undefined): McpServer {
  const server = new McpServer(
    { name: 'auto-swe', version: deps.serverVersion },
    { capabilities: { tools: {} } }
  );
  const caller = callerFromAuthInfo(authInfo);
  if (caller?.scopes.includes(MCP_SCOPE_READ)) {
    registerReadTools(server, deps, caller);
  }
  return server;
}
