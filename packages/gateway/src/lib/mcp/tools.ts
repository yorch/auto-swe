import { type AuthInfo, McpServer } from '@modelcontextprotocol/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MCP_SCOPE_READ, MCP_SCOPE_WRITE } from '../mcpOAuth.js';
import { ExternalTicketIdSchema, MAX_DESCRIPTION_LENGTH } from '../ticketId.js';
import {
  type BridgeResponse,
  callerFromAuthInfo,
  type McpBridge,
  type McpCaller,
} from './bridge.js';
import {
  cancelOutput,
  humanStepsOutput,
  projectRunResult,
  repositoriesOutput,
  restCancelled,
  restHumanSteps,
  restRepositories,
  restRun,
  restRuns,
  restSubmitted,
  restWorkRequests,
  runOutput,
  runsOutput,
  submitOutput,
  workRequestsOutput,
} from './projections.js';

/**
 * The tools. Each is one call to a REST route made through the bridge, so the route's own role
 * check and visibility filter decide what comes back; the tool only chooses the request and
 * reduces the response to an allowlisted shape. No tool reads the database. The read tools are
 * GETs; the two write tools are POSTs to routes that bound them themselves
 * (`lib/mcpWriteGuard.ts`), so a tool is never the control.
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

  /** The hosts a PR link may be on. If they cannot be read the run is still returned, without its result. */
  const githubHosts = async (): Promise<readonly string[]> => {
    try {
      return await deps.getGitHubHosts();
    } catch (err) {
      app.log.error({ err }, 'mcp: could not read the configured GitHub hosts');
      return [];
    }
  };

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
        'Get one workflow run: status, cost, token totals, timing, each step as node, status and attempt, the pull request it opened (when it did), and a dashboard link. Step errors, inputs, outputs and traces are not returned; open the dashboard link for those. For a work request you just submitted, get the run id from list_runs with its workRequestId.',
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
        result: projectRunResult(data.result, await githubHosts()),
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

/** The tools that need `mcp:write`. */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(['submit_work_request', 'cancel_run']);

const WRITE = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: false,
} as const;

/** Route error codes a write tool understands. Anything else is a fixed generic message. */
const errorCode = (body: unknown): string | undefined => {
  const code = (body as { error?: { code?: unknown } } | undefined)?.error?.code;
  return typeof code === 'string' ? code : undefined;
};

/**
 * A fixed message for a write refusal, chosen by status and, where several refusals share one,
 * by the route's error code. The route's own text is never relayed: it can echo input.
 */
function writeFailure(response: BridgeResponse, notFound: string): ToolResult {
  const code = errorCode(response.body);
  switch (response.status) {
    case 402:
      return failure(
        "Your organization's monthly budget is used up, so no new run can start. Nothing was launched."
      );
    case 403:
      return code === 'MCP_WRITE_DISABLED'
        ? failure('Write access is turned off on this platform.')
        : failureFor(403);
    case 409:
      return code === 'IDEMPOTENCY_KEY_IN_PROGRESS' || code === 'IDEMPOTENCY_KEY_RETRY'
        ? failure(
            'A request with this idempotency key is still starting. Retry shortly with the same key.'
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

/**
 * The write tools: `submit_work_request` and `cancel_run`, registered only for a token that holds
 * `mcp:write` (which the verifier grants only while `mcp.writeToolsEnabled` is on). Neither can
 * approve, merge or answer a human step: no tool does, and the routes they reach do none of it.
 */
export function registerWriteTools(server: McpServer, deps: McpToolDeps, caller: McpCaller) {
  const { app, bridge } = deps;

  server.registerTool(
    'submit_work_request',
    {
      annotations: { ...WRITE, title: 'Submit a work request' },
      description:
        "Submit a work request: the platform's agents implement the ticket in the repository and open a pull request for a person to review and merge. This tool never merges or approves anything. The run launches under YOUR identity, not a service account: it is recorded as launched by you, and where per-user GitHub credentials are enabled it may push branches and open pull requests with your own GitHub token. The description is read by the platform's agents as their instructions. Always the standard budget tier, and you may have only a few runs in flight at once. idempotencyKey is required: use a new random key for each distinct request, and reuse the same key only to retry that same request, which then returns the work request it started instead of starting another. Use list_repositories for repoId. The result carries workRequestId: pass it to cancel_run to stop the run, or to list_runs and get_run to follow it. The run itself appears a moment after the submit, so a list_runs for the work request can be empty at first.",
      inputSchema: z
        .object({
          description: z
            .string()
            .min(1)
            .max(MAX_DESCRIPTION_LENGTH)
            .describe("What to implement: the instructions the platform's agents will follow"),
          externalTicketId: ExternalTicketIdSchema.describe('The ticket id, such as JIRA-1234'),
          idempotencyKey: z
            .string()
            .regex(/^[A-Za-z0-9._:~-]{8,128}$/)
            .describe(
              '8-128 characters from A-Z a-z 0-9 . _ : ~ - (a UUID is ideal). A new key per distinct request; the same key to retry one.'
            ),
          repoId: z.string().uuid().describe('The repository id, from list_repositories'),
        })
        .strict(),
      outputSchema: submitOutput,
      title: 'Submit a work request',
    },
    async (args): Promise<ToolResult> => {
      try {
        const response = await bridge.post(app, caller, '/api/v1/work-requests', {
          body: {
            description: args.description,
            externalTicketId: args.externalTicketId,
            repoIds: [args.repoId],
          },
          idempotencyKey: args.idempotencyKey,
        });
        if (response.status === 409 && errorCode(response.body) === 'WORKFLOW_ALREADY_EXISTS') {
          // Not a failure: this ticket is already being worked on, and nothing was launched.
          return ok(submitOutput.parse({ status: 'already_running' }));
        }
        if (response.status !== 200 && response.status !== 201) {
          return writeFailure(response, 'Repository not found.');
        }
        const parsed = restSubmitted.safeParse(response.body);
        if (!parsed.success) {
          app.log.error(
            { tool: 'submit_work_request' },
            'mcp: a route returned an unreadable body'
          );
          return failure('The platform returned an unexpected response.');
        }
        return ok(
          submitOutput.parse({
            status: parsed.data.data.deduplicated ? 'already_submitted' : 'started',
            workRequestId: parsed.data.data.workRequestId,
          })
        );
      } catch (err) {
        app.log.error({ err, tool: 'submit_work_request' }, 'mcp: a tool failed');
        return failureFor(500);
      }
    }
  );

  /** Cancel one run through the route; the route decides whether the caller may. */
  async function cancelOne(runId: string): Promise<ToolResult | null> {
    const response = await bridge.post(app, caller, `/api/v1/workflow-runs/${runId}/cancel`);
    if (response.status === 409) {
      return failure('The run is not running, so it cannot be cancelled.');
    }
    if (response.status === 502) {
      return failure('The platform could not cancel the run. Try again.');
    }
    if (response.status !== 200) {
      return writeFailure(response, 'Run not found.');
    }
    if (!restCancelled.safeParse(response.body).success) {
      app.log.error({ tool: 'cancel_run' }, 'mcp: a route returned an unreadable body');
      return failure('The platform returned an unexpected response.');
    }
    return null;
  }

  server.registerTool(
    'cancel_run',
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
        title: 'Cancel a run',
      },
      description:
        "Cancel a workflow run that is still running. Give runId (from list_runs or get_run), or the workRequestId that submit_work_request returned, which cancels that work request's running run; right after a submit the run may not exist yet, and the tool says so, so retry in a few seconds. Only runs you may control can be cancelled, the same as in the dashboard; a run you can see but do not own may be refused. Cancelling stops the run and cannot be undone. It does not approve, reject or answer any human step.",
      inputSchema: z
        .object({
          runId: z.string().uuid().optional().describe('The run id, from list_runs or get_run'),
          workRequestId: z
            .string()
            .uuid()
            .optional()
            .describe('The workRequestId submit_work_request returned'),
        })
        .strict(),
      outputSchema: cancelOutput,
      title: 'Cancel a run',
    },
    async (args): Promise<ToolResult> => {
      try {
        if ((args.runId === undefined) === (args.workRequestId === undefined)) {
          return failure('Give exactly one of runId or workRequestId.');
        }
        let runIds: string[];
        if (args.runId !== undefined) {
          runIds = [args.runId];
        } else {
          const listed = await bridge.get(
            app,
            caller,
            '/api/v1/workflow-runs',
            query({ limit: 20, status: 'RUNNING', workRequestId: args.workRequestId })
          );
          if (listed.status !== 200) {
            return writeFailure(listed, 'Work request not found.');
          }
          const parsed = restRuns.safeParse(listed.body);
          if (!parsed.success) {
            app.log.error({ tool: 'cancel_run' }, 'mcp: a route returned an unreadable body');
            return failure('The platform returned an unexpected response.');
          }
          runIds = parsed.data.data.map((r) => r.id);
          if (runIds.length === 0) {
            return failure(
              'No running run was found for that work request. It may not have started yet (try again in a few seconds) or it has already finished; list_runs shows its state.'
            );
          }
        }
        for (const runId of runIds) {
          const refused = await cancelOne(runId);
          if (refused) {
            return refused;
          }
        }
        return ok(cancelOutput.parse({ runIds, status: 'CANCELLED' }));
      } catch (err) {
        app.log.error({ err, tool: 'cancel_run' }, 'mcp: a tool failed');
        return failureFor(500);
      }
    }
  );
}

/**
 * The server for one HTTP request. The factory runs per request, so which tools exist is decided
 * here from the verified token: a call with no `mcp:read` sees none, and the write tools exist only with `mcp:write`.
 */
export function createMcpToolServer(deps: McpToolDeps, authInfo: AuthInfo | undefined): McpServer {
  const server = new McpServer(
    { name: 'auto-swe', version: deps.serverVersion },
    { capabilities: { tools: {} } }
  );
  const caller = callerFromAuthInfo(authInfo);
  if (caller?.scopes.includes(MCP_SCOPE_READ)) {
    registerReadTools(server, deps, caller);
    // `mcp:write` is in the scopes only while writes are enabled and the user consented to them.
    if (caller.scopes.includes(MCP_SCOPE_WRITE)) {
      registerWriteTools(server, deps, caller);
    }
  }
  return server;
}
