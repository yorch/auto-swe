import type { Prisma } from '@auto-swe/shared';
import {
  type KnowledgeBaseOverrides,
  MAX_DEPENDENCY_CHECKOUTS,
  resolveKnowledgeBaseSet,
} from '@auto-swe/shared/lib/knowledgeBaseResolution';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { sendError } from './httpErrors.js';

export const KnowledgeBaseRef = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (ref) =>
      !ref.startsWith('-') &&
      !/[\s~^:?*[\\]/.test(ref) &&
      [...ref].every((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127) &&
      !ref.includes('..') &&
      !ref.includes('@{'),
    'Invalid git ref'
  );
export const KnowledgeBaseOverridesSchema = z.object({
  add: z
    .array(z.object({ id: z.string().uuid(), ref: KnowledgeBaseRef.nullish() }))
    .max(100)
    .optional(),
  exclude: z.array(z.string().uuid()).max(100).optional(),
});

export function normalizedKnowledgeBaseOverrides(
  body: z.infer<typeof KnowledgeBaseOverridesSchema>
): KnowledgeBaseOverrides {
  return {
    add: (body.add ?? []).map(({ id, ref }) => ({
      knowledgeBaseId: id,
      ...(ref !== undefined ? { ref } : {}),
    })),
    exclude: body.exclude ?? [],
  };
}

export function storedKnowledgeBases(requestPayload: string | null | undefined) {
  if (!requestPayload) {
    return undefined;
  }
  try {
    const parsed = z
      .object({ knowledgeBases: KnowledgeBaseOverridesSchema.optional() })
      .safeParse(JSON.parse(requestPayload));
    return parsed.success ? parsed.data.knowledgeBases : undefined;
  } catch {
    return undefined;
  }
}

export function attachableKnowledgeBaseWhere(
  teamId: string,
  orgId: string
): Prisma.KnowledgeBaseWhereInput {
  return {
    OR: [
      { connection: { teamId } },
      { visibility: 'ORG' },
      { shares: { some: { teamId } }, visibility: 'SHARED' },
    ],
    orgId,
    status: 'OK',
  };
}

export async function effectiveKnowledgeBases(
  prisma: FastifyInstance['prisma'],
  target: { teamId: string; orgId: string; repoId?: string; templateId?: string },
  runOverrides?: KnowledgeBaseOverrides
) {
  const links = await prisma.knowledgeBaseLink.findMany({
    orderBy: { id: 'asc' },
    where: {
      knowledgeBase: {
        AND: [attachableKnowledgeBaseWhere(target.teamId, target.orgId)],
        orgId: target.orgId,
      },
      OR: [
        { scope: 'TEAM', teamId: target.teamId },
        ...(target.repoId ? [{ repoId: target.repoId, scope: 'REPO' as const }] : []),
        ...(target.templateId
          ? [{ scope: 'TEMPLATE' as const, templateId: target.templateId }]
          : []),
      ],
    },
  });
  return resolveKnowledgeBaseSet({
    cap: MAX_DEPENDENCY_CHECKOUTS,
    repoLinks: links.filter((link) => link.scope === 'REPO'),
    runOverrides,
    teamLinks: links.filter((link) => link.scope === 'TEAM'),
    templateLinks: links.filter((link) => link.scope === 'TEMPLATE'),
  });
}

export async function validateKnowledgeBaseOverrides(
  prisma: FastifyInstance['prisma'],
  reply: FastifyReply,
  target: { teamId: string; orgId: string; repoId?: string; templateId?: string } | undefined,
  body: z.infer<typeof KnowledgeBaseOverridesSchema> | undefined
): Promise<KnowledgeBaseOverrides | undefined | false> {
  if (!body) {
    return undefined;
  }
  if (!target) {
    sendError(reply, 400, 'KNOWLEDGE_BASE_TARGET', 'Knowledge bases require a run team');
    return false;
  }
  const overrides = normalizedKnowledgeBaseOverrides(body);
  const ids = [
    ...new Set([
      ...(overrides.add ?? []).map((item) => item.knowledgeBaseId),
      ...(overrides.exclude ?? []),
    ]),
  ];
  const rows = await prisma.knowledgeBase.findMany({
    select: { id: true },
    where: {
      AND: [attachableKnowledgeBaseWhere(target.teamId, target.orgId)],
      id: { in: ids },
      orgId: target.orgId,
    },
  });
  if (rows.length !== ids.length) {
    sendError(
      reply,
      400,
      'KNOWLEDGE_BASE_UNAVAILABLE',
      'A knowledge base is not attachable by this team'
    );
    return false;
  }
  const result = await effectiveKnowledgeBases(prisma, target, overrides);
  if (result.refusedExclusions.length) {
    sendError(
      reply,
      400,
      'KNOWLEDGE_BASE_MANDATORY',
      'Mandatory knowledge bases cannot be excluded'
    );
    return false;
  }
  return overrides;
}
