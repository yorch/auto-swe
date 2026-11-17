/**
 * routeRunPlan — rank the templates a requester may launch for a stated goal.
 *
 * The gateway supplies the candidates, already filtered by launch authorization; the worker never
 * queries templates. The seeded `runPlanRouter` agent (cheap model, no tools, structured output)
 * returns ranked ids with reasons. Its output is INTERSECTED with the supplied ids, so a template
 * description that talks the model into naming some other id changes nothing: an unknown id is
 * dropped. What injected text can still do is reorder the supplied candidates, which is why the
 * user, not this activity, chooses between them. Names and descriptions are untrusted data and go to
 * the model delimited, with an instruction not to follow them. Reasons are plain text, capped.
 */

import { RUN_PLAN_INTENT_MAX_CHARS, wrapRunPlanIntent } from '@auto-swe/shared/workflow';
import { heartbeat } from '@temporalio/activity';
import { z } from 'zod';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import type { ModelBackedAgentKey } from '../lib/config/types.js';
import { ownerOfTeam, withSpendOwner } from '../lib/spendOwner.js';
import { runAgent } from './runAgent.js';

export interface RunPlanCandidate {
  id: string;
  name: string;
  description: string;
}

export interface RouteRunPlanInput {
  intent: string;
  /** The templates the requester may launch. The only ids the result can contain. */
  candidates: RunPlanCandidate[];
  maxResults: number;
  /** Scope of agent resolution and spend. */
  teamId?: string | null;
  orgId?: string | null;
}

export interface RunPlanMatch {
  templateId: string;
  /** Plain text, at most {@link ROUTE_REASON_MAX_CHARS} characters. */
  reason: string;
  /** 0 to 1. */
  score: number;
}

export interface RouteRunPlanResult {
  matches: RunPlanMatch[];
  /** True when nothing fits (or nothing could be matched to a supplied candidate). */
  noneFit: boolean;
}

export const ROUTE_REASON_MAX_CHARS = 200;
const MAX_CANDIDATES = 200;
const NAME_MAX_CHARS = 120;
const DESCRIPTION_MAX_CHARS = 300;
const MAX_RESULTS_CAP = 10;

const RouterOutputSchema = z.object({
  matches: z
    .array(
      z.object({
        reason: z.string().default(''),
        score: z.number().default(0),
        templateId: z.string(),
      })
    )
    .default([]),
  noneFit: z.boolean().default(false),
});
type RouterOutput = z.infer<typeof RouterOutputSchema>;

/** Plain text on one line: control characters, markup-looking tags and links removed. */
export function plainReason(text: string): string {
  const cleaned = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[`*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > ROUTE_REASON_MAX_CHARS
    ? `${cleaned.slice(0, ROUTE_REASON_MAX_CHARS - 1)}…`
    : cleaned;
}

function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const cut = t.length > max ? `${t.slice(0, max - 1)}…` : t;
  // A candidate must not be able to close the wrapper that holds it.
  return cut.replace(/<\s*\/?\s*(candidates?|requester_intent)\b[^>]*>/gi, '[tag removed]');
}

function renderCandidates(candidates: RunPlanCandidate[]): string {
  return [
    '<candidates>',
    ...candidates.map(
      (c) =>
        `<candidate id="${c.id}">\nname: ${oneLine(c.name, NAME_MAX_CHARS)}\ndescription: ${oneLine(c.description, DESCRIPTION_MAX_CHARS)}\n</candidate>`
    ),
    '</candidates>',
  ].join('\n');
}

export async function routeRunPlan(input: RouteRunPlanInput): Promise<RouteRunPlanResult> {
  return withSpendOwner(ownerOfTeam(input.teamId), () => routeRunPlanImpl(input));
}

async function routeRunPlanImpl(input: RouteRunPlanInput): Promise<RouteRunPlanResult> {
  const max = Math.max(1, Math.min(Math.trunc(input.maxResults) || 1, MAX_RESULTS_CAP));
  // Ids are the gateway's (uuids); a candidate with an id that could break the wrapper is dropped.
  const candidates = input.candidates
    .filter((c) => /^[A-Za-z0-9_-]{1,64}$/.test(c.id))
    .slice(0, MAX_CANDIDATES);
  if (candidates.length === 0 || input.intent.trim() === '') {
    return { matches: [], noneFit: true };
  }
  const known = new Set(candidates.map((c) => c.id));

  heartbeat('route run plan');
  const agentSpec = await resolveAgentSpec(
    { agentKey: 'runPlanRouter' as ModelBackedAgentKey, outputSchema: RouterOutputSchema },
    { orgId: input.orgId ?? undefined, teamId: input.teamId ?? undefined }
  );
  const result = await runAgent<RouterOutput>(
    agentSpec,
    [
      `Return at most ${max} matches.`,
      wrapRunPlanIntent(input.intent.slice(0, RUN_PLAN_INTENT_MAX_CHARS)),
      renderCandidates(candidates),
    ].join('\n\n'),
    { maxSteps: 1, spanName: 'llm.run_plan_router' }
  );

  const parsed = RouterOutputSchema.safeParse(result.object);
  if (!parsed.success) {
    // A router that did not answer in its schema ranks nothing; the user can still generate.
    return { matches: [], noneFit: true };
  }
  const seen = new Set<string>();
  const matches: RunPlanMatch[] = [];
  for (const m of parsed.data.matches) {
    if (!known.has(m.templateId) || seen.has(m.templateId)) {
      continue;
    }
    seen.add(m.templateId);
    matches.push({
      reason: plainReason(m.reason),
      score: Number.isFinite(m.score) ? Math.min(1, Math.max(0, m.score)) : 0,
      templateId: m.templateId,
    });
  }
  matches.sort((a, b) => b.score - a.score);
  const top = matches.slice(0, max);
  return { matches: top, noneFit: top.length === 0 || parsed.data.noneFit };
}
