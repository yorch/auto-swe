import { resolveSettings } from '@auto-swe/shared/config';
import {
  CONVENTIONAL_COMMIT_TYPES,
  type ConventionalCommitType,
  formatConventionalTitle,
  isConventionalCommitType,
  isPrTitleFormat,
  type PrTitleFormat,
} from '@auto-swe/shared/lib/prTitle';
import { z } from 'zod';
import { logWarn } from '../lib/activityLog.js';
import type { AgentTracer } from '../lib/agentTracer.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import type { ModelBackedAgentKey, ResolveCtx } from '../lib/config/types.js';
import { runAgent } from './runAgent.js';

/**
 * The title of a pull request the platform opens. A repository's own format and template win;
 * otherwise the setting registry's cascade (workflow template, team, organization, global) decides,
 * and the Workflow defaults template is the last resort for the template itself.
 *
 * In `conventional` format the title is `type: summary`. A fixed `workflow.prTitleType` skips the
 * model: the summary is the first line of the request. With the type on `auto`, the `prTitler`
 * agent chooses both from the request and the files changed. The agent is best-effort — a missing
 * credential, a refusal or a malformed answer degrades to the fixed fallback type and the request's
 * first line, because a run must never fail over its title.
 */

const AGENT_KEY = 'prTitler';

/** Longest request text and number of files the titler is shown. */
const TITLER_REQUEST_CHARS = 2000;
const TITLER_MAX_FILES = 50;

const PrTitlerSchema = z.object({
  summary: z.string(),
  type: z.enum(CONVENTIONAL_COMMIT_TYPES),
});

export interface PrTitlePolicy {
  format: PrTitleFormat;
  /** The template for `template` format, from the repository, the registry or the defaults. */
  template: string;
  /** True when the repository or the registry named the template, false for the global defaults. */
  templateExplicit: boolean;
  /** A fixed type, or `auto` to let the titler choose. */
  type: ConventionalCommitType | 'auto';
}

export async function resolvePrTitlePolicy(
  repo: { prTitleFormat: string | null; prTitleTemplate: string | null },
  ctx: ResolveCtx,
  defaultsTemplate: string
): Promise<PrTitlePolicy> {
  const settings = await resolveSettings(
    ['workflow.prTitleFormat', 'workflow.prTitleTemplate', 'workflow.prTitleType'],
    ctx
  );
  const repoTemplate = repo.prTitleTemplate?.trim() ?? '';
  const template = repoTemplate || settings['workflow.prTitleTemplate'];
  // The registry types its enums as plain strings, and a stored value that fails its schema has
  // already degraded to the default, so the guards narrow rather than decide.
  const registryFormat = settings['workflow.prTitleFormat'];
  const registryType = settings['workflow.prTitleType'];
  return {
    // A column the CHECK would refuse, or a stale value, degrades to the registry's.
    format: isPrTitleFormat(repo.prTitleFormat)
      ? repo.prTitleFormat
      : isPrTitleFormat(registryFormat)
        ? registryFormat
        : 'template',
    template: template || defaultsTemplate,
    templateExplicit: template !== '',
    type: isConventionalCommitType(registryType) ? registryType : 'auto',
  };
}

export interface ResolvePrTitleInput {
  /** The request's own words: the ticket description, or an agent run's prompt. */
  description: string;
  /** The correlation id, the last fallback for a summary. */
  ticketId: string;
  files: ReadonlyArray<{ operation: string; path: string }>;
  repo: { prTitleFormat: string | null; prTitleTemplate: string | null };
  ctx: ResolveCtx;
  /**
   * Scope the `prTitler` agent resolves at, when it must be narrower than `ctx`: an agent run
   * resolves its agents at global and organization scope only, never the owning team's.
   */
  agentCtx?: ResolveCtx;
  /** The Workflow defaults template, used when neither the repository nor the registry set one. */
  defaultsTemplate: string;
  /** Expands a template for this request; the two PR paths substitute different values. */
  renderTemplate: (template: string) => string;
  /**
   * The title used in `template` format when no template was set below the global defaults. An
   * agent run passes its own descriptive title here; the workflow path leaves it out and always
   * renders the template.
   */
  legacyTitle?: string;
  tracer: AgentTracer;
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  );
}

async function chooseType(
  input: ResolvePrTitleInput
): Promise<{ summary: string; type: ConventionalCommitType } | null> {
  const started = Date.now();
  try {
    const agentCtx = input.agentCtx ?? input.ctx;
    const spec = await resolveAgentSpec(
      { agentKey: AGENT_KEY as ModelBackedAgentKey, outputSchema: PrTitlerSchema },
      agentCtx
    );
    const files = input.files
      .slice(0, TITLER_MAX_FILES)
      .map((f) => `${f.operation} ${f.path}`)
      .join('\n');
    const request = input.description.slice(0, TITLER_REQUEST_CHARS);
    const result = await runAgent<z.infer<typeof PrTitlerSchema>>(
      spec,
      `<request>\n${request}\n</request>\n<files>\n${files}\n</files>`,
      { ctx: agentCtx, maxSteps: 1, spanName: 'llm.pr_title', tracer: input.tracer }
    );
    const parsed = PrTitlerSchema.safeParse(result.object);
    if (!parsed.success) {
      throw new Error('the title did not match its schema');
    }
    return parsed.data;
  } catch (err) {
    logWarn('[prTitle] the titler could not classify the change; using the fallback type', {
      durationMs: Date.now() - started,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function resolvePrTitle(input: ResolvePrTitleInput): Promise<string> {
  const policy = await resolvePrTitlePolicy(input.repo, input.ctx, input.defaultsTemplate);
  if (policy.format === 'template') {
    const title =
      input.legacyTitle !== undefined && !policy.templateExplicit
        ? input.legacyTitle
        : input.renderTemplate(policy.template);
    input.tracer.addActivityEvent({
      name: 'pr.title',
      outputJson: { format: 'template', templateExplicit: policy.templateExplicit },
    });
    return title;
  }

  const chosen = policy.type === 'auto' ? await chooseType(input) : null;
  const fallbackSummary = firstLine(input.description) || input.ticketId;
  const title = formatConventionalTitle({
    fallbackSummary,
    summary: chosen?.summary ?? fallbackSummary,
    type: policy.type === 'auto' ? chosen?.type : policy.type,
  });
  input.tracer.addActivityEvent({
    name: 'pr.title',
    outputJson: {
      classified: chosen !== null,
      format: 'conventional',
      type: policy.type,
    },
  });
  return title;
}
