import { getArtifactText } from '@auto-swe/shared/lib/artifactStore';
import {
  buildOutcomeReport,
  OUTCOME_REPORT_ARTIFACT_KIND,
  OUTCOME_REPORT_DEFAULT_WINDOW_DAYS,
  trailingWindow,
} from '@auto-swe/shared/lib/outcomeReport';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { type OutcomeReport, renderOutcomeReportMarkdown } from '@auto-swe/shared/workflow';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';

const FormatQuery = z.object({ format: z.enum(['json', 'markdown']).default('json') });
const LiveQuery = FormatQuery.extend({
  windowDays: z.coerce.number().int().min(7).max(365).default(OUTCOME_REPORT_DEFAULT_WINDOW_DAYS),
});

/**
 * Outcome metrics (docs/outcome-metrics.md). The report spans every tenant, so both routes are
 * ADMIN-only: `GET /` computes it now from run data, `GET /latest` serves the newest snapshot the
 * scheduled regeneration stored.
 */
export const outcomeReportRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const admin = requireAuth({ requiredRole: 'ADMIN' });

  app.get('/', { onRequest: admin, schema: { querystring: LiveQuery } }, async (request, reply) => {
    const now = new Date();
    const report = await buildOutcomeReport(fastify.prisma, {
      now,
      window: trailingWindow(now, request.query.windowDays),
    });
    if (request.query.format === 'markdown') {
      return reply.type('text/markdown; charset=utf-8').send(renderOutcomeReportMarkdown(report));
    }
    return { data: report };
  });

  app.get(
    '/latest',
    { onRequest: admin, schema: { querystring: FormatQuery } },
    async (request, reply) => {
      const snapshot = await runUnscoped(
        'the outcome report snapshot is a platform-level artifact',
        ['WorkflowArtifact'],
        () =>
          fastify.prisma.workflowArtifact.findFirst({
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true, id: true },
            where: { kind: OUTCOME_REPORT_ARTIFACT_KIND, runId: null, status: 'ready' },
          })
      );
      if (!snapshot) {
        return reply.status(404).send({
          error:
            'No outcome report has been generated yet. The scheduled regeneration (OUTCOME_REPORT_ENABLED) writes the first one, or GET /api/v1/reports/outcomes computes one now.',
        });
      }
      const report = JSON.parse(await getArtifactText(snapshot.id)) as OutcomeReport;
      if (request.query.format === 'markdown') {
        return reply.type('text/markdown; charset=utf-8').send(renderOutcomeReportMarkdown(report));
      }
      return { data: report };
    }
  );
};
