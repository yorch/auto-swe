import type { PrismaClient } from '@auto-swe/shared';
import {
  BUILTIN_MODELS,
  type BuiltinModel,
  builtinModelSpec,
} from '@auto-swe/shared/lib/builtinModels';
import { parseProviderModelSpec } from '@auto-swe/shared/lib/modelSpec';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';

/**
 * Model-catalog logic shared by the catalog routes and the saves that name a
 * model (agents, the embedding config). The worker prices a call from its
 * spec's catalog row, else `BUILTIN_MODELS`, else $0 — so "priced" here means
 * the same union, and a spec outside it is the one USD budgets never see.
 */

export type ModelKind = 'CHAT' | 'EMBEDDING';

/** How far back recorded LLM calls count as "in use" for the unpriced report. */
export const UNPRICED_TRACE_LOOKBACK_DAYS = 30;

const BUILTIN_BY_SPEC: ReadonlyMap<string, BuiltinModel> = new Map(
  BUILTIN_MODELS.map((m) => [builtinModelSpec(m), m])
);

export function builtinModelFor(spec: string): BuiltinModel | undefined {
  return BUILTIN_BY_SPEC.get(spec);
}

/** Spellings that differ only by `.` vs `-` or case — the gpt-5.5 / gpt-5-5 slip. */
function normalizeSpec(spec: string): string {
  return spec.toLowerCase().replace(/\./g, '-');
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/**
 * The priced spec `spec` most plausibly meant, or null. A spelling that matches
 * once `.`/`-` and case are normalised wins outright; otherwise the nearest spec
 * from the same provider within two edits, if exactly one is nearest.
 */
export function suggestSpec(spec: string, priced: Iterable<string>): string | null {
  const candidates = [...priced].filter((p) => p !== spec);
  const normalized = normalizeSpec(spec);
  const exact = candidates.find((p) => normalizeSpec(p) === normalized);
  if (exact) {
    return exact;
  }
  const provider = spec.slice(0, spec.indexOf('/') + 1);
  let best: string | null = null;
  let bestDistance = 3;
  let tied = false;
  for (const p of candidates) {
    if (!provider || !p.startsWith(provider)) {
      continue;
    }
    const d = editDistance(normalized, normalizeSpec(p));
    if (d < bestDistance) {
      best = p;
      bestDistance = d;
      tied = false;
    } else if (d === bestDistance) {
      tied = true;
    }
  }
  return tied ? null : best;
}

function kindPhrase(kind: ModelKind): string {
  return kind === 'EMBEDDING' ? 'an embedding' : 'a chat';
}

/** Every spec the worker can price: catalog rows plus the built-in table. */
export async function pricedSpecs(prisma: PrismaClient): Promise<Set<string>> {
  const rows = await prisma.modelCatalogEntry.findMany({
    select: { modelId: true, provider: true },
  });
  return new Set([
    ...rows.map((r) => `${r.provider}/${r.modelId}`),
    ...BUILTIN_MODELS.map(builtinModelSpec),
  ]);
}

/**
 * Advisory warnings for saving a config that runs `spec` as a `kind` model. Never
 * blocks the save — a model released today, a self-hosted endpoint, or a pinned
 * version must not be refused — but says what an unpriced or wrong model costs.
 */
export async function catalogWarnings(
  prisma: PrismaClient,
  spec: string,
  kind: ModelKind
): Promise<string[]> {
  let provider: string;
  let modelId: string;
  try {
    ({ provider, modelId } = parseProviderModelSpec(spec));
  } catch {
    return [];
  }
  const row = await prisma.modelCatalogEntry.findUnique({
    select: { kind: true, status: true },
    where: { provider_modelId: { modelId, provider } },
  });
  const entry = row ?? builtinModelFor(`${provider}/${modelId}`);
  if (!entry) {
    const suggestion = suggestSpec(`${provider}/${modelId}`, await pricedSpecs(prisma));
    return [
      `'${spec}' is not in the model catalog, so its calls are recorded at $0 and USD budgets do not see them.` +
        (suggestion ? ` Did you mean '${suggestion}'?` : ' Add it to the catalog to price it.'),
    ];
  }
  const warnings: string[] = [];
  if (entry.kind !== kind) {
    warnings.push(
      `'${spec}' is cataloged as ${kindPhrase(entry.kind)} model, but is being used as ${kindPhrase(kind)} model.`
    );
  }
  if (entry.status === 'RETIRED') {
    warnings.push(
      `'${spec}' is retired in the model catalog; its provider may no longer serve it.`
    );
  } else if (entry.status === 'DEPRECATED') {
    warnings.push(`'${spec}' is deprecated in the model catalog.`);
  }
  return warnings;
}

export interface UnpricedSpec {
  spec: string;
  /** Where it is in use: `agent:<key>`, `embedding-config`, or `recent-calls`. */
  usedBy: string[];
  suggestion: string | null;
}

/**
 * Specs in use that the worker cannot price: the model of every active Agent
 * version, the embedding config, and every model a recorded LLM call used in the
 * last {@link UNPRICED_TRACE_LOOKBACK_DAYS} days — minus everything priced.
 */
export async function findUnpricedSpecs(
  prisma: PrismaClient,
  now: Date = new Date()
): Promise<UnpricedSpec[]> {
  const since = new Date(now.getTime() - UNPRICED_TRACE_LOOKBACK_DAYS * 86_400_000);
  const [agents, embedding, traces, priced] = await Promise.all([
    // Every scope on purpose: an unpriced model is a platform-wide gap, and this
    // report is ADMIN-only.
    runUnscoped('admin reports unpriced models across every agent scope', ['Agent'], () =>
      prisma.agent.findMany({
        select: { key: true, modelSpec: true },
        where: { isActive: true, modelSpec: { not: null } },
      })
    ),
    prisma.embeddingConfig.findUnique({ select: { modelSpec: true }, where: { id: 'default' } }),
    prisma.agentTrace.findMany({
      distinct: ['model'],
      select: { model: true },
      where: { createdAt: { gte: since }, model: { not: null }, type: 'llm_response' },
    }),
    pricedSpecs(prisma),
  ]);

  const usedBy = new Map<string, Set<string>>();
  const note = (spec: string | null | undefined, use: string) => {
    if (spec && !priced.has(spec)) {
      usedBy.set(spec, (usedBy.get(spec) ?? new Set()).add(use));
    }
  };
  for (const a of agents) {
    note(a.modelSpec, `agent:${a.key}`);
  }
  note(embedding?.modelSpec, 'embedding-config');
  for (const t of traces) {
    note(t.model, 'recent-calls');
  }

  return [...usedBy.entries()]
    .map(([spec, uses]) => ({
      spec,
      suggestion: suggestSpec(spec, priced),
      usedBy: [...uses].sort(),
    }))
    .sort((a, b) => a.spec.localeCompare(b.spec));
}

export interface RolePrice {
  /** The model the role's GLOBAL agent runs, after following `inheritsModelFrom`. */
  modelSpec: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

/** How far `inheritsModelFrom` is followed before a chain is treated as broken. */
const MAX_INHERIT_DEPTH = 5;

/**
 * Per-role prices for the workflow editor's cost estimate: for each of `roles`
 * (agent keys), the model its latest active GLOBAL agent runs — following
 * `inheritsModelFrom` as the resolver does — priced from its catalog row, else
 * the built-in table. A role whose model has no price is left out, so the
 * estimator falls back to its default for that role rather than show $0.
 *
 * Only GLOBAL agents: the editor estimates a template, not a run, so team and
 * template overrides are not known here.
 */
export async function rolePricing(
  prisma: PrismaClient,
  roles: readonly string[]
): Promise<Record<string, RolePrice>> {
  const [agents, catalog] = await Promise.all([
    runUnscoped('editor estimate reads the models of the GLOBAL agents', ['Agent'], () =>
      prisma.agent.findMany({
        orderBy: { version: 'desc' },
        select: { inheritsModelFrom: true, key: true, modelSpec: true },
        where: { isActive: true, scope: 'GLOBAL' },
      })
    ),
    prisma.modelCatalogEntry.findMany({
      select: { inputUsdPerMTok: true, modelId: true, outputUsdPerMTok: true, provider: true },
    }),
  ]);
  // Ordered by version descending, so the first row per key is the latest.
  const latest = new Map<string, { modelSpec: string | null; inheritsModelFrom: string | null }>();
  for (const a of agents) {
    if (!latest.has(a.key)) {
      latest.set(a.key, a);
    }
  }
  const prices = new Map(
    catalog
      .filter((r) => r.inputUsdPerMTok >= 0 && r.outputUsdPerMTok >= 0)
      .map((r) => [`${r.provider}/${r.modelId}`, r])
  );
  const specFor = (key: string): string | null => {
    let current = latest.get(key);
    for (let depth = 0; current && depth < MAX_INHERIT_DEPTH; depth++) {
      if (current.modelSpec) {
        return current.modelSpec;
      }
      current = current.inheritsModelFrom ? latest.get(current.inheritsModelFrom) : undefined;
    }
    return null;
  };

  const result: Record<string, RolePrice> = {};
  for (const role of roles) {
    const spec = specFor(role);
    const price = spec ? (prices.get(spec) ?? builtinModelFor(spec)) : undefined;
    if (spec && price) {
      result[role] = {
        inputUsdPerMTok: price.inputUsdPerMTok,
        modelSpec: spec,
        outputUsdPerMTok: price.outputUsdPerMTok,
      };
    }
  }
  return result;
}
