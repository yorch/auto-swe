import { z } from 'zod';
import { BaseBranchSchema } from './gitRef.js';
import type { InputSchema } from './inputSchema.js';

/** Name of the built-in template a pull-request feedback automation starts by default. */
export const PR_FEEDBACK_TEMPLATE_NAME = 'address-pr-feedback';

/** What a feedback delivery is: which GitHub event carried it. */
export const PR_FEEDBACK_EVENT_KINDS = ['review', 'review_comment', 'issue_comment'] as const;
export type PrFeedbackEventKind = (typeof PR_FEEDBACK_EVENT_KINDS)[number];

/** What a feedback delivery asks for: a requested change, or the explicit command. */
export const PR_FEEDBACK_TRIGGERS = ['changes_requested', 'command'] as const;
export type PrFeedbackTrigger = (typeof PR_FEEDBACK_TRIGGERS)[number];

/** Who opened the pull request the feedback is on. */
export const PR_FEEDBACK_ORIGINS = ['workflow', 'agent_run', 'other'] as const;
export type PrFeedbackOrigin = (typeof PR_FEEDBACK_ORIGINS)[number];

/** Defaults of the options an automation may set, applied wherever the payload omits one. */
export const PR_FEEDBACK_DEFAULTS = {
  maxCiFixAttempts: 1,
  maxRounds: 5,
} as const;

/** Bounds of the options. */
export const PR_FEEDBACK_ROUNDS_RANGE = { max: 20, min: 1 } as const;
export const PR_FEEDBACK_CI_FIX_ATTEMPTS_RANGE = { max: 1, min: 0 } as const;

/**
 * Payload keys a feedback occurrence fills. An automation's own inputs may not
 * name them, and at fire time the occurrence's values always win.
 */
export const PR_FEEDBACK_EVENT_INPUT_KEYS = [
  'baseBranch',
  'connectionId',
  'description',
  'feedbackEventId',
  'feedbackEventKind',
  'feedbackOrigin',
  'feedbackTrigger',
  'pullRequestNumber',
  'ticketId',
] as const;

/**
 * The run payload of the `address-pr-feedback` template. It names the pull
 * request by number and the feedback event by id — never by URL — so the
 * worker re-reads both from the repository itself, and nothing in the payload
 * can point the platform credential anywhere else. `baseBranch` is the pull
 * request's head branch (which may be a platform work branch: the feedback run
 * is based on the branch the pull request tracks, not one it cuts).
 *
 * The rest are the options an automation sets (its `inputs`), each defaulted
 * here, so this parse is the authority on their bounds whatever validated them
 * before.
 */
export const PrFeedbackPayloadSchema = z.object({
  baseBranch: BaseBranchSchema,
  connectionId: z.string().uuid(),
  description: z.string().max(4000).optional(),
  feedbackEventId: z.string().regex(/^\d{1,20}$/),
  feedbackEventKind: z.enum(PR_FEEDBACK_EVENT_KINDS),
  feedbackOrigin: z.enum(PR_FEEDBACK_ORIGINS),
  feedbackTrigger: z.enum(PR_FEEDBACK_TRIGGERS),
  maxCiFixAttempts: z
    .number()
    .int()
    .min(PR_FEEDBACK_CI_FIX_ATTEMPTS_RANGE.min)
    .max(PR_FEEDBACK_CI_FIX_ATTEMPTS_RANGE.max)
    .default(PR_FEEDBACK_DEFAULTS.maxCiFixAttempts),
  maxRounds: z
    .number()
    .int()
    .min(PR_FEEDBACK_ROUNDS_RANGE.min)
    .max(PR_FEEDBACK_ROUNDS_RANGE.max)
    .default(PR_FEEDBACK_DEFAULTS.maxRounds),
  pullRequestNumber: z.number().int().positive(),
  ticketId: z.string().max(200).optional(),
});
export type PrFeedbackPayload = z.infer<typeof PrFeedbackPayloadSchema>;

/**
 * The run-input contract of the `address-pr-feedback` template, declared on it
 * so the gateway validates a launch — and an automation's options — against
 * it. The pull request and the feedback event are named by id; the worker
 * reads everything else about them from the repository itself.
 */
export const PR_FEEDBACK_INPUT_SCHEMA: InputSchema = {
  properties: {
    baseBranch: { type: 'string' },
    connectionId: { connectionType: 'git_repo', type: 'connection' },
    description: { type: 'string' },
    feedbackEventId: { type: 'string' },
    feedbackEventKind: { type: 'string' },
    feedbackOrigin: { type: 'string' },
    feedbackTrigger: { type: 'string' },
    maxCiFixAttempts: {
      default: PR_FEEDBACK_DEFAULTS.maxCiFixAttempts,
      description:
        'How many times a pushed fix may be revised when the CI on the pushed commit fails.',
      integer: true,
      maximum: PR_FEEDBACK_CI_FIX_ATTEMPTS_RANGE.max,
      minimum: PR_FEEDBACK_CI_FIX_ATTEMPTS_RANGE.min,
      title: 'CI fix attempts after a push',
      type: 'number',
    },
    maxRounds: {
      default: PR_FEEDBACK_DEFAULTS.maxRounds,
      description:
        'How many rounds of feedback on one pull request may push a change; later rounds only comment.',
      integer: true,
      maximum: PR_FEEDBACK_ROUNDS_RANGE.max,
      minimum: PR_FEEDBACK_ROUNDS_RANGE.min,
      title: 'Rounds that may push',
      type: 'number',
    },
    pullRequestNumber: { type: 'number' },
    ticketId: { type: 'string' },
  },
  required: [
    'baseBranch',
    'connectionId',
    'feedbackEventId',
    'feedbackEventKind',
    'feedbackOrigin',
    'feedbackTrigger',
    'pullRequestNumber',
  ],
  type: 'object',
};
