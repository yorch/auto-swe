import { z } from 'zod';
import { meta, nullableTimestamp, shortName, status, ticketId, timestamp } from '../projections.js';
import { pageInput, query, type ToolKit } from '../toolKit.js';
import type { McpDomain } from './index.js';

/**
 * Work: the cross-repository epics and the recurring schedules a user can see. An epic's or a
 * schedule's description is written by a person (or an agent), so it is never returned, and neither
 * is who requested or created it; a schedule's name is clipped like a team name.
 */

const restEpics = z.object({
  data: z.array(
    z.object({
      createdAt: timestamp,
      externalTicketId: ticketId,
      repoCount: z.number().int(),
      requestedBy: z.object({ id: z.string().uuid() }).nullable(),
      status,
      updatedAt: nullableTimestamp,
      workRequestId: z.string().uuid(),
    })
  ),
  meta,
});

const epicsOutput = z.object({
  epics: z.array(
    z.object({
      createdAt: z.string(),
      repositoryCount: z.number().int(),
      requestedById: z.string().uuid().nullable(),
      status: z.string(),
      ticketId: z.string().nullable(),
      updatedAt: z.string().nullable(),
      workRequestId: z.string().uuid(),
    })
  ),
  limit: z.number(),
  offset: z.number(),
  total: z.number(),
});

const restSchedules = z.object({
  data: z.array(
    z.object({
      budgetTier: status,
      canManage: z.boolean(),
      cronExpression: shortName(100),
      id: z.string().uuid(),
      isActive: z.boolean(),
      lastFiredAt: nullableTimestamp,
      name: shortName(200),
      repository: z.object({
        id: z.string().uuid(),
        organizationName: shortName(200).nullable(),
        repoName: shortName(200).nullable(),
      }),
      schedule: z
        .object({
          exists: z.boolean().nullable(),
          lastRunAt: nullableTimestamp,
          nextRunAt: nullableTimestamp,
          paused: z.boolean(),
          unavailable: z.boolean().optional(),
        })
        .catch({
          exists: null,
          lastRunAt: null,
          nextRunAt: null,
          paused: false,
          unavailable: true,
        }),
      workRequestId: z.string().uuid().nullable().optional(),
    })
  ),
});

const schedulesOutput = z.object({
  schedules: z.array(
    z.object({
      budgetTier: z.string(),
      canManage: z.boolean(),
      cron: z.string(),
      id: z.string().uuid(),
      isActive: z.boolean(),
      lastFiredAt: z.string().nullable(),
      lastRunAt: z.string().nullable(),
      name: z.string(),
      nextRunAt: z.string().nullable(),
      paused: z.boolean(),
      repository: z.object({
        id: z.string().uuid(),
        organizationName: z.string().nullable(),
        repoName: z.string().nullable(),
      }),
      /** False when the scheduler could not be asked, so the live fields are unknown. */
      scheduleKnown: z.boolean(),
    })
  ),
});

export const workDomain: McpDomain = {
  name: 'work',
  register({ get, readTool }: ToolKit) {
    readTool(
      'list_epics',
      {
        description:
          'List cross-repository epics, newest first: ticket id, status, how many repositories it spans, who requested it (a user id), and the work request behind it. By default every epic you can see (scope TEAM); MINE shows only the ones you requested. Descriptions are not returned.',
        input: {
          ...pageInput,
          scope: z.enum(['MINE', 'TEAM']).optional(),
          teamId: z
            .string()
            .uuid()
            .optional()
            .describe('Only epics with a child on a repository this team owns or has shared'),
        },
        output: epicsOutput,
        title: 'List epics',
      },
      (args) => get('/api/v1/epics', query({ ...args, limit: args.limit ?? 50 })),
      (body) => {
        const parsed = restEpics.safeParse(body);
        return parsed.success
          ? {
              epics: parsed.data.data.map((e) => ({
                createdAt: e.createdAt,
                repositoryCount: e.repoCount,
                requestedById: e.requestedBy?.id ?? null,
                status: e.status,
                ticketId: e.externalTicketId,
                updatedAt: e.updatedAt,
                workRequestId: e.workRequestId,
              })),
              limit: parsed.data.meta.limit,
              offset: parsed.data.meta.offset,
              total: parsed.data.meta.total,
            }
          : null;
      }
    );

    readTool(
      'list_schedules',
      {
        description:
          'List the recurring work-request schedules on repositories you can reach: name, cron expression, whether it is active or paused, last and next run, the repository, and whether you may manage it. Descriptions, authors and the work they submit are not returned.',
        input: {},
        output: schedulesOutput,
        title: 'List schedules',
      },
      () => get('/api/v1/scheduled-work-requests'),
      (body) => {
        const parsed = restSchedules.safeParse(body);
        return parsed.success
          ? {
              schedules: parsed.data.data.map((s) => ({
                budgetTier: s.budgetTier,
                canManage: s.canManage,
                cron: s.cronExpression,
                id: s.id,
                isActive: s.isActive,
                lastFiredAt: s.lastFiredAt,
                lastRunAt: s.schedule.lastRunAt,
                name: s.name,
                nextRunAt: s.schedule.nextRunAt,
                paused: s.schedule.paused,
                repository: s.repository,
                scheduleKnown: s.schedule.exists !== null && !s.schedule.unavailable,
              })),
            }
          : null;
      }
    );
  },
  tools: [
    { name: 'list_epics', route: 'GET /api/v1/epics', tier: 'user' },
    { name: 'list_schedules', route: 'GET /api/v1/scheduled-work-requests', tier: 'user' },
  ],
};
