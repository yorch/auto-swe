import { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveWorkflowRunAttribution } from './runAttribution.js';

/**
 * Imported by modelSuggestions.pg.test.ts and enabled with
 * MODEL_SUGGESTIONS_PG_TEST=1 against a migrated throwaway PostgreSQL database.
 */
const enabled = process.env.MODEL_SUGGESTIONS_PG_TEST === '1';

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Missing fixture at index ${index}`);
  }
  return value;
}

describe.skipIf(!enabled)('workflow run attribution backfill against Postgres', () => {
  const suffix = Math.random().toString(36).slice(2);
  const workflowIds = Array.from({ length: 7 }, (_, index) => `run-attribution-${suffix}-${index}`);
  const runIds: string[] = [];
  const requestIds: string[] = [];
  let templateIds: string[] = [];
  let connectionIds: string[] = [];
  let orgId = '';
  let teamIds: string[] = [];
  let serviceId = '';
  let channelId = '';

  async function cleanup() {
    await runUnscoped(
      'the attribution backfill test deletes only its unique fixtures',
      [
        'WorkflowRun',
        'ActiveWorkflow',
        'RunInput',
        'SlackChannel',
        'SlackWorkspace',
        'ServicePrincipal',
        'Connection',
        'WorkflowTemplate',
        'Team',
        'Organization',
      ],
      async () => {
        if (runIds.length) {
          await prisma.workflowRun.deleteMany({ where: { id: { in: runIds } } });
        }
        if (workflowIds.length) {
          await prisma.activeWorkflow.deleteMany({
            where: { temporalWorkflowId: { in: workflowIds } },
          });
        }
        if (requestIds.length) {
          await prisma.runInput.deleteMany({ where: { id: { in: requestIds } } });
        }
        if (channelId) {
          await prisma.slackChannel.deleteMany({ where: { id: channelId } });
        }
        await prisma.slackWorkspace.deleteMany({
          where: { slackTeamId: `run-attribution-${suffix}` },
        });
        if (serviceId) {
          await prisma.servicePrincipal.deleteMany({ where: { id: serviceId } });
        }
        if (connectionIds.length) {
          await prisma.connection.deleteMany({ where: { id: { in: connectionIds } } });
        }
        if (templateIds.length) {
          await prisma.workflowTemplate.deleteMany({ where: { id: { in: templateIds } } });
        }
        if (teamIds.length) {
          await prisma.team.deleteMany({ where: { id: { in: teamIds } } });
        }
        if (orgId) {
          await prisma.organization.deleteMany({ where: { id: orgId } });
        }
      }
    );
  }

  beforeAll(async () => {
    await cleanup();
    const org = await prisma.organization.create({
      data: { name: `run-attribution-${suffix}`, slug: `run-attribution-${suffix}` },
    });
    orgId = org.id;
    const teams = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        prisma.team.create({
          data: {
            name: `run-attribution-${suffix}-${index}`,
            orgId,
            slug: `run-attribution-${suffix}-${index}`,
          },
        })
      )
    );
    teamIds = teams.map((team) => team.id);
    const connections = await Promise.all(
      teams.map((team) => prisma.connection.create({ data: { teamId: team.id } }))
    );
    connectionIds = connections.map((connection) => connection.id);
    const templates = await Promise.all([
      ...teams.map((team, index) =>
        prisma.workflowTemplate.create({
          data: { name: `run-attribution-${suffix}-${index}`, teamId: team.id },
        })
      ),
      prisma.workflowTemplate.create({ data: { name: `run-attribution-${suffix}-global` } }),
    ]);
    templateIds = templates.map((template) => template.id);
    const service = await prisma.servicePrincipal.create({
      data: { name: `run-attribution-${suffix}`, teamId: requiredAt(teamIds, 3) },
    });
    serviceId = service.id;
    const workspace = await prisma.slackWorkspace.create({
      data: { name: `run-attribution-${suffix}`, orgId, slackTeamId: `run-attribution-${suffix}` },
    });
    const channel = await prisma.slackChannel.create({
      data: {
        orgId,
        slackChannelId: `C${suffix.slice(0, 8).toUpperCase()}`,
        teamId: requiredAt(teamIds, 2),
        workspaceId: workspace.id,
      },
    });
    channelId = channel.id;

    const requests = await Promise.all([
      prisma.runInput.create({
        data: {
          connectionId: connectionIds[1],
          externalTicketId: `r-${suffix}-request`,
          requestPayload: '{}',
        },
      }),
      prisma.runInput.create({
        data: {
          externalTicketId: `r-${suffix}-service`,
          requestedByServiceId: serviceId,
          requestPayload: '{}',
        },
      }),
      prisma.runInput.create({
        data: {
          billingOrgId: orgId,
          externalTicketId: `r-${suffix}-billing`,
          requestPayload: '{}',
        },
      }),
    ]);
    requestIds.push(...requests.map((request) => request.id));

    const runInputs = [
      {
        channelId: null,
        connectionId: null,
        repoId: connectionIds[0],
        templateId: requiredAt(templateIds, 4),
        workRequestId: null,
      },
      {
        channelId: null,
        connectionId: null,
        repoId: null,
        templateId: requiredAt(templateIds, 4),
        workRequestId: requiredAt(requests, 0).id,
      },
      {
        channelId,
        connectionId: null,
        repoId: null,
        templateId: requiredAt(templateIds, 4),
        workRequestId: null,
      },
      {
        channelId: null,
        connectionId: null,
        repoId: null,
        templateId: requiredAt(templateIds, 4),
        workRequestId: requiredAt(requests, 1).id,
      },
      {
        channelId: null,
        connectionId: null,
        repoId: null,
        templateId: requiredAt(templateIds, 4),
        workRequestId: null,
      },
      {
        channelId: null,
        connectionId: null,
        repoId: null,
        templateId: requiredAt(templateIds, 5),
        workRequestId: requiredAt(requests, 2).id,
      },
      {
        channelId: null,
        connectionId: null,
        repoId: null,
        templateId: requiredAt(templateIds, 5),
        workRequestId: null,
      },
    ];
    for (let index = 0; index < runInputs.length; index++) {
      const input = requiredAt(runInputs, index);
      const workflowId = requiredAt(workflowIds, index);
      const run = await prisma.workflowRun.create({
        data: {
          channelId: input.channelId,
          connectionId: input.connectionId,
          specSnapshot: {},
          templateId: input.templateId,
          templateVersion: 1,
          workflowId,
          ...(input.workRequestId ? { workRequestId: input.workRequestId } : {}),
        },
      });
      runIds.push(run.id);
      if (input.repoId) {
        await prisma.activeWorkflow.create({
          data: {
            currentStatus: 'RUNNING',
            repoId: input.repoId,
            temporalWorkflowId: workflowId,
          },
        });
      }
    }
  });

  afterAll(async () => {
    await cleanup();
  });

  it('matches resolver precedence, billing-org fallback, and null attribution', async () => {
    const expected = [
      resolveWorkflowRunAttribution({
        connection: { team: { id: requiredAt(teamIds, 0), orgId } },
      }),
      resolveWorkflowRunAttribution({
        workRequest: { connection: { team: { id: requiredAt(teamIds, 1), orgId } } },
      }),
      resolveWorkflowRunAttribution({ channel: { team: { id: requiredAt(teamIds, 2), orgId } } }),
      resolveWorkflowRunAttribution({
        workRequest: { requestedByService: { team: { id: requiredAt(teamIds, 3), orgId } } },
      }),
      resolveWorkflowRunAttribution({ template: { team: { id: requiredAt(teamIds, 4), orgId } } }),
      resolveWorkflowRunAttribution({ workRequest: { billingOrgId: orgId } }),
      resolveWorkflowRunAttribution({}),
    ];
    await prisma.$executeRaw`
      UPDATE "workflow_runs" AS target
      SET
        "attributed_team_id" = selected_team."id",
        "attributed_org_id" = COALESCE(selected_team."org_id", work_request."billing_org_id")
      FROM "workflow_runs" AS source
      LEFT JOIN "run_inputs" AS work_request ON work_request."id" = source."work_request_id"
      LEFT JOIN "active_workflows" AS aw ON aw."temporal_workflow_id" = source."workflow_id"
      LEFT JOIN "connections" AS run_connection
        ON run_connection."id" = COALESCE(source."connection_id", aw."repo_id")
      LEFT JOIN "connections" AS request_connection
        ON request_connection."id" = work_request."connection_id"
      LEFT JOIN "slack_channels" AS channel ON channel."id" = source."channel_id"
      LEFT JOIN "service_principals" AS requester
        ON requester."id" = work_request."requested_by_service_id"
      LEFT JOIN "workflow_templates" AS template ON template."id" = source."template_id"
      LEFT JOIN "teams" AS selected_team
        ON selected_team."id" = COALESCE(
          run_connection."team_id",
          request_connection."team_id",
          channel."team_id",
          requester."team_id",
          template."team_id"
        )
      WHERE target."id" = source."id"
        AND source."id" IN (${Prisma.join(runIds)})
        AND COALESCE(selected_team."id", work_request."billing_org_id") IS NOT NULL
    `;
    const actual = await prisma.workflowRun.findMany({
      select: { attributedOrgId: true, attributedTeamId: true, workflowId: true },
      where: { id: { in: runIds } },
    });
    expect(
      actual
        .sort((a, b) => a.workflowId.localeCompare(b.workflowId))
        .map((row) => ({
          attributedOrgId: row.attributedOrgId,
          attributedTeamId: row.attributedTeamId,
        }))
    ).toEqual(expected);
  });
});
