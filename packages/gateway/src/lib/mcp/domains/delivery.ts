import { z } from 'zod';
import {
  meta,
  money,
  nullableTimestamp,
  projectRunResult,
  shortName,
  status,
  ticketId,
  timestamp,
} from '../projections.js';
import { pageInput, query, type ToolKit } from '../toolKit.js';
import type { McpDomain } from './index.js';

/**
 * Delivery: the pull requests the platform opened and the ceilings an agent run launches under.
 * A pull request's title is written by an agent from a ticket, so it is never returned; the link is
 * rebuilt and checked against the GitHub hosts the platform is configured for, as `get_run` does.
 */

const restPullRequests = z.object({
  data: z.array(
    z.object({
      ciStatus: shortName(32).nullable(),
      closedAt: nullableTimestamp,
      costUsd: money
        .nullable()
        .optional()
        .transform((v) => v ?? null),
      id: z.string().uuid(),
      isDraft: z.boolean(),
      latestRun: z
        .object({ id: z.string().uuid(), status })
        .nullable()
        .optional()
        .transform((v) => v ?? null),
      mergedAt: nullableTimestamp,
      openedAt: timestamp,
      prNumber: z.number().int().positive(),
      repository: z
        .object({ id: z.string().uuid(), name: shortName(200), org: shortName(200) })
        .nullable(),
      status,
      ticketId: ticketId.nullable(),
      url: z.string().nullable(),
      workRequestId: z.string().uuid().nullable(),
    })
  ),
  meta,
});

const pullRequestsOutput = z.object({
  limit: z.number(),
  offset: z.number(),
  pullRequests: z.array(
    z.object({
      ciStatus: z.string().nullable(),
      closedAt: z.string().nullable(),
      costUsd: z.number().nullable(),
      id: z.string().uuid(),
      isDraft: z.boolean(),
      latestRun: z.object({ id: z.string().uuid(), status: z.string() }).nullable(),
      mergedAt: z.string().nullable(),
      number: z.number().int(),
      openedAt: z.string(),
      repository: z.object({ id: z.string().uuid(), name: z.string(), org: z.string() }).nullable(),
      status: z.string(),
      ticketId: z.string().nullable(),
      url: z.string().nullable(),
      workRequestId: z.string().uuid().nullable(),
    })
  ),
  total: z.number(),
});

const bound = z.object({ ceiling: z.number(), max: z.number(), min: z.number() });
const restLimits = z.object({
  data: z.object({
    concurrency: z.object({ global: z.number(), perTeam: z.number() }),
    enabled: z.boolean(),
    maxSteps: bound,
    maxWallClockSeconds: bound,
  }),
});
const limitsOutput = restLimits.shape.data;

export const deliveryDomain: McpDomain = {
  name: 'delivery',
  register({ get, readTool }: ToolKit, deps) {
    readTool(
      'list_pull_requests',
      {
        description:
          'List pull requests the platform opened, newest first: state, draft flag, CI status, repository, the ticket and run they came from, cost, and the link. By default only the ones from YOUR work requests (scope MINE); TEAM shows every pull request on repositories you can reach. Titles are not returned.',
        input: {
          ...pageInput,
          draft: z.enum(['any', 'draft', 'ready']).optional(),
          repoId: z.string().uuid().optional(),
          scope: z.enum(['MINE', 'TEAM']).optional(),
          state: z.enum(['OPEN', 'MERGED', 'CLOSED', 'all']).optional(),
          teamId: z.string().uuid().optional(),
          ticket: z
            .string()
            .min(1)
            .max(200)
            .optional()
            .describe('Only ticket ids containing this text'),
        },
        output: pullRequestsOutput,
        title: 'List pull requests',
      },
      (args) => get('/api/v1/pull-requests', query({ ...args, limit: args.limit ?? 50 })),
      async (body) => {
        const parsed = restPullRequests.safeParse(body);
        if (!parsed.success) {
          return null;
        }
        let hosts: readonly string[] = [];
        try {
          hosts = await deps.getGitHubHosts();
        } catch (err) {
          deps.app.log.error({ err }, 'mcp: could not read the configured GitHub hosts');
        }
        return {
          limit: parsed.data.meta.limit,
          offset: parsed.data.meta.offset,
          pullRequests: parsed.data.data.map((p) => ({
            ciStatus: p.ciStatus,
            closedAt: p.closedAt,
            costUsd: p.costUsd,
            id: p.id,
            isDraft: p.isDraft,
            latestRun: p.latestRun,
            mergedAt: p.mergedAt,
            number: p.prNumber,
            openedAt: p.openedAt,
            repository: p.repository,
            status: p.status,
            ticketId: p.ticketId,
            url: projectRunResult({ prNumber: p.prNumber, prUrl: p.url }, hosts)?.prUrl ?? null,
            workRequestId: p.workRequestId,
          })),
          total: parsed.data.meta.total,
        };
      }
    );

    readTool(
      'get_agent_run_limits',
      {
        description:
          'Get the ceilings an agent run launches under (step count, wall-clock seconds, concurrency) and whether agent runs are enabled, for a repository or platform-wide. Numbers only.',
        input: {
          repoId: z.string().uuid().optional().describe('Resolve the ceilings at this repository'),
        },
        notFound: 'Repository not found.',
        output: limitsOutput,
        title: 'Get agent run limits',
      },
      (args) => get('/api/v1/agent-runs/limits', query(args)),
      (body) => {
        const parsed = restLimits.safeParse(body);
        return parsed.success ? parsed.data.data : null;
      }
    );
  },
  tools: [
    { name: 'list_pull_requests', route: 'GET /api/v1/pull-requests', tier: 'user' },
    { name: 'get_agent_run_limits', route: 'GET /api/v1/agent-runs/limits', tier: 'user' },
  ],
};
