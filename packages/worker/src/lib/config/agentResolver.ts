import { createHash } from 'node:crypto';
import { configCacheTtlMs, invalidate, withCache } from '@auto-swe/shared/config/cache';
import { prisma } from '@auto-swe/shared/db';
import { parseProviderModelSpec } from '@auto-swe/shared/lib/modelSpec';
import { asyncLocalStorage } from '@temporalio/activity';
import { persistActivityTrace } from '../activityContext.js';
import { logWarn } from '../activityLog.js';
import { AgentTracer } from '../agentTracer.js';
import { ConfigMissingError, resolveProviderCredential } from './resolver.js';
import { parseToolKeys } from './toolKeys.js';
import type { ResolveCtx, ResolvedModelConfig, ResolvedSkill } from './types.js';

/**
 * The effective configuration of an Agent, resolved from the first-class `Agent`
 * entity — the single source of truth (P1.5). Shape matches the raw pieces
 * `resolveAgentSpec` composes: a resolved model (spec + credential + optional
 * base prompt override), ordered skills, and the enabled tool keys (`null` = no
 * override → all candidate tools).
 */
export interface ResolvedAgent {
  key: string;
  version: number;
  isVerified: boolean;
  origin: string | null;
  model: ResolvedModelConfig;
  skills: ResolvedSkill[];
  toolKeys: string[] | null;
  /** P2/WS3: the `mcp` Connection whose tools to bind when `toolKeys` includes 'mcp'. */
  mcpConnectionId: string | null;
}

export type AgentRow = NonNullable<Awaited<ReturnType<typeof fetchActiveAgent>>>;

/**
 * Most-specific active Agent row for `key`: WORKFLOW_TEMPLATE → CHANNEL → TEAM →
 * ORGANIZATION → GLOBAL, highest `version` at the first scope that has a row.
 * Returns null when no Agent row exists for the key. The CHANNEL tier only fires
 * when `ctx.channelId` is set, and the ORGANIZATION tier only when `ctx.orgId` is
 * present, so existing TEAM/GLOBAL behavior is intact.
 *
 * When the run carries a version pin for `key` (`ctx.agentVersions`), the pin
 * applies to the GLOBAL row only: it was snapshotted from the GLOBAL lineage at
 * run start (`createWorkflowRun`), and a version number is meaningless across
 * lineages — TEAM v1 is not "older" than GLOBAL v2. Applying it at every tier
 * silently defeated every scoped override whose version happened to differ. So
 * a scoped override still wins and resolves its latest active version; a run
 * that falls through to GLOBAL is frozen at the pinned version.
 *
 * Exported so the skill/tool shims can read an Agent row without forcing model
 * + credential resolution.
 */
export async function fetchActiveAgent(key: string, ctx?: ResolveCtx) {
  const include = {
    skillRefs: {
      include: { skill: { include: { source: { select: { owner: true, repo: true } } } } },
      orderBy: { sortOrder: 'asc' as const },
    },
  };
  const pinnedVersion = ctx?.agentVersions?.[key];
  const versionClause = pinnedVersion !== undefined ? { version: pinnedVersion } : {};
  const orderBy = { version: 'desc' as const };

  if (ctx?.workflowTemplateId) {
    const row = await prisma.agent.findFirst({
      include,
      orderBy,
      where: {
        isActive: true,
        key,
        scope: 'WORKFLOW_TEMPLATE',
        workflowTemplateId: ctx.workflowTemplateId,
      },
    });
    if (row) {
      return row;
    }
  }

  if (ctx?.channelId) {
    const row = await prisma.agent.findFirst({
      include,
      orderBy,
      where: { channelId: ctx.channelId, isActive: true, key, scope: 'CHANNEL' },
    });
    if (row) {
      return row;
    }
  }

  if (ctx?.teamId) {
    const row = await prisma.agent.findFirst({
      include,
      orderBy,
      where: { isActive: true, key, scope: 'TEAM', teamId: ctx.teamId },
    });
    if (row) {
      return row;
    }
  }

  if (ctx?.orgId) {
    const row = await prisma.agent.findFirst({
      include,
      orderBy,
      where: { isActive: true, key, orgId: ctx.orgId, scope: 'ORGANIZATION' },
    });
    if (row) {
      return row;
    }
  }

  return prisma.agent.findFirst({
    include,
    orderBy,
    where: { isActive: true, key, scope: 'GLOBAL', ...versionClause },
  });
}

/**
 * Map an Agent row's skillRefs to ResolvedSkills (ordered by sortOrder).
 *
 * A run that pinned a skill revision at start (`ctx.skillRevisions`) reads that
 * revision's text and description, so editing the skill mid-run changes nothing
 * the run sees — across retries and replays too. A skill with no pin, or no
 * ctx, resolves its current revision. `isActive` is read live on purpose: it is
 * the admin's off-switch for a skill that turns out to be harmful, and a run
 * already under way should honour it. `isVerified` describes the current text,
 * so a pinned older revision never reports as verified.
 *
 * A pin whose revision row is missing (a skill that pre-dates revisions)
 * falls back to the live text rather than failing the run.
 */
export async function skillsFromAgent(agent: AgentRow, ctx?: ResolveCtx): Promise<ResolvedSkill[]> {
  const refs = agent.skillRefs.filter((ref) => ref.skill.isActive);
  const stale = refs.filter((ref) => {
    const pinned = ctx?.skillRevisions?.[ref.skill.id];
    return pinned !== undefined && pinned !== ref.skill.currentRevision;
  });
  const pinnedRows =
    stale.length > 0
      ? await prisma.skillRevision.findMany({
          select: { description: true, promptText: true, revision: true, skillId: true },
          where: {
            OR: stale.map((ref) => ({
              revision: ctx?.skillRevisions?.[ref.skill.id] as number,
              skillId: ref.skill.id,
            })),
          },
        })
      : [];
  const pinnedBySkill = new Map(pinnedRows.map((r) => [r.skillId, r]));
  const missing = stale
    .filter((ref) => !pinnedBySkill.has(ref.skill.id))
    .map((ref) => ({
      currentRevision: ref.skill.currentRevision,
      pinnedRevision: ctx?.skillRevisions?.[ref.skill.id] as number,
      skillId: ref.skill.id,
    }));
  if (missing.length > 0) {
    await reportMissingPinnedRevisions(missing);
  }

  const provenance = await skillProvenance(refs, ctx);

  return refs.map((ref) => {
    const pinned = pinnedBySkill.get(ref.skill.id);
    return {
      description: (pinned ? pinned.description : ref.skill.description) ?? '',
      id: ref.skill.id,
      isVerified: ref.skill.isVerified && !pinned,
      name: ref.skill.name,
      promptText: pinned ? pinned.promptText : ref.skill.promptText,
      provenance: provenance.get(ref.skill.id),
      sortOrder: ref.sortOrder,
    };
  });
}

/**
 * `external: owner/repo@sha7` for each skill whose revision-in-use was imported
 * from a git source, so the skill menu tells the agent (and anyone reading the
 * trace) that the text is third-party. Read off the revision the run uses (its
 * pin, else the current one): a skill an admin has since edited by hand carries
 * no source sha on that revision and is no longer labelled. A skill whose
 * source was deleted keeps the label, without the repository name.
 */
async function skillProvenance(
  refs: AgentRow['skillRefs'],
  ctx?: ResolveCtx
): Promise<Map<string, string>> {
  const imported = refs.filter((ref) => typeof ref.skill.sourcePath === 'string');
  if (imported.length === 0) {
    return new Map();
  }
  const rows = await prisma.skillRevision.findMany({
    select: { skillId: true, sourceSha: true },
    where: {
      OR: imported.map((ref) => ({
        revision: ctx?.skillRevisions?.[ref.skill.id] ?? ref.skill.currentRevision,
        skillId: ref.skill.id,
      })),
    },
  });
  const shaBySkill = new Map(rows.map((r) => [r.skillId, r.sourceSha]));
  const out = new Map<string, string>();
  for (const ref of imported) {
    const sha = shaBySkill.get(ref.skill.id);
    if (sha) {
      const short = sha.slice(0, 7);
      out.set(
        ref.skill.id,
        ref.skill.source
          ? `external: ${ref.skill.source.owner}/${ref.skill.source.repo}@${short}`
          : `external@${short}`
      );
    }
  }
  return out;
}

/**
 * A pinned revision whose row is gone resolves the live text, which is the swap
 * pinning exists to prevent — so it is loud: a warning in the activity log and
 * a `skill.pinned_revision_missing` event on the run's trace. Only inside an
 * activity (there is no run to attribute it to elsewhere); never throws.
 */
async function reportMissingPinnedRevisions(
  missing: Array<{ skillId: string; pinnedRevision: number; currentRevision: number }>
): Promise<void> {
  logWarn('pinned skill revision missing; using the live text', { missing });
  if (!asyncLocalStorage.getStore()) {
    return;
  }
  try {
    const tracer = new AgentTracer();
    tracer.addActivityEvent({ name: 'skill.pinned_revision_missing', outputJson: { missing } });
    await persistActivityTrace(tracer, 'skillResolver');
  } catch {
    // Observability must never fail a resolution.
  }
}

/**
 * Resolve the model + credential for an Agent. Follows `inheritsModelFrom` to
 * the ancestor Agent that actually carries a `modelSpec` (sub-reviewer/decomposer
 * personas inherit their model from a parent role). Throws `ConfigMissingError`
 * when no `modelSpec` is reachable.
 */
async function resolveModelForAgent(
  agent: AgentRow,
  ctx?: ResolveCtx
): Promise<ResolvedModelConfig> {
  let source: AgentRow = agent;
  const seen = new Set<string>();
  while (!source.modelSpec && source.inheritsModelFrom) {
    if (seen.has(source.key)) {
      break; // cycle guard
    }
    seen.add(source.key);
    const parent = await fetchActiveAgent(source.inheritsModelFrom, ctx);
    if (!parent) {
      throw new ConfigMissingError(
        `Agent '${source.key}' inherits its model from '${source.inheritsModelFrom}', but no active agent with that key exists.`
      );
    }
    source = parent;
  }
  if (!source.modelSpec) {
    throw new ConfigMissingError(
      `Agent '${agent.key}' has no model: set a modelSpec (or an inheritsModelFrom chain that resolves one) at /studio/agents/library.`
    );
  }
  const spec = source.modelSpec;
  const { provider } = parseProviderModelSpec(spec);
  const cred = await resolveProviderCredential(provider, ctx);
  return {
    apiBase: cred.apiBase,
    apiKey: cred.apiKey,
    scope: agent.scope,
    spec,
    systemPrompt: agent.systemPrompt ?? undefined,
  };
}

/**
 * Resolve an Agent by key into its effective configuration. The `Agent` entity
 * is the sole source of truth (P1.5) — model from `modelSpec`/`inheritsModelFrom`,
 * skills from `skillRefs`, tools from `toolKeys`. Throws `ConfigMissingError`
 * when the agent (or its model) is absent.
 */
export async function resolveAgent(key: string, ctx?: ResolveCtx): Promise<ResolvedAgent> {
  // The whole version-pin map is part of the cache key, not just this key's
  // pin: an `inheritsModelFrom` chain resolves the PARENT under the same ctx,
  // so two canary arms pinning different parent versions would otherwise share
  // one entry for the child within the TTL.
  const pins = stablePins(ctx?.agentVersions);
  const cacheKey = `agent:${key}:${ctx?.workflowTemplateId ?? ''}:${ctx?.channelId ?? ''}:${ctx?.teamId ?? ''}:${ctx?.orgId ?? ''}:${pins}:${skillPinsDigest(ctx?.skillRevisions)}`;
  const resolved = await withCache(cacheKey, configCacheTtlMs(), () =>
    resolveAgentUncached(key, ctx)
  );
  // A lookup that fell through to a broader scope cached that broader row under
  // the narrower key, which would hide a row inserted at the requested scope
  // for the full TTL. Bust it so the next call re-queries (same pattern as
  // resolveProviderCredential).
  if (SCOPE_RANK[resolved.model.scope] > mostSpecificRequestedRank(ctx)) {
    invalidate(cacheKey);
  }
  return resolved;
}

/** Cascade order, most specific first. */
const SCOPE_RANK: Record<ResolvedModelConfig['scope'], number> = {
  CHANNEL: 1,
  GLOBAL: 4,
  ORGANIZATION: 3,
  TEAM: 2,
  WORKFLOW_TEMPLATE: 0,
};

/** The rank of the most specific tier the ctx asked the cascade to consult. */
function mostSpecificRequestedRank(ctx: ResolveCtx | undefined): number {
  if (ctx?.workflowTemplateId) {
    return SCOPE_RANK.WORKFLOW_TEMPLATE;
  }
  if (ctx?.channelId) {
    return SCOPE_RANK.CHANNEL;
  }
  if (ctx?.teamId) {
    return SCOPE_RANK.TEAM;
  }
  if (ctx?.orgId) {
    return SCOPE_RANK.ORGANIZATION;
  }
  return SCOPE_RANK.GLOBAL;
}

/** Key-sorted JSON of the pin map, so insertion order cannot split the cache. */
function stablePins(pins: Record<string, number> | undefined): string {
  if (!pins) {
    return '';
  }
  return JSON.stringify(
    Object.keys(pins)
      .sort()
      .map((k) => [k, pins[k]])
  );
}

/**
 * Skill pins belong in the cache key for the same reason agent pins do: the
 * resolved skills carry the pinned text. A run's map names every skill its
 * agents use, so it is digested rather than spelled out.
 */
function skillPinsDigest(pins: Record<string, number> | undefined): string {
  if (!pins) {
    return '';
  }
  return createHash('sha1').update(stablePins(pins)).digest('hex').slice(0, 16);
}

async function resolveAgentUncached(key: string, ctx?: ResolveCtx): Promise<ResolvedAgent> {
  const agent = await fetchActiveAgent(key, ctx);
  if (!agent) {
    throw new ConfigMissingError(
      `No active Agent found for key '${key}' at any scope. Create it at /studio/agents/library.`
    );
  }

  const model = await resolveModelForAgent(agent, ctx);

  return {
    isVerified: agent.isVerified,
    key,
    mcpConnectionId: agent.mcpConnectionId ?? null,
    model,
    origin: agent.origin ?? null,
    skills: await skillsFromAgent(agent, ctx),
    toolKeys: parseToolKeys(agent.toolKeys),
    version: agent.version,
  };
}
