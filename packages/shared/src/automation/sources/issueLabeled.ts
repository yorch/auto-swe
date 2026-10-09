import { z } from 'zod';
import { type InputSchema, validateInputPayload } from '../../lib/inputSchema.js';
import type { EventSource } from '../types.js';

/** The source key stored on an automation that reacts to a label added to an issue. */
export const ISSUE_LABELED = 'github.issues.labeled';

/** The built-in template an issue automation starts by default (`DEFAULT_ENGINEERING_SPEC`). */
const DEFAULT_ENGINEERING = 'default-engineering';
/** Issue text carried into the run's description, and kept in the ledger for a retry. */
const MAX_BODY_CHARS = 4_000;
const MAX_TITLE_CHARS = 256;

const LabelSchema = z.string().trim().min(1).max(50);

export const IssueLabeledFiltersSchema = z.object({
  /** Label names, compared without case as GitHub does. Required: none means nothing. */
  labels: z
    .array(LabelSchema)
    .min(1)
    .max(20)
    .transform((labels) => [...new Set(labels.map((l) => l.toLowerCase()))]),
});
export type IssueLabeledFilters = z.infer<typeof IssueLabeledFiltersSchema>;

/** A label added to an open issue, from the signed webhook alone. */
export const IssueLabeledFactsSchema = z.object({
  body: z.string().max(MAX_BODY_CHARS),
  htmlUrl: z.string().max(500),
  issueNumber: z.number().int().positive(),
  label: LabelSchema,
  /** Who added the label: GitHub's numeric account id and login. */
  senderId: z.string().regex(/^\d{1,20}$/),
  senderLogin: z.string().min(1).max(100),
  title: z.string().max(MAX_TITLE_CHARS),
  /** The issue's `updated_at` as of the label: each labelling is its own occurrence. */
  updatedAt: z.string().min(1).max(40),
});
export type IssueLabeledFacts = z.infer<typeof IssueLabeledFactsSchema>;

/**
 * Issue text as GitHub shows it: HTML comments (`<!-- … -->`, an unterminated one to the end)
 * are not rendered, so a member who read the issue before labelling it never saw them, and
 * neither does the run.
 */
export function visibleIssueText(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
}

/** A short, stable, dependency-free hash (FNV-1a), for ids that must not carry raw text. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** One labelling: the issue, the label and the moment. */
function occurrence(x: IssueLabeledFacts): string {
  return shortHash(`${x.label.toLowerCase()}@${x.updatedAt}`);
}

/**
 * A label added to an open issue: start a template on it — by default the engineering template,
 * which implements the issue and opens a pull request. Only for a person who is an active
 * platform user and a member of the repository (`actor`): issue forms add labels on behalf of
 * whoever opens the issue, so the label alone says nothing about who asked.
 */
export const issueLabeledSource: EventSource<IssueLabeledFilters, IssueLabeledFacts> = {
  actor: (x) => ({ id: x.senderId, login: x.senderLogin }),
  dedupeKey: (repoKey, x) =>
    `${repoKey}#issue-${x.issueNumber}/${x.label}/${x.updatedAt}`.toLowerCase(),
  defaultFilters: { labels: ['auto-swe'] },
  defaultTemplate: { name: DEFAULT_ENGINEERING },
  describe: (f) => `labelled ${f.labels.join(' or ')}`,
  describeOccurrence(f) {
    const text = (k: string) =>
      typeof f[k] === 'string' || typeof f[k] === 'number' ? String(f[k]) : '?';
    return `#${text('issueNumber')} ${text('title').slice(0, 80)} · labelled ${text('label')} by ${text('senderLogin')}`;
  },
  eventInputKeys: [],
  facts: IssueLabeledFactsSchema,
  filterFields: [
    {
      hint: 'Label names, comma-separated, compared without case. Adding any of them to an open issue starts the template.',
      key: 'labels',
      kind: 'list',
      label: 'Labels',
    },
  ],
  filters: IssueLabeledFiltersSchema,
  // A run can wait days for review and merge; a labelling meanwhile is in flight.
  inFlightLookbackMs: 14 * 24 * 60 * 60 * 1000,
  key: ISSUE_LABELED,
  // One labelling is the subject, so labelling again later starts again; the issue is the
  // scope, so a second labelling while a run is open is in flight.
  keys: (x) => ({
    scope: `issue-${x.issueNumber}`,
    subject: `issue-${x.issueNumber}@${occurrence(x)}`,
  }),
  killSwitch: 'github.issueLabelAutomationsEnabled',
  label: 'When an issue is labelled',
  mismatch: (f, x) =>
    f.labels.includes(x.label.toLowerCase())
      ? null
      : `the label '${x.label}' is not one of ${f.labels.join(', ')}`,
  run: (x) => ({
    description: [
      visibleIssueText(x.title),
      visibleIssueText(x.body),
      `GitHub issue #${x.issueNumber}, labelled ${x.label} by ${x.senderLogin}: ${x.htmlUrl}`,
    ]
      .filter((p) => p.trim().length > 0)
      .join('\n\n'),
    fields: {},
    ticketId: `issue-${x.issueNumber}-${occurrence(x).slice(0, 6)}`,
    ticketIsSynthetic: true,
  }),
  samples: (f) => [
    {
      body: '',
      htmlUrl: 'https://github.com/acme/api/issues/1',
      issueNumber: 1,
      label: f.labels[0] ?? 'auto-swe',
      senderId: '1',
      senderLogin: 'octocat',
      title: 'Add a health check',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ],
  summary: 'A label is added to an open issue: implement it and open a pull request.',
  templateCompatible(schema: InputSchema) {
    const runFields: Record<string, unknown> = {
      connectionId: '00000000-0000-4000-8000-000000000000',
      description: 'Add a health check',
      ticketId: 'issue-1-abcdef',
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
      body: '',
      htmlUrl: 'https://github.com/acme/api/issues/1',
      issueNumber: 1,
      label: (v.label ?? '').trim() || 'auto-swe',
      senderId: '1',
      senderLogin: 'octocat',
      title: 'Add a health check',
      updatedAt: '2026-01-01T00:00:00Z',
    }),
    fields: [{ initial: 'auto-swe', key: 'label', label: 'Label added' }],
  },
  workflowId: { part: (x) => `${x.issueNumber}-${occurrence(x)}`, prefix: 'issue' },
};
