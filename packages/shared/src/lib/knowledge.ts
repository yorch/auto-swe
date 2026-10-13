import { z } from 'zod';
import type { KnowledgeStatus as DbKnowledgeStatus } from '../generated/prisma/enums.js';
import type { KnowledgeItemWhereInput } from '../generated/prisma/models/KnowledgeItem.js';

export const KNOWLEDGE_TYPES = ['LEARNING', 'REFERENCE', 'DECISION', 'POLICY'] as const;
export const KNOWLEDGE_STATUSES = ['UNREVIEWED', 'APPROVED', 'REJECTED', 'SUPERSEDED'] as const;
export const KNOWLEDGE_VISIBILITIES = [
  'REPOSITORY',
  'TEAM',
  'SELECTED_TEAMS',
  'ORGANIZATION',
] as const;

export const KnowledgeTypeSchema = z.enum(KNOWLEDGE_TYPES);
export const KnowledgeStatusSchema = z.enum(KNOWLEDGE_STATUSES);
export const KnowledgeVisibilitySchema = z.enum(KNOWLEDGE_VISIBILITIES);

export const KnowledgeEvidenceSchema = z.object({
  kind: z.enum(['run', 'node', 'artifact', 'code', 'test']),
  note: z.string().max(1000).optional(),
  reference: z.string().min(1).max(300),
});

export const CreateKnowledgeLearningSchema = z.object({
  content: z.string().trim().min(20).max(12000),
  evidence: z.array(KnowledgeEvidenceSchema).min(1).max(10),
  idempotencyKey: z.string().min(8).max(160),
  nodeId: z.string().min(1).max(160),
  title: z.string().trim().min(3).max(160),
});

export const CreateCuratedKnowledgeItemSchema = z.object({
  content: z.string().trim().min(20).max(12000),
  repoId: z.string().uuid().optional(),
  teamId: z.string().uuid(),
  title: z.string().trim().min(3).max(160),
  type: z.enum(['REFERENCE', 'DECISION', 'POLICY']),
});

export const KnowledgeManagementFilterSchema = z.object({
  limit: z.number().int().min(1).max(100).default(25),
  query: z.string().trim().min(1).max(160).optional(),
  status: KnowledgeStatusSchema.optional(),
  type: KnowledgeTypeSchema.optional(),
});

export const ReviseKnowledgeItemSchema = z.object({
  content: z.string().trim().min(20).max(12000),
  expectedVersion: z.number().int().positive(),
  title: z.string().trim().min(3).max(160),
});

export const ApproveKnowledgeItemSchema = z.object({
  expectedVersion: z.number().int().positive(),
  selectedTeamIds: z.array(z.string().uuid()).max(100).default([]),
  visibility: KnowledgeVisibilitySchema,
});

export type KnowledgeType = z.infer<typeof KnowledgeTypeSchema>;
export type KnowledgeStatus = z.infer<typeof KnowledgeStatusSchema>;
export type KnowledgeVisibility = z.infer<typeof KnowledgeVisibilitySchema>;
export type KnowledgeEvidence = z.infer<typeof KnowledgeEvidenceSchema>;
export type CreateKnowledgeLearning = z.infer<typeof CreateKnowledgeLearningSchema>;
export type CreateCuratedKnowledgeItem = z.infer<typeof CreateCuratedKnowledgeItemSchema>;
export type KnowledgeManagementFilter = z.infer<typeof KnowledgeManagementFilterSchema>;
export type ReviseKnowledgeItem = z.infer<typeof ReviseKnowledgeItemSchema>;
export type ApproveKnowledgeItem = z.infer<typeof ApproveKnowledgeItemSchema>;

export type KnowledgeTrustLabel =
  | 'UNREVIEWED_LOCAL_LEARNING'
  | 'UNREVIEWED_CURATED_REQUIRES_REVIEW'
  | 'APPROVED_REVIEWED_VERSION'
  | 'REJECTED'
  | 'SUPERSEDED';

/** Safe retrieval shape: never includes evidence, raw provenance, or the embedding. */
export interface KnowledgeScalarProjection {
  id: string;
  type: KnowledgeType;
  status: KnowledgeStatus;
  visibility: KnowledgeVisibility;
  title: string;
  content: string;
  version: number;
  createdAt: Date;
  trustLabel: KnowledgeTrustLabel;
}

export function toKnowledgeScalarProjection(
  item: Omit<KnowledgeScalarProjection, 'trustLabel'>
): KnowledgeScalarProjection {
  return {
    content: item.content,
    createdAt: item.createdAt,
    id: item.id,
    status: item.status,
    title: item.title,
    trustLabel:
      item.status === 'APPROVED'
        ? 'APPROVED_REVIEWED_VERSION'
        : item.status === 'UNREVIEWED' && item.type === 'LEARNING'
          ? 'UNREVIEWED_LOCAL_LEARNING'
          : item.status === 'REJECTED'
            ? 'REJECTED'
            : item.status === 'SUPERSEDED'
              ? 'SUPERSEDED'
              : 'UNREVIEWED_CURATED_REQUIRES_REVIEW',
    type: item.type,
    version: item.version,
    visibility: item.visibility,
  };
}

export interface KnowledgeManagementProjection extends KnowledgeScalarProjection {
  provenance: {
    producerRunId: string | null;
    producerNodeId: string | null;
    producerAgentKey: string | null;
    modelSpec: string | null;
    evidence: KnowledgeEvidence[];
  } | null;
}

export interface KnowledgeAccessScope {
  userId: string;
  teamIds: string[];
  orgIds: string[];
  repoIds: string[];
  isPlatformAdmin: boolean;
}

/** Prisma-compatible eligibility predicate shared by list and detail retrieval. */
export function knowledgeReadableWhere(scope: KnowledgeAccessScope): KnowledgeItemWhereInput {
  if (
    !scope.userId ||
    (!scope.isPlatformAdmin &&
      scope.teamIds.length === 0 &&
      scope.orgIds.length === 0 &&
      scope.repoIds.length === 0)
  ) {
    return { id: { in: [] } };
  }
  if (scope.isPlatformAdmin) {
    const trust = {
      OR: [
        { status: 'APPROVED' as const },
        { status: 'UNREVIEWED' as const, type: 'LEARNING' as const },
      ],
    };
    return {
      OR: [
        ...(scope.repoIds.length
          ? [
              {
                AND: [
                  {
                    organization: { isActive: true },
                    originTeam: {
                      id: { in: scope.teamIds },
                      isActive: true,
                      orgId: { in: scope.orgIds },
                    },
                    ownerTeam: {
                      id: { in: scope.teamIds },
                      isActive: true,
                      orgId: { in: scope.orgIds },
                    },
                    repoId: { in: scope.repoIds },
                    repository: {
                      is: {
                        isActive: true,
                        team: {
                          isActive: true,
                          organization: { isActive: true },
                          orgId: { in: scope.orgIds },
                        },
                        teamId: { in: scope.teamIds },
                      },
                    },
                    visibility: 'REPOSITORY' as const,
                  },
                  trust,
                ],
              },
            ]
          : []),
        ...scope.teamIds.map((teamId) => ({
          originTeamId: teamId,
          repoId: null,
          visibility: 'REPOSITORY' as const,
          ...trust,
        })),
        ...scope.teamIds.map((teamId) => ({
          ownerTeamId: teamId,
          status: 'APPROVED' as const,
          visibility: 'TEAM' as const,
        })),
        ...(scope.teamIds.length
          ? [
              {
                grants: { some: { teamId: { in: scope.teamIds } } },
                status: 'APPROVED' as const,
                visibility: 'SELECTED_TEAMS' as const,
              },
            ]
          : []),
        ...scope.orgIds.map((orgId) => ({
          orgId,
          status: 'APPROVED' as const,
          visibility: 'ORGANIZATION' as const,
        })),
      ],
    };
  }

  const localTrust = {
    OR: [
      { status: 'APPROVED' as DbKnowledgeStatus },
      { status: 'UNREVIEWED' as DbKnowledgeStatus, type: 'LEARNING' as const },
    ],
  };
  const locals = [
    ...(scope.teamIds.length
      ? [{ originTeamId: { in: scope.teamIds }, repoId: null, visibility: 'REPOSITORY' as const }]
      : []),
    ...(scope.repoIds.length
      ? [
          {
            organization: { isActive: true },
            originTeam: { isActive: true, orgId: { in: scope.orgIds } },
            ownerTeam: { isActive: true, orgId: { in: scope.orgIds } },
            repoId: { in: scope.repoIds },
            repository: {
              is: {
                isActive: true,
                team: {
                  isActive: true,
                  organization: { isActive: true },
                  orgId: { in: scope.orgIds },
                },
                teamId: { in: scope.teamIds },
                type: 'git_repo',
              },
            },
            visibility: 'REPOSITORY' as const,
          },
        ]
      : []),
  ];
  const shared = [
    ...(scope.teamIds.length
      ? [
          {
            ownerTeamId: { in: scope.teamIds },
            status: 'APPROVED' as const,
            visibility: 'TEAM' as const,
          },
          {
            grants: { some: { teamId: { in: scope.teamIds } } },
            status: 'APPROVED' as const,
            visibility: 'SELECTED_TEAMS' as const,
          },
        ]
      : []),
    ...(scope.orgIds.length
      ? [
          {
            orgId: { in: scope.orgIds },
            status: 'APPROVED' as const,
            visibility: 'ORGANIZATION' as const,
          },
        ]
      : []),
  ];
  return {
    OR: [
      ...locals.map((local) => ({ AND: [local, localTrust] })),

      ...shared,
    ],
  };
}

export function canApproveKnowledge(
  role: 'ADMIN' | 'LEAD' | 'ENGINEER' | null,
  orgRole: 'ORG_ADMIN' | 'ORG_MEMBER' | null,
  platformAdmin: boolean,
  visibility: KnowledgeVisibility
): boolean {
  if (platformAdmin) {
    return true;
  }
  if (visibility === 'ORGANIZATION') {
    return orgRole === 'ORG_ADMIN';
  }
  if (visibility === 'SELECTED_TEAMS') {
    return role === 'ADMIN' || role === 'LEAD';
  }
  return role === 'ADMIN' || role === 'LEAD';
}
