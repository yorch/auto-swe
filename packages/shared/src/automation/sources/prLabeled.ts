import { z } from 'zod';
import { type InputSchema, validateInputPayload } from '../../lib/inputSchema.js';
import type { EventSource } from '../types.js';
import { visibleIssueText } from './issueLabeled.js';

/** The source key stored on an automation that reacts to a label added to a pull request. */
export const PR_LABELED = 'github.pull_request.labeled';

/** The built-in template a pull-request label automation starts by default (`TICKET_TO_MERGE_SPEC`). */
const TICKET_TO_MERGE = 'ticket-to-merge';
/** Pull-request text carried into the run's description, and kept in the ledger for a retry. */
const MAX_BODY_CHARS = 4_000;
const MAX_TITLE_CHARS = 256;

const LabelSchema = z.string().trim().min(1).max(50);

export const PrLabeledFiltersSchema = z.object({
  /** Label names, compared without case as GitHub does. Required: none means nothing. */
  labels: z
    .array(LabelSchema)
    .min(1)
    .max(20)
    .transform((labels) => [...new Set(labels.map((l) => l.toLowerCase()))]),
});
export type PrLabeledFilters = z.infer<typeof PrLabeledFiltersSchema>;

/** A label added to an open pull request, from the signed webhook alone. */
export const PrLabeledFactsSchema = z.object({
  baseRef: z.string().min(1).max(250),
  body: z.string().max(MAX_BODY_CHARS),
  headRef: z.string().min(1).max(250),
  headSha: z.string().min(1).max(64),
  htmlUrl: z.string().max(500),
  label: LabelSchema,
  prNumber: z.number().int().positive(),
  /** Who added the label: GitHub's numeric account id and login. */
  senderId: z.string().regex(/^\d{1,20}$/),
  senderLogin: z.string().min(1).max(100),
  title: z.string().max(MAX_TITLE_CHARS),
  /** The pull request's `updated_at` as of the label: each labelling is its own occurrence. */
  updatedAt: z.string().min(1).max(40),
});
export type PrLabeledFacts = z.infer<typeof PrLabeledFactsSchema>;

/** A short, stable, dependency-free hash (FNV-1a), for ids that must not carry raw text. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** One labelling: the pull request, the label and the moment. */
function occurrence(x: PrLabeledFacts): string {
  return shortHash(`${x.label.toLowerCase()}@${x.updatedAt}`);
}

/**
 * A label added to an open pull request from this repository (never a fork): start a template
 * on it — by default `ticket-to-merge`. Only for a person who is an active platform user and a
 * member of the repository (`actor`). The title and body are untrusted text written by whoever
 * opened the pull request.
 */
export const prLabeledSource: EventSource<PrLabeledFilters, PrLabeledFacts> = {
  actor: (x) => ({ id: x.senderId, login: x.senderLogin }),
  dedupeKey: (ownerKey, x) =>
    `${ownerKey}#prlabel-${x.prNumber}/${x.label}/${x.updatedAt}`.toLowerCase(),
  defaultFilters: { labels: ['auto-swe'] },
  defaultTemplate: { name: TICKET_TO_MERGE },
  describe: (f) => `labelled ${f.labels.join(' or ')}`,
  describeOccurrence(f) {
    const text = (k: string) =>
      typeof f[k] === 'string' || typeof f[k] === 'number' ? String(f[k]) : '?';
    return `#${text('prNumber')} ${text('title').slice(0, 80)} · labelled ${text('label')} by ${text('senderLogin')}`;
  },
  eventInputKeys: [],
  facts: PrLabeledFactsSchema,
  filterFields: [
    {
      hint: 'Label names, comma-separated, compared without case. Adding any of them to an open pull request starts the template.',
      key: 'labels',
      kind: 'list',
      label: 'Labels',
    },
  ],
  filters: PrLabeledFiltersSchema,
  // A run can wait days for review and merge; a labelling meanwhile is in flight.
  inFlightLookbackMs: 14 * 24 * 60 * 60 * 1000,
  key: PR_LABELED,
  // One labelling is the subject, so labelling again later starts again; the pull request is the
  // scope, so a second labelling while a run is open is in flight.
  keys: (x) => ({
    scope: `prlabel-${x.prNumber}`,
    subject: `prlabel-${x.prNumber}@${occurrence(x)}`,
  }),
  killSwitch: 'github.prLabelAutomationsEnabled',
  label: 'When a pull request is labelled',
  mismatch: (f, x) =>
    f.labels.includes(x.label.toLowerCase())
      ? null
      : `the label '${x.label}' is not one of ${f.labels.join(', ')}`,
  run: (x) => ({
    description: [
      visibleIssueText(x.title),
      visibleIssueText(x.body),
      `GitHub pull request #${x.prNumber} (${x.headRef} into ${x.baseRef}), labelled ${x.label} by ${x.senderLogin}: ${x.htmlUrl}`,
    ]
      .filter((p) => p.trim().length > 0)
      .join('\n\n'),
    fields: {},
    ticketId: `prlabel-${x.prNumber}-${occurrence(x).slice(0, 6)}`,
    ticketIsSynthetic: true,
  }),
  samples: (f) => [
    {
      baseRef: 'main',
      body: '',
      headRef: 'feature/health',
      headSha: 'abc1234',
      htmlUrl: 'https://github.com/acme/api/pull/1',
      label: f.labels[0] ?? 'auto-swe',
      prNumber: 1,
      senderId: '1',
      senderLogin: 'octocat',
      title: 'Add a health check',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ],
  summary: 'A label is added to an open pull request: start a template on it.',
  target: 'repository',
  templateCompatible(schema: InputSchema) {
    const runFields: Record<string, unknown> = {
      connectionId: '00000000-0000-4000-8000-000000000000',
      description: 'Add a health check',
      ticketId: 'prlabel-1-abcdef',
    };
    if (!Object.keys(runFields).every((k) => k in schema.properties)) {
      return false;
    }
    return validateInputPayload(
      { ...schema, required: (schema.required ?? []).filter((k) => k in runFields) },
      runFields
    ).ok;
  },
  tester: {
    facts: (v) => ({
      baseRef: 'main',
      body: '',
      headRef: 'feature/health',
      headSha: 'abc1234',
      htmlUrl: 'https://github.com/acme/api/pull/1',
      label: (v.label ?? '').trim() || 'auto-swe',
      prNumber: 1,
      senderId: '1',
      senderLogin: 'octocat',
      title: 'Add a health check',
      updatedAt: '2026-01-01T00:00:00Z',
    }),
    fields: [{ initial: 'auto-swe', key: 'label', label: 'Label added' }],
  },
  workflowId: { part: (x) => `${x.prNumber}-${occurrence(x)}`, prefix: 'prlabel' },
};
