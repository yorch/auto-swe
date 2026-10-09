import { prisma } from '../db.js';
import {
  embeddingProviderProblem,
  isBuiltInProvider,
  parseProviderModelSpec,
} from './modelSpec.js';
import { runUnscoped } from './tenantGuard.js';

/**
 * Which agents (and the embedding model) could not be called with the
 * credentials that exist — computed from rows, without decrypting anything.
 *
 * It mirrors the worker's resolution: the model comes from the agent's own
 * `modelSpec` or its `inheritsModelFrom` chain; a pinned credential is used when
 * it exists, matches the provider and is reachable from the agent's scope;
 * otherwise the provider-name cascade TEAM → ORGANIZATION → GLOBAL picks the
 * first reachable credential, and a non-built-in provider needs an `apiBase` on
 * it. The setup readiness check, the credential delete guard and the worker's
 * boot gate all read their gaps from here, so they cannot disagree about what a
 * credential covers.
 *
 * A CHANNEL or WORKFLOW_TEMPLATE agent runs for whichever team owns the run, so
 * any credential for its provider counts as covering it.
 */

export interface CoverageAgent {
  key: string;
  scope: string;
  teamId: string | null;
  orgId: string | null;
  channelId: string | null;
  workflowTemplateId: string | null;
  modelSpec: string | null;
  inheritsModelFrom: string | null;
  credentialId: string | null;
}

export interface CoverageCredential {
  id: string;
  provider: string;
  scope: string;
  teamId: string | null;
  orgId: string | null;
  hasApiBase: boolean;
}

export interface CoverageInput {
  /** The version that runs: the highest active version of each lineage. */
  agents: CoverageAgent[];
  credentials: CoverageCredential[];
  /** Each team's organization, for the ORGANIZATION tier of a TEAM agent's cascade. */
  teamOrgs: ReadonlyMap<string, string | null>;
  embedding: { modelSpec: string; credentialId: string | null } | null;
}

export type CoverageProblem =
  | 'no-model'
  | 'invalid-spec'
  | 'no-credential'
  | 'no-api-base'
  | 'unsupported-embedding-provider'
  | 'pin-provider-mismatch'
  | 'no-embedding-config';

export interface CoverageGap {
  /** An agent key, or `embeddings` for the embedding model. */
  subject: string;
  scope: string;
  teamId: string | null;
  orgId: string | null;
  provider: string | null;
  problem: CoverageProblem;
  detail: string;
}

interface Reach {
  teamId: string | null;
  orgId: string | null;
  /** True for CHANNEL / WORKFLOW_TEMPLATE agents: any credential counts. */
  any: boolean;
}

function reachOf(agent: CoverageAgent, teamOrgs: ReadonlyMap<string, string | null>): Reach {
  switch (agent.scope) {
    case 'TEAM':
      return {
        any: false,
        orgId: (agent.teamId && teamOrgs.get(agent.teamId)) ?? null,
        teamId: agent.teamId,
      };
    case 'ORGANIZATION':
      return { any: false, orgId: agent.orgId, teamId: null };
    case 'GLOBAL':
      return { any: false, orgId: null, teamId: null };
    default:
      return { any: true, orgId: null, teamId: null };
  }
}

function reaches(cred: CoverageCredential, reach: Reach): boolean {
  if (reach.any || cred.scope === 'GLOBAL') {
    return true;
  }
  if (cred.scope === 'TEAM') {
    return reach.teamId !== null && cred.teamId === reach.teamId;
  }
  if (cred.scope === 'ORGANIZATION') {
    return reach.orgId !== null && cred.orgId === reach.orgId;
  }
  return false;
}

const CASCADE_RANK: Record<string, number> = { GLOBAL: 2, ORGANIZATION: 1, TEAM: 0 };

/** The credential the cascade picks for `provider` at `reach`, or null. */
function cascadeCredential(
  provider: string,
  reach: Reach,
  credentials: readonly CoverageCredential[]
): CoverageCredential | null {
  const reachable = credentials
    .filter((c) => c.provider.toLowerCase() === provider && reaches(c, reach))
    .sort((a, b) => (CASCADE_RANK[a.scope] ?? 9) - (CASCADE_RANK[b.scope] ?? 9));
  return reachable[0] ?? null;
}

/**
 * The row an `inheritsModelFrom` key resolves to for `from`: the same owner's
 * row first, then the broader tiers, ending at GLOBAL — the cascade the worker
 * walks with the run's context.
 */
function parentOf(
  key: string,
  from: CoverageAgent,
  reach: Reach,
  agents: readonly CoverageAgent[]
): CoverageAgent | null {
  const byKey = agents.filter((a) => a.key === key);
  const sameOwner = byKey.find(
    (a) =>
      a.scope === from.scope &&
      a.teamId === from.teamId &&
      a.orgId === from.orgId &&
      a.channelId === from.channelId &&
      a.workflowTemplateId === from.workflowTemplateId
  );
  return (
    sameOwner ??
    (reach.teamId ? byKey.find((a) => a.scope === 'TEAM' && a.teamId === reach.teamId) : null) ??
    (reach.orgId
      ? byKey.find((a) => a.scope === 'ORGANIZATION' && a.orgId === reach.orgId)
      : null) ??
    byKey.find((a) => a.scope === 'GLOBAL') ??
    null
  );
}

function gapFor(
  agent: CoverageAgent,
  provider: string | null,
  problem: CoverageProblem,
  detail: string
): CoverageGap {
  return {
    detail,
    orgId: agent.orgId,
    problem,
    provider,
    scope: agent.scope,
    subject: agent.key,
    teamId: agent.teamId,
  };
}

/** The gap for one agent, or null when its model can be called. */
export function agentCoverageGap(agent: CoverageAgent, input: CoverageInput): CoverageGap | null {
  const reach = reachOf(agent, input.teamOrgs);
  // Follow inheritsModelFrom to the row that carries the model.
  let source: CoverageAgent | null = agent;
  const seen = new Set<CoverageAgent>();
  while (source && !source.modelSpec && source.inheritsModelFrom && !seen.has(source)) {
    seen.add(source);
    source = parentOf(source.inheritsModelFrom, source, reach, input.agents);
  }
  if (!source?.modelSpec) {
    return gapFor(agent, null, 'no-model', `Agent '${agent.key}' resolves no model.`);
  }
  let provider: string;
  try {
    provider = parseProviderModelSpec(source.modelSpec).provider;
  } catch {
    return gapFor(
      agent,
      null,
      'invalid-spec',
      `Agent '${agent.key}' has an invalid model spec '${source.modelSpec}'.`
    );
  }

  const pinnedId = agent.credentialId ?? source.credentialId;
  const pinned = pinnedId ? input.credentials.find((c) => c.id === pinnedId) : undefined;
  const credential =
    pinned && pinned.provider.toLowerCase() === provider && reaches(pinned, reach)
      ? pinned
      : cascadeCredential(provider, reach, input.credentials);
  if (!credential) {
    return gapFor(
      agent,
      provider,
      'no-credential',
      `No credential for provider '${provider}' is reachable from agent '${agent.key}'.`
    );
  }
  if (!isBuiltInProvider(provider) && !credential.hasApiBase) {
    return gapFor(
      agent,
      provider,
      'no-api-base',
      `The '${provider}' credential agent '${agent.key}' uses has no apiBase, which a non-built-in provider needs.`
    );
  }
  return null;
}

/** The embedding model's gap, or null when it can be called. The embedding model has no scope. */
export function embeddingCoverageGap(input: CoverageInput): CoverageGap | null {
  const base = { orgId: null, scope: 'GLOBAL', subject: 'embeddings', teamId: null };
  if (!input.embedding) {
    return {
      ...base,
      detail: 'No embedding model is chosen.',
      problem: 'no-embedding-config',
      provider: null,
    };
  }
  let provider: string;
  try {
    provider = parseProviderModelSpec(input.embedding.modelSpec).provider;
  } catch {
    return {
      ...base,
      detail: `The embedding model spec '${input.embedding.modelSpec}' is invalid.`,
      problem: 'invalid-spec',
      provider: null,
    };
  }
  const unsupported = embeddingProviderProblem(provider);
  if (unsupported) {
    return { ...base, detail: unsupported, problem: 'unsupported-embedding-provider', provider };
  }
  const pinned = input.embedding.credentialId
    ? input.credentials.find((c) => c.id === input.embedding?.credentialId)
    : undefined;
  // The worker calls the embedding model with its pinned credential whatever
  // its provider, so a mismatch is a gap of its own, not a fall-back.
  if (pinned && pinned.provider.toLowerCase() !== provider) {
    return {
      ...base,
      detail: `The embedding model (provider '${provider}') pins a credential for '${pinned.provider}'.`,
      problem: 'pin-provider-mismatch',
      provider,
    };
  }
  const credential =
    pinned ??
    cascadeCredential(provider, { any: false, orgId: null, teamId: null }, input.credentials);
  if (!credential) {
    return {
      ...base,
      detail: `The embedding model uses '${provider}', which has no GLOBAL credential.`,
      problem: 'no-credential',
      provider,
    };
  }
  if (!isBuiltInProvider(provider) && !credential.hasApiBase) {
    return {
      ...base,
      detail: `The '${provider}' credential the embedding model uses has no apiBase.`,
      problem: 'no-api-base',
      provider,
    };
  }
  return null;
}

/** Every gap: one per uncovered agent, plus the embedding model's. */
export function credentialGaps(input: CoverageInput): CoverageGap[] {
  const gaps = input.agents
    .map((agent) => agentCoverageGap(agent, input))
    .filter((g): g is CoverageGap => g !== null);
  const embedding = embeddingCoverageGap(input);
  return embedding ? [...gaps, embedding] : gaps;
}

/** A gap's identity, for comparing two gap lists. */
export function gapKey(gap: CoverageGap): string {
  return [gap.subject, gap.scope, gap.teamId ?? '', gap.orgId ?? '', gap.problem].join('|');
}

/**
 * Reads the rows {@link credentialGaps} needs. Every agent lineage counts, at
 * every scope; within a lineage only the highest active version runs.
 */
export async function loadCoverageInput(
  client: Pick<typeof prisma, 'agent' | 'embeddingConfig' | 'providerCredential' | 'team'> = prisma
): Promise<CoverageInput> {
  return runUnscoped(
    'credential coverage is a deployment-wide question: which agents any credential serves',
    ['Agent', 'ProviderCredential', 'Team'],
    async () => {
      const [agents, credentials, teams, embedding] = await Promise.all([
        client.agent.findMany({
          orderBy: { version: 'desc' },
          select: {
            channelId: true,
            credentialId: true,
            inheritsModelFrom: true,
            key: true,
            modelSpec: true,
            orgId: true,
            scope: true,
            teamId: true,
            version: true,
            workflowTemplateId: true,
          },
          where: { isActive: true },
        }),
        client.providerCredential.findMany({
          select: {
            apiBase: true,
            id: true,
            orgId: true,
            provider: true,
            scope: true,
            teamId: true,
          },
        }),
        client.team.findMany({ select: { id: true, orgId: true } }),
        client.embeddingConfig.findUnique({
          select: { credentialId: true, modelSpec: true },
          where: { id: 'default' },
        }),
      ]);
      const latest = new Map<string, CoverageAgent>();
      for (const a of agents) {
        const lineage = [
          a.key,
          a.scope,
          a.teamId ?? '',
          a.orgId ?? '',
          a.channelId ?? '',
          a.workflowTemplateId ?? '',
        ].join('|');
        // Ordered by version descending, so the first row of a lineage is the one that runs.
        if (!latest.has(lineage)) {
          const { version: _version, ...row } = a;
          latest.set(lineage, row);
        }
      }
      return {
        agents: [...latest.values()],
        credentials: credentials.map(({ apiBase, ...c }) => ({
          ...c,
          hasApiBase: Boolean(apiBase),
        })),
        embedding: embedding ?? null,
        teamOrgs: new Map(teams.map((t) => [t.id, t.orgId])),
      };
    }
  );
}

/**
 * The gaps deleting `credentialId` would open: agents (and the embedding model)
 * that are covered now and would not be after. A pin to the credential that a
 * cascade credential would replace is not a gap — the call still works.
 */
export function gapsOpenedByRemoving(input: CoverageInput, credentialId: string): CoverageGap[] {
  const before = new Set(credentialGaps(input).map(gapKey));
  const after = credentialGaps({
    ...input,
    credentials: input.credentials.filter((c) => c.id !== credentialId),
  });
  return after.filter((gap) => !before.has(gapKey(gap)));
}
