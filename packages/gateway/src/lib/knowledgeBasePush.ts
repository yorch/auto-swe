import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { webhookRepositoryWhere } from './repositoryHost.js';

const Push = z.object({
  after: z.string().regex(/^[0-9a-f]{40,64}$/i),
  deleted: z.boolean().optional(),
  ref: z.string(),
  repository: z.object({ full_name: z.string(), html_url: z.string().optional() }),
});

export async function triggerKnowledgeBasePush(
  app: FastifyInstance,
  body: unknown,
  host: string | null
): Promise<void> {
  const parsed = Push.safeParse(body);
  if (
    !parsed.success ||
    parsed.data.deleted ||
    /^0+$/.test(parsed.data.after) ||
    !parsed.data.ref.startsWith('refs/heads/')
  ) {
    return;
  }
  const [org, repoName, extra] = parsed.data.repository.full_name.split('/');
  if (!org || !repoName || extra) {
    return;
  }
  const where = await webhookRepositoryWhere(
    app.prisma,
    org,
    repoName,
    parsed.data.repository.html_url,
    host
  );
  const bases = await runUnscoped(
    'a verified push names a host repository, not a tenant',
    ['KnowledgeBase'],
    () =>
      app.prisma.knowledgeBase.findMany({
        select: { connection: { select: { defaultBranch: true } }, defaultRef: true, id: true },
        where: { connection: { ...where, isActive: true, type: 'git_repo' }, status: 'OK' },
      })
  );
  const branch = parsed.data.ref.slice('refs/heads/'.length);
  for (const kb of bases) {
    if (branch === (kb.defaultRef ?? kb.connection.defaultBranch)?.replace(/^refs\/heads\//, '')) {
      await app.temporal.startKnowledgeBaseIndex(kb.id);
    }
  }
}
