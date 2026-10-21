import { z } from 'zod';
import { type InputSchema, validateInputPayload } from '../../lib/inputSchema.js';
import {
  PR_FEEDBACK_DEFAULTS,
  PR_FEEDBACK_EVENT_INPUT_KEYS,
  PR_FEEDBACK_EVENT_KINDS,
  PR_FEEDBACK_ORIGINS,
  PR_FEEDBACK_TEMPLATE_NAME,
  PR_FEEDBACK_TRIGGERS,
  PrFeedbackPayloadSchema,
} from '../../lib/prFeedback.js';
import type { EventSource } from '../types.js';
import { visibleIssueText } from './issueLabeled.js';

/** The source key stored on an automation that reacts to pull-request review feedback. */
export const PR_FEEDBACK = 'github.pull_request.feedback';

const MAX_NOTES_CHARS = 4_000;

export const PrFeedbackFiltersSchema = z.object({
  /** Which pull requests may be acted on: ones the platform opened, or anybody's. */
  pullRequests: z
    .array(z.enum(['platform', 'others']))
    .min(1)
    .max(2)
    .transform((v) => [...new Set(v)]),
  /** What may start a run: a review asking for changes, or the explicit command. */
  triggers: z
    .array(z.enum(PR_FEEDBACK_TRIGGERS))
    .min(1)
    .max(PR_FEEDBACK_TRIGGERS.length)
    .transform((v) => [...new Set(v)]),
});
export type PrFeedbackFilters = z.infer<typeof PrFeedbackFiltersSchema>;

/**
 * A review or comment asking for a change on a pull request, as a decision needs it.
 * `headRef` and `origin` are filled by the gateway's enrichment (the signed payload alone
 * cannot say who opened the pull request); `origin` defaults to `other` so a delivery the
 * enrichment could not resolve reads as one the platform did not open.
 */
export const PrFeedbackFactsSchema = z.object({
  eventId: z.string().regex(/^\d{1,20}$/),
  eventKind: z.enum(PR_FEEDBACK_EVENT_KINDS),
  /** The pull request's head branch. Absent when the enrichment could not name it. */
  headRef: z.string().min(1).max(200).optional(),
  htmlUrl: z.string().max(500),
  /** The visible text after the command, or the review body. HTML comments stripped. */
  notes: z.string().max(MAX_NOTES_CHARS),
  origin: z.enum(PR_FEEDBACK_ORIGINS).default('other'),
  prNumber: z.number().int().positive(),
  senderId: z.string().regex(/^\d{1,20}$/),
  senderLogin: z.string().min(1).max(100),
  submittedAt: z.string().min(1).max(40),
  trigger: z.enum(PR_FEEDBACK_TRIGGERS),
});
export type PrFeedbackFacts = z.infer<typeof PrFeedbackFactsSchema>;

const COMMAND = /^\/auto-swe fix(?:\s|$)/i;

/**
 * The explicit request a member can leave on a pull request: a line that, trimmed, starts
 * with `/auto-swe fix` (case-insensitive, the next character whitespace or the line's end, so
 * `/auto-swe fixes` is not one). `notes` is the rest of that line plus every following line,
 * as the commenter could see it: HTML comments — which GitHub does not render — are stripped
 * first, so a command hidden in one does not count. Null when no line carries the command.
 */
export function parseFeedbackCommand(body: string): { notes: string } | null {
  const lines = visibleIssueText(body).split('\n');
  for (const [index, line] of lines.entries()) {
    const match = COMMAND.exec(line.trim());
    if (!match) {
      continue;
    }
    const notes = [line.trim().slice(match[0].length), ...lines.slice(index + 1)]
      .join('\n')
      .trim()
      .slice(0, MAX_NOTES_CHARS);
    return { notes };
  }
  return null;
}

/** How a trigger reads in lists and messages. */
function triggerLabel(trigger: string): string {
  return trigger === 'command' ? 'the `/auto-swe fix` command' : 'a review requesting changes';
}

/**
 * Review feedback on a pull request (`pull_request_review` submitted requesting changes, or
 * the `/auto-swe fix` command in a review body, an inline review comment, or a discussion
 * comment): start a template that addresses it — by default `address-pr-feedback`. Only for a
 * person who is an active platform user and a member of the repository (`actor`), and only on
 * pull requests the platform opened — unless an admin also allows acting on anybody's pull
 * request, and then only via the explicit command.
 */
export const prFeedbackSource: EventSource<PrFeedbackFilters, PrFeedbackFacts> = {
  actor: (x) => ({ id: x.senderId, login: x.senderLogin }),
  contract: PrFeedbackPayloadSchema,
  dedupeKey: (ownerKey, x) =>
    `${ownerKey}#pr-${x.prNumber}/${x.eventKind}-${x.eventId}`.toLowerCase(),
  defaultFilters: { pullRequests: ['platform'], triggers: [...PR_FEEDBACK_TRIGGERS] },
  defaultTemplate: { name: PR_FEEDBACK_TEMPLATE_NAME },
  describe: (f) =>
    `${f.triggers.map(triggerLabel).join(' or ')} on ${
      f.pullRequests.includes('others') ? 'any pull request' : 'platform pull requests'
    }`,
  describeInputs(given) {
    const v: Record<string, unknown> = { ...PR_FEEDBACK_DEFAULTS, ...given };
    const parts: string[] = [];
    if (typeof v.maxRounds === 'number') {
      parts.push(`up to ${v.maxRounds} rounds may push`);
    }
    if (v.maxCiFixAttempts === 0) {
      parts.push('does not fix the pushed commit’s CI');
    }
    return parts.join(' · ');
  },
  describeOccurrence(f) {
    const text = (k: string) =>
      typeof f[k] === 'string' || typeof f[k] === 'number' ? String(f[k]) : '?';
    return `PR #${text('prNumber')} · ${text('trigger')} by ${text('senderLogin')} · ${text('eventKind')} ${text('eventId')}`;
  },
  eventInputKeys: PR_FEEDBACK_EVENT_INPUT_KEYS,
  facts: PrFeedbackFactsSchema,
  filterFields: [
    {
      key: 'triggers',
      kind: 'choices',
      label: 'When',
      options: [
        { label: 'A review requests changes', value: 'changes_requested' },
        { label: 'The `/auto-swe fix` command', value: 'command' },
      ],
    },
    {
      hint: "Pull requests the platform opened always qualify. Anybody else's only ever via the command, and only where an admin allows it.",
      key: 'pullRequests',
      kind: 'choices',
      label: 'Pull requests',
      options: [
        { label: 'The platform opened', value: 'platform' },
        { label: 'Anybody’s', value: 'others' },
      ],
    },
  ],
  filters: PrFeedbackFiltersSchema,
  gatedFilters: [
    {
      disabledMessage:
        'Acting on pull requests the platform did not open is switched off (github.prFeedbackOtherPullRequestsEnabled)',
      key: 'pullRequests',
      setting: 'github.prFeedbackOtherPullRequestsEnabled',
      values: ['others'],
    },
  ],
  // A round can wait hours on a person's review; a delivery meanwhile is in flight.
  inFlightLookbackMs: 24 * 60 * 60 * 1000,
  key: PR_FEEDBACK,
  keys: (x) => ({
    scope: `pr-${x.prNumber}`,
    subject: `pr-${x.prNumber}@${x.eventKind}-${x.eventId}`,
  }),
  killSwitch: 'github.prFeedbackAutomationsEnabled',
  label: 'When pull request feedback arrives',
  mismatch(f, x) {
    if (!(f.triggers as readonly string[]).includes(x.trigger)) {
      return `it does not react to ${triggerLabel(x.trigger)}`;
    }
    if (x.origin === 'other') {
      if (!(f.pullRequests as readonly string[]).includes('others')) {
        return 'the pull request is not one the platform opened';
      }
      if (x.trigger === 'changes_requested') {
        return 'only the command acts on a pull request the platform did not open';
      }
    } else if (!(f.pullRequests as readonly string[]).includes('platform')) {
      return 'the pull request is one the platform opened';
    }
    return null;
  },
  run: (x) => ({
    description: [
      `Address review feedback on pull request #${x.prNumber}, ` +
        `${triggerLabel(x.trigger)} by ${x.senderLogin}: ${x.htmlUrl}`,
      x.notes,
    ]
      .filter((p) => p.trim().length > 0)
      .join('\n\n'),
    fields: {
      ...(x.headRef ? { baseBranch: x.headRef } : {}),
      feedbackEventId: x.eventId,
      feedbackEventKind: x.eventKind,
      feedbackOrigin: x.origin,
      feedbackTrigger: x.trigger,
      pullRequestNumber: x.prNumber,
    },
    ticketId: `prfb-${x.prNumber}-${x.eventId}`,
    ticketIsSynthetic: true,
  }),
  // Every shape of occurrence the filters can select: each trigger on each platform origin,
  // and — on a pull request the platform did not open — the command only.
  samples(f) {
    const base = {
      eventId: '1',
      eventKind: 'review' as const,
      headRef: 'auto/prfb-1-1',
      htmlUrl: 'https://github.com/acme/api/pull/1',
      notes: '',
      prNumber: 1,
      senderId: '1',
      senderLogin: 'octocat',
      submittedAt: '2026-01-01T00:00:00Z',
    };
    const out: PrFeedbackFacts[] = [];
    for (const trigger of f.triggers) {
      if (f.pullRequests.includes('platform')) {
        out.push({ ...base, origin: 'workflow', trigger });
        out.push({ ...base, origin: 'agent_run', trigger });
      }
      if (trigger === 'command' && f.pullRequests.includes('others')) {
        out.push({ ...base, origin: 'other', trigger });
      }
    }
    return out;
  },
  summary:
    'A review requests changes, or someone comments `/auto-swe fix`, on a pull request: address the feedback.',
  target: 'repository',
  templateCompatible(schema: InputSchema) {
    if (!('feedbackEventId' in schema.properties)) {
      return false;
    }
    const runFields: Record<string, unknown> = {
      baseBranch: 'auto/prfb-1-1',
      connectionId: '00000000-0000-4000-8000-000000000000',
      description: 'Address review feedback',
      feedbackEventId: '1',
      feedbackEventKind: 'review',
      feedbackOrigin: 'workflow',
      feedbackTrigger: 'changes_requested',
      pullRequestNumber: 1,
      ticketId: 'prfb-1-1',
    };
    return validateInputPayload(
      { ...schema, required: (schema.required ?? []).filter((k) => k in runFields) },
      runFields
    ).ok;
  },
  tester: {
    facts: (v) => ({
      eventId: '1',
      eventKind: 'review',
      headRef: 'auto/prfb-1-1',
      htmlUrl: 'https://github.com/acme/api/pull/1',
      notes: '',
      origin: (v.origin ?? 'workflow') as PrFeedbackFacts['origin'],
      prNumber: 1,
      senderId: '1',
      senderLogin: 'octocat',
      submittedAt: '2026-01-01T00:00:00Z',
      trigger: (v.trigger ?? 'changes_requested') as PrFeedbackFacts['trigger'],
    }),
    fields: [
      {
        initial: 'changes_requested',
        key: 'trigger',
        label: 'Trigger',
        options: [
          { label: 'Review requesting changes', value: 'changes_requested' },
          { label: 'The `/auto-swe fix` command', value: 'command' },
        ],
      },
      {
        initial: 'workflow',
        key: 'origin',
        label: 'Pull request opened by',
        options: [
          { label: 'A workflow run', value: 'workflow' },
          { label: 'An agent run', value: 'agent_run' },
          { label: 'Someone else', value: 'other' },
        ],
      },
    ],
  },
  workflowId: { part: (x) => `${x.prNumber}-${x.eventId}`, prefix: 'prfb' },
};
