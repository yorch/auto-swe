import { AGENT_REF_RE } from '@auto-swe/shared/lib/agentRun';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { BridgeResponse, McpCaller } from './bridge.js';
import {
  errorCode,
  failure,
  failureFor,
  type McpToolDeps,
  ok,
  type ToolResult,
  WRITE,
  writeFailure,
} from './toolKit.js';

/**
 * The two write tools that drive an orchestration: start one, and send a message to it or to one
 * of its agents. They are the only orchestration writes there are. Attaching a repository,
 * declining one, approving or denying a tool call, cancelling and ending an orchestration are
 * human acts on the dashboard and the CLI: no tool here reaches those routes, and
 * `orchestrations.test.ts` fails if one is added.
 *
 * Like every write tool, these call a REST route as the signed-in user; the guards (writes
 * enabled, burst limit, STANDARD tier, idempotency key, concurrency cap, the launcher check)
 * run in the route.
 */

export const orchestrationLaunchOutput = z.object({
  dashboardUrl: z.string(),
  orchestrationId: z.string().uuid(),
  orchestrationStatus: z.string(),
  status: z.enum(['started', 'already_submitted']),
});

export const orchestrationMessageOutput = z.object({
  childId: z.string().uuid().nullable(),
  messageId: z.string().uuid(),
  status: z.literal('sent'),
});

const restLaunched = z.object({
  data: z.object({
    orchestrationId: z.string().uuid(),
    status: z.string().max(40),
  }),
});

const restMessage = z.object({
  data: z.object({ childId: z.string().uuid().nullable(), id: z.string().uuid() }),
});

/**
 * Orchestration refusals, by the route's code. The route's text is never relayed: a refusal can
 * echo input. Anything not named here falls through to the shared per-status message.
 */
function orchestrationFailure(response: BridgeResponse, notFound: string): ToolResult {
  const code = errorCode(response.body);
  switch (`${response.status} ${code ?? ''}`) {
    case '403 ORCHESTRATION_DISABLED':
      return failure('Orchestrated runs are turned off on this platform. Nothing was started.');
    case '403 NOT_LAUNCHER':
      return failure(
        'Only the person who launched this orchestration can send it a message. Nothing was sent.'
      );
    case '403 AGENT_RUNS_DISABLED':
      return failure('Agent runs are disabled for this team. Nothing was started.');
    case '409 ORCHESTRATION_NOT_ACTIVE':
      return failure(
        'This orchestration has ended, so it cannot take a message. Nothing was sent.'
      );
    case '422 MCP_CONNECTIONS_NOT_ALLOWED':
      return failure(
        'An orchestration started through MCP has no MCP connection set. Nothing was started.'
      );
    case '422 IDEMPOTENCY_KEY_MISMATCH':
      return failure(
        'That idempotency key was already used for a different request. Use a new key. Nothing was started.'
      );
    case '409 CHILD_NOT_ALLOWED':
      return failure(
        'That agent is not running (it has finished, or its run has not started yet). Nothing was sent.'
      );
    case '409 RUN_CONFLICT':
      return failure(
        'That idempotency key is already used by another launch. Use a new key for a different request.'
      );
    case '400 AGENT_NOT_LAUNCHABLE':
    case '400 AGENT_PIN_SHADOWED':
    case '404 AGENT_NOT_FOUND':
      return failure(
        'An agent on the allowlist cannot be used here. Check list_agents. Nothing was started.'
      );
    case '400 TEAM_REPO_MISMATCH':
    case '400 REPO_REQUIRED':
      return failure(
        "Give a repoId, or a teamId you belong to. With both, teamId must be the repository's owning team. Nothing was started."
      );
    case '503 ORCHESTRATION_UNAVAILABLE':
      return failure('Orchestrations are unavailable. Try again shortly.');
    default:
      return writeFailure(response, notFound);
  }
}

export function registerOrchestrationWriteTools(
  server: McpServer,
  deps: McpToolDeps,
  caller: McpCaller
) {
  const { app, bridge } = deps;
  const origin = deps.dashboardOrigin.replace(/\/+$/, '');

  server.registerTool(
    'orchestrations_launch',
    {
      annotations: { ...WRITE, title: 'Start an orchestration' },
      description:
        'Start an orchestration: a conversation in which an orchestrator agent splits your task between the agents on `allowlist` and reports back. It acts as YOU, under YOUR identity and your saved GitHub credentials. Give `allowlist` (agent keys from list_agents, 1-20) and either `repoId` (from list_repositories) or a `teamId` you belong to; with no repository the orchestration can only read. Always the standard budget tier, and the in-flight run cap applies. `deliveryDefault` (default none) is the most its writer agents may deliver once a repository is attached (none, then branch, then draft_pr); every writer it starts must also use a delivery mode the platform allows through MCP at that moment, and its agents count toward your in-flight run cap. It cannot attach a repository, approve a tool call, cancel or end the orchestration: you do those in the dashboard, and the orchestrator may ask for them there. Use a new idempotencyKey per distinct task and reuse it only to retry that task. Follow with orchestrations_get and orchestrations_messages.',
      inputSchema: z
        .object({
          allowlist: z.array(z.string().min(1).max(130).regex(AGENT_REF_RE)).min(1).max(20),
          deliveryDefault: z.enum(['none', 'draft_pr', 'branch']).optional(),
          idempotencyKey: z
            .string()
            .regex(/^[A-Za-z0-9._:~-]{8,128}$/)
            .describe(
              '8-128 characters from A-Z a-z 0-9 . _ : ~ - (a UUID is ideal). A new key per distinct request; the same key to retry one.'
            ),
          repoId: z
            .string()
            .uuid()
            .optional()
            .describe('The repository id, from list_repositories'),
          task: z.string().min(1).max(20_000).describe('What to get done, in your own words'),
          teamId: z
            .string()
            .uuid()
            .optional()
            .describe('The team that owns the work; required when there is no repoId'),
        })
        .strict()
        .refine((a) => a.repoId !== undefined || a.teamId !== undefined, 'Give repoId or teamId'),
      outputSchema: orchestrationLaunchOutput,
      title: 'Start an orchestration',
    },
    async ({ idempotencyKey, ...body }): Promise<ToolResult> => {
      try {
        const response = await bridge.post(app, caller, '/api/v1/orchestrations', {
          body,
          idempotencyKey,
        });
        if (response.status !== 200 && response.status !== 201) {
          return orchestrationFailure(response, 'Repository, team or agent not found.');
        }
        const parsed = restLaunched.safeParse(response.body);
        if (!parsed.success) {
          app.log.error(
            { tool: 'orchestrations_launch' },
            'mcp: a route returned an unreadable body'
          );
          return failure('The platform returned an unexpected response.');
        }
        const id = parsed.data.data.orchestrationId;
        return ok(
          orchestrationLaunchOutput.parse({
            dashboardUrl: `${origin}/orchestrations/${id}`,
            orchestrationId: id,
            orchestrationStatus: /^[A-Z_]{1,32}$/.test(parsed.data.data.status)
              ? parsed.data.data.status
              : 'UNKNOWN',
            // A replay of the key answers 200; a new orchestration answers 201.
            status: response.status === 200 ? 'already_submitted' : 'started',
          })
        );
      } catch (err) {
        app.log.error({ err, tool: 'orchestrations_launch' }, 'mcp: a tool failed');
        return failureFor(500);
      }
    }
  );

  server.registerTool(
    'orchestrations_message',
    {
      annotations: {
        ...WRITE,
        idempotentHint: false,
        title: 'Message an orchestration',
      },
      description:
        'Send a message, as YOU, to an orchestration you launched: to its orchestrator, or with `childId` (from orchestrations_get) to one running agent, which reads it at its next step. A message to a finished orchestration (cancelled, failed or completed: a completed one is restarted from the dashboard, not here) or agent is refused. Only the launcher can send one. This is steering only: it does not approve a tool call, attach a repository, cancel or end anything. The text is read by agents as instructions from you. Each call counts against the per-minute write limit and a repeat sends the message again.',
      inputSchema: z
        .object({
          body: z.string().min(1).max(4000),
          childId: z
            .string()
            .uuid()
            .optional()
            .describe('Address one agent instead of the orchestrator'),
          orchestrationId: z.string().uuid(),
        })
        .strict(),
      outputSchema: orchestrationMessageOutput,
      title: 'Message an orchestration',
    },
    async ({ orchestrationId, childId, body }): Promise<ToolResult> => {
      try {
        const path = childId
          ? `/api/v1/orchestrations/${orchestrationId}/children/${childId}/messages`
          : `/api/v1/orchestrations/${orchestrationId}/messages`;
        const response = await bridge.post(app, caller, path, { body: { body } });
        if (response.status !== 200 && response.status !== 201) {
          return orchestrationFailure(response, 'Orchestration or agent not found.');
        }
        const parsed = restMessage.safeParse(response.body);
        if (!parsed.success) {
          app.log.error(
            { tool: 'orchestrations_message' },
            'mcp: a route returned an unreadable body'
          );
          return failure('The platform returned an unexpected response.');
        }
        return ok(
          orchestrationMessageOutput.parse({
            childId: parsed.data.data.childId,
            messageId: parsed.data.data.id,
            status: 'sent',
          })
        );
      } catch (err) {
        app.log.error({ err, tool: 'orchestrations_message' }, 'mcp: a tool failed');
        return failureFor(500);
      }
    }
  );
}
