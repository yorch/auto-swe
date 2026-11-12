import {
  type RepoOnboardingDraft,
  RepoOnboardingDraftSchema,
  renderOnboardingFiles,
} from '@auto-swe/shared/lib/onboardingPr';
import { z } from 'zod';
import {
  type DocReview,
  extractJsonObject,
  parseDocReview,
  parseTicketPlan,
  type ReviewComment,
  renderPlanMarkdown,
  renderReviewMarkdown,
  reviewToComments,
  type TicketPlan,
} from '../lib/documentReview.js';

export type ParseAgentOutputKind =
  | 'docReview'
  | 'ticketPlan'
  | 'incidentTriage'
  | 'incidentPostmortem'
  | 'repoOnboardingDraft';

export interface ParsedRepoOnboardingDraft {
  kind: 'repoOnboardingDraft';
  valid: true;
  draft: RepoOnboardingDraft;
  markdown: string;
}

function parseRepoOnboardingDraft(text: string): ParsedRepoOnboardingDraft | UnparsedAgentOutput {
  const invalid = (error: string): UnparsedAgentOutput => ({
    error,
    kind: 'repoOnboardingDraft',
    markdown: error,
    valid: false,
  });
  const blocks = [
    ...text.matchAll(/^ {0,3}```json[^\S\r\n]*\r?\n([\s\S]*?)^ {0,3}```[^\S\r\n]*\r?$/gim),
  ];
  const block = blocks.at(-1)?.[1];
  if (block === undefined) {
    return invalid('The onboarding agent did not return a fenced JSON block.');
  }
  let json: unknown;
  try {
    json = JSON.parse(block);
  } catch {
    return invalid('The onboarding agent returned invalid JSON in its last JSON block.');
  }
  const parsed = RepoOnboardingDraftSchema.safeParse(json);
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'draft'))];
    return invalid(`The onboarding draft has invalid fields: ${paths.join(', ')}.`);
  }
  const draft = parsed.data;
  let files: ReturnType<typeof renderOnboardingFiles>;
  try {
    files = renderOnboardingFiles({
      files: [
        { kind: 'setup', setup: draft.setup },
        { gateCommands: draft.gateCommands, kind: 'gates' },
        ...(draft.previewConfig
          ? [{ kind: 'preview' as const, previewConfig: draft.previewConfig }]
          : []),
      ],
    });
  } catch {
    return invalid(
      'The onboarding draft cannot be rendered as valid repository configuration files.'
    );
  }
  const markdown = [
    '## Repository onboarding draft',
    '',
    ...files.flatMap((file) => {
      const longest = Math.max(
        2,
        ...[...file.content.matchAll(/`+/g)].map((match) => match[0].length)
      );
      const fence = '`'.repeat(longest + 1);
      return [`### ${file.path}`, '', `${fence}yaml`, file.content.trimEnd(), fence, ''];
    }),
    ...(draft.notes ? ['### Notes', '', draft.notes] : []),
  ].join('\n');
  return { draft, kind: 'repoOnboardingDraft', markdown, valid: true };
}

export interface ParseAgentOutputInput {
  kind: ParseAgentOutputKind;
  /** The agent's reply: `nodes.<id>.output.text`. Anything that is not text is invalid output. */
  text: unknown;
}

export interface ParsedDocReview {
  kind: 'docReview';
  valid: true;
  ready: boolean;
  summary: string;
  findingCount: number;
  blockingCount: number;
  comments: ReviewComment[];
  markdown: string;
  review: DocReview;
}

export interface ParsedTicketPlan {
  kind: 'ticketPlan';
  valid: true;
  plan: TicketPlan;
  ticketCount: number;
  subtaskCount: number;
  markdown: string;
}

/** The incident triager's reply: see `INCIDENT_TRIAGER_PROMPT`. */
export const IncidentTriageSchema = z.object({
  category: z.enum([
    'code',
    'configuration',
    'dependency',
    'infrastructure',
    'external',
    'unknown',
  ]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().max(2000)).max(20).default([]),
  fixable: z.boolean(),
  rootCause: z.string().max(4000),
  suggestedFix: z.string().max(4000).default(''),
  summary: z.string().min(1).max(2000),
});

export type IncidentTriage = z.infer<typeof IncidentTriageSchema>;

/** Longest raw reply carried as `markdown` when the triager's reply does not parse. */
const MAX_UNPARSED_TRIAGE_CHARS = 8000;

export interface ParsedIncidentTriage {
  kind: 'incidentTriage';
  valid: true;
  /** The diagnosis as the implementer's task reads it, when a fix is attempted. */
  brief: string;
  confidence: number;
  /** Only a code-category diagnosis is fixable, whatever the model said. */
  fixable: boolean;
  markdown: string;
  summary: string;
  triage: IncidentTriage;
}

export function renderIncidentTriageMarkdown(t: IncidentTriage): string {
  const lines = [
    `auto-swe incident triage (${t.category}, confidence ${Math.round(t.confidence * 100)}%)`,
    '',
    t.summary,
    '',
    `Root cause: ${t.rootCause}`,
  ];
  if (t.evidence.length > 0) {
    lines.push('', 'Evidence:', ...t.evidence.map((e) => `- ${e}`));
  }
  if (t.suggestedFix) {
    lines.push('', `Suggested fix: ${t.suggestedFix}`);
  }
  return lines.join('\n');
}

function parseIncidentTriage(text: string): ParsedIncidentTriage | UnparsedAgentOutput {
  const json = extractJsonObject(text);
  const parsed = json === undefined ? null : IncidentTriageSchema.safeParse(json);
  if (!parsed?.success) {
    const error =
      json === undefined
        ? 'The incident triager did not return a JSON object.'
        : 'The incident triager returned JSON that does not match the triage shape.';
    // Still worth posting: the responders read it, and the run routes it away from a fix.
    const reply = text.trim().slice(0, MAX_UNPARSED_TRIAGE_CHARS);
    return {
      error,
      kind: 'incidentTriage',
      markdown: reply ? `auto-swe incident triage (unstructured)\n\n${reply}` : error,
      valid: false,
    };
  }
  const triage = parsed.data;
  const markdown = renderIncidentTriageMarkdown(triage);
  return {
    brief: markdown,
    confidence: triage.confidence,
    fixable: triage.fixable && triage.category === 'code',
    kind: 'incidentTriage',
    markdown,
    summary: triage.summary,
    triage,
    valid: true,
  };
}

/** The postmortem writer's reply: see `INCIDENT_POSTMORTEM_WRITER_PROMPT`. */
export const IncidentPostmortemSchema = z.object({
  followUps: z.array(z.string().min(1).max(1000)).max(20).default([]),
  impact: z.string().max(4000),
  resolution: z.string().max(4000).default(''),
  rootCause: z.string().max(4000),
  summary: z.string().min(1).max(2000),
  timeline: z
    .array(z.object({ at: z.string().max(100).default(''), event: z.string().min(1).max(1000) }))
    .max(40)
    .default([]),
  title: z.string().trim().min(1).max(200),
});

export type IncidentPostmortem = z.infer<typeof IncidentPostmortemSchema>;

export interface ParsedIncidentPostmortem {
  kind: 'incidentPostmortem';
  valid: true;
  markdown: string;
  postmortem: IncidentPostmortem;
  summary: string;
  title: string;
}

/** Plain text: PagerDuty shows a note as written, and Confluence takes it paragraph by paragraph. */
export function renderIncidentPostmortem(p: IncidentPostmortem): string {
  const section = (heading: string, body: string) => (body.trim() ? ['', heading, body] : []);
  const list = (heading: string, items: string[]) =>
    items.length > 0 ? ['', heading, ...items.map((i) => `- ${i}`)] : [];
  return [
    `auto-swe postmortem draft: ${p.title}`,
    '',
    p.summary,
    ...section('Impact', p.impact),
    ...list(
      'Timeline',
      p.timeline.map((t) => (t.at ? `${t.at}: ${t.event}` : t.event))
    ),
    ...section('Root cause', p.rootCause),
    ...section('Resolution', p.resolution),
    ...list('Follow-up actions', p.followUps),
  ].join('\n');
}

function parseIncidentPostmortem(text: string): ParsedIncidentPostmortem | UnparsedAgentOutput {
  const json = extractJsonObject(text);
  const parsed = json === undefined ? null : IncidentPostmortemSchema.safeParse(json);
  if (!parsed?.success) {
    const error =
      json === undefined
        ? 'The postmortem writer did not return a JSON object.'
        : 'The postmortem writer returned JSON that does not match the postmortem shape.';
    // Posted as the note all the same, marked unstructured; the run publishes no page from it.
    const reply = text.trim().slice(0, MAX_UNPARSED_TRIAGE_CHARS);
    return {
      error,
      kind: 'incidentPostmortem',
      markdown: reply ? `auto-swe postmortem draft (unstructured)\n\n${reply}` : error,
      valid: false,
    };
  }
  const postmortem = parsed.data;
  return {
    kind: 'incidentPostmortem',
    markdown: renderIncidentPostmortem(postmortem),
    postmortem,
    summary: postmortem.summary,
    title: postmortem.title,
    valid: true,
  };
}

export interface UnparsedAgentOutput {
  kind: ParseAgentOutputKind;
  valid: false;
  /** A fixed string, never the model's text. */
  error: string;
  markdown: string;
}

export type ParseAgentOutputResult =
  | ParsedDocReview
  | ParsedTicketPlan
  | ParsedIncidentTriage
  | ParsedIncidentPostmortem
  | ParsedRepoOnboardingDraft
  | UnparsedAgentOutput;

/**
 * Turn a document-review agent's JSON reply into a checked value and the text a person reviews.
 *
 * Deterministic and side-effect free, and an activity only because a workflow cannot parse: the
 * template branches on `valid`, so a malformed reply goes to a person rather than into a write.
 * It never throws on bad model output.
 */
export async function parseAgentOutput(
  input: ParseAgentOutputInput
): Promise<ParseAgentOutputResult> {
  const text = typeof input.text === 'string' ? input.text : '';
  if (input.kind === 'repoOnboardingDraft') {
    return parseRepoOnboardingDraft(text);
  }
  if (input.kind === 'incidentTriage') {
    return parseIncidentTriage(text);
  }
  if (input.kind === 'incidentPostmortem') {
    return parseIncidentPostmortem(text);
  }
  if (input.kind === 'docReview') {
    const parsed = parseDocReview(text);
    if (!parsed.ok) {
      return { error: parsed.error, kind: 'docReview', markdown: parsed.error, valid: false };
    }
    const review = parsed.value;
    return {
      blockingCount: review.findings.filter(
        (f) => f.severity === 'blocker' || f.severity === 'major'
      ).length,
      comments: reviewToComments(review),
      findingCount: review.findings.length,
      kind: 'docReview',
      markdown: renderReviewMarkdown(review),
      ready: review.ready,
      review,
      summary: review.summary,
      valid: true,
    };
  }
  const parsed = parseTicketPlan(text);
  if (!parsed.ok) {
    return { error: parsed.error, kind: 'ticketPlan', markdown: parsed.error, valid: false };
  }
  const plan = parsed.value;
  return {
    kind: 'ticketPlan',
    markdown: renderPlanMarkdown(plan),
    plan,
    subtaskCount: plan.tickets.reduce((n, t) => n + t.subtasks.length, 0),
    ticketCount: plan.tickets.length,
    valid: true,
  };
}
