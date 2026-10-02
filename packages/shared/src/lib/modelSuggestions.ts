import type { PrismaClient } from '../index.js';
import {
  type DiscoveredSpec,
  discoverProviderModels,
  type ProviderDiscovery,
} from './modelDiscovery.js';

/**
 * Persisting what discovery found, in `model_suggestions` and
 * `model_discovery_provider_status` — never in the catalog, so a suggestion can
 * not make a model "known" at $0 and the pricing path never reads one.
 *
 * Shared by the scheduled run (a worker activity) and the on-demand route, so
 * both leave the same state behind.
 */

export interface DiscoveryRunSummary {
  providers: Array<{
    provider: string;
    ok: boolean;
    error?: string;
    newModels: number;
    retirementCandidates: number;
  }>;
}

/**
 * Applies one discovery pass.
 *
 * - A provider whose listing failed changes nothing but its status row: its
 *   suggestions stay as they were, because no answer is not "nothing listed".
 * - NEW rows follow the listing: upserted while a provider lists an unpriced
 *   model, dropped once it is priced or no longer listed. An incomplete listing
 *   drops nothing, since a model past the page cap is not gone.
 * - RETIREMENT_CANDIDATE rows follow the same rule and are flags only.
 * - A dismissal survives refreshes; a row that changes type starts undismissed.
 * - Providers with no GLOBAL credential left lose their rows, so nothing outlives
 *   the credential that produced it.
 */
export async function recordDiscovery(
  prisma: PrismaClient,
  results: ProviderDiscovery[],
  now: Date = new Date()
): Promise<DiscoveryRunSummary> {
  const providers = results.map((r) => r.provider);
  await prisma.modelSuggestion.deleteMany({ where: { provider: { notIn: providers } } });
  await prisma.modelDiscoveryProviderStatus.deleteMany({
    where: { provider: { notIn: providers } },
  });

  for (const r of results) {
    if (!r.ok) {
      await prisma.modelDiscoveryProviderStatus.upsert({
        create: { checkedAt: now, error: r.error ?? 'unknown error', provider: r.provider },
        update: { checkedAt: now, error: r.error ?? 'unknown error' },
        where: { provider: r.provider },
      });
      continue;
    }
    await prisma.modelDiscoveryProviderStatus.upsert({
      create: { checkedAt: now, error: null, lastSuccessAt: now, provider: r.provider },
      update: { checkedAt: now, error: null, lastSuccessAt: now },
      where: { provider: r.provider },
    });

    const existing = await prisma.modelSuggestion.findMany({ where: { provider: r.provider } });
    const typeOf = new Map(existing.map((e) => [e.modelId, e.type]));

    const write = async (type: 'NEW' | 'RETIREMENT_CANDIDATE', m: DiscoveredSpec) => {
      const flipped = typeOf.has(m.modelId) && typeOf.get(m.modelId) !== type;
      await prisma.modelSuggestion.upsert({
        create: {
          displayName: m.displayName,
          firstSeenAt: now,
          kind: m.kind,
          lastSeenAt: now,
          modelId: m.modelId,
          provider: r.provider,
          type,
        },
        update: {
          displayName: m.displayName,
          kind: m.kind,
          lastSeenAt: now,
          type,
          ...(flipped && { dismissedAt: null, firstSeenAt: now }),
        },
        where: { provider_modelId: { modelId: m.modelId, provider: r.provider } },
      });
    };
    for (const m of r.models) {
      await write('NEW', m);
    }
    if (r.complete) {
      for (const m of r.retirementCandidates) {
        await write('RETIREMENT_CANDIDATE', m);
      }
      // Whatever type it now holds, a model written above stays; the rest are gone.
      const keep = new Set([...r.models, ...r.retirementCandidates].map((m) => m.modelId));
      const stale = existing.filter((e) => !keep.has(e.modelId)).map((e) => e.id);
      if (stale.length > 0) {
        await prisma.modelSuggestion.deleteMany({ where: { id: { in: stale } } });
      }
    }
  }

  return {
    providers: results.map((r) => ({
      error: r.error,
      newModels: r.models.length,
      ok: r.ok,
      provider: r.provider,
      retirementCandidates: r.retirementCandidates.length,
    })),
  };
}

/** One discovery pass over every GLOBAL credential, recorded. */
export async function runModelDiscovery(
  prisma: PrismaClient
): Promise<{ results: ProviderDiscovery[]; summary: DiscoveryRunSummary }> {
  const results = await discoverProviderModels(prisma);
  return { results, summary: await recordDiscovery(prisma, results) };
}
