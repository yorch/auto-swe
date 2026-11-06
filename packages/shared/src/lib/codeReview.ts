import { z } from 'zod';
import { BaseBranchSchema } from './gitRef.js';

export const REVIEW_TEMPLATE_KIND = 'review';
export const REVIEW_COMMENT_MARKER_PREFIX = '<!-- auto-swe:code-review:';
export const REVIEW_ON_BLOCKING = ['report', 'fix'] as const;
export const REVIEW_INTENT_STATUSES = ['pending', 'started', 'skipped', 'failed'] as const;
export const REVIEW_ERROR_CODES = {
  DISABLED: 'REVIEW_DISABLED',
  HEAD_CHANGED: 'REVIEW_HEAD_CHANGED',
  NOTHING_TO_REVIEW: 'REVIEW_NOTHING_TO_REVIEW',
  SOURCE_IS_REVIEW: 'REVIEW_SOURCE_IS_REVIEW',
  SOURCE_NOT_FINISHED: 'REVIEW_SOURCE_NOT_FINISHED',
  TEMPLATE_INVALID: 'REVIEW_TEMPLATE_INVALID',
  TEMPLATE_NEEDS_SOURCE: 'REVIEW_TEMPLATE_NEEDS_SOURCE',
} as const;
export type ReviewErrorCode = (typeof REVIEW_ERROR_CODES)[keyof typeof REVIEW_ERROR_CODES];

const HeadShaSchema = z.string().regex(/^[a-fA-F0-9]{40}$/);
export const ReviewOfSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('pr'), prNumber: z.number().int().positive() }),
  z.strictObject({
    baseBranch: BaseBranchSchema.optional(),
    branch: BaseBranchSchema,
    headSha: HeadShaSchema,
    mode: z.literal('branch'),
  }),
  z.strictObject({ mode: z.literal('stored') }),
]);
export type ReviewOf = z.infer<typeof ReviewOfSchema>;

export const ReviewRunPayloadSchema = z.strictObject({
  connectionId: z.string().uuid(),
  onBlocking: z.enum(REVIEW_ON_BLOCKING).default('report'),
  presetId: z.string().uuid().optional(),
  reviewOf: ReviewOfSchema,
  sourceRunId: z.string().uuid(),
  systemPrompt: z.string().max(100_000).optional(),
});
export type ReviewRunPayload = z.infer<typeof ReviewRunPayloadSchema>;

export const ReviewPresetCreateSchema = z.strictObject({
  description: z.string().max(4000).default(''),
  enabled: z.boolean().default(true),
  name: z.string().trim().min(1).max(200),
  onBlocking: z.enum(REVIEW_ON_BLOCKING).default('report'),
  systemPrompt: z.string().max(100_000).nullable().optional(),
  templateId: z.string().uuid(),
});
export type ReviewPresetCreateInput = z.input<typeof ReviewPresetCreateSchema>;
export const ReviewPresetUpdateSchema = ReviewPresetCreateSchema.extend({
  description: z.string().max(4000),
  enabled: z.boolean(),
  onBlocking: z.enum(REVIEW_ON_BLOCKING),
})
  .partial()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'At least one preset field is required',
  });
export type ReviewPresetUpdateInput = z.input<typeof ReviewPresetUpdateSchema>;

export const ReviewPresetAttachmentSchema = z
  .strictObject({
    connectionId: z.string().uuid().optional(),
    presetId: z.string().uuid(),
    templateId: z.string().uuid().optional(),
  })
  .refine((value) => (value.templateId !== undefined) !== (value.connectionId !== undefined), {
    message: 'Exactly one source template or repository is required',
  });
export type ReviewPresetAttachmentInput = z.infer<typeof ReviewPresetAttachmentSchema>;

export interface ReviewSourceFacts {
  status: string;
  templateKind?: string | null;
  reviewOfRunId?: string | null;
  pullRequest?: { status: string; prNumber: number | null } | null;
  codeResult?: { branch?: string; headSha?: string; baseBranch?: string } | null;
  isAgentRun?: boolean;
  deliver?: string;
  storedDiff?: string | null;
}

export type ResolveReviewOfResult =
  | { ok: true; reviewOf: ReviewOf }
  | { ok: false; code: ReviewErrorCode };

export function resolveReviewOf(source: ReviewSourceFacts): ResolveReviewOfResult {
  if (!['SUCCESS', 'FAILED', 'TIMED_OUT', 'SKIPPED', 'CANCELLED'].includes(source.status)) {
    return { code: REVIEW_ERROR_CODES.SOURCE_NOT_FINISHED, ok: false };
  }
  if (source.templateKind === REVIEW_TEMPLATE_KIND || source.reviewOfRunId) {
    return { code: REVIEW_ERROR_CODES.SOURCE_IS_REVIEW, ok: false };
  }
  if (source.pullRequest?.status === 'OPEN') {
    const pr = ReviewOfSchema.safeParse({ mode: 'pr', prNumber: source.pullRequest.prNumber });
    if (pr.success) {
      return { ok: true, reviewOf: pr.data };
    }
  }
  const branch = ReviewOfSchema.safeParse({
    branch: source.codeResult?.branch,
    headSha: source.codeResult?.headSha,
    mode: 'branch',
    ...(source.codeResult?.baseBranch !== undefined
      ? { baseBranch: source.codeResult.baseBranch }
      : {}),
  });
  if (branch.success) {
    return { ok: true, reviewOf: branch.data };
  }
  if (source.isAgentRun && source.deliver === 'none' && source.storedDiff?.trim()) {
    return { ok: true, reviewOf: { mode: 'stored' } };
  }
  return { code: REVIEW_ERROR_CODES.NOTHING_TO_REVIEW, ok: false };
}

export function reviewWorkflowId(repoId: string, hexId: string): string {
  const repo = z.string().uuid().parse(repoId).slice(0, 8).toLowerCase();
  const hex = z
    .string()
    .regex(/^[a-fA-F0-9]{8,}$/)
    .parse(hexId)
    .slice(0, 8)
    .toLowerCase();
  return `review-${repo}-${hex}`;
}
