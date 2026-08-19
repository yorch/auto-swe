import { runUnscoped } from '../lib/tenantGuard.js';
import { configCacheTtlMs, invalidatePrefix, withCache } from './cache.js';
import {
  getSettingDefinition,
  RUN_PINNED_SETTING_KEYS,
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  type SettingKey,
  type SettingValue,
} from './registry.js';
import {
  type ResolvedSetting,
  SETTING_SCOPE_ORDER,
  type SettingDefinition,
  type SettingResolveCtx,
  type SettingScope,
} from './types.js';

// Lazy DB access, matching `lib/systemConfig.ts`: importing the registry in a
// test must not pull in the Prisma client and its DATABASE_URL validation.
async function db() {
  const { prisma } = await import('../db.js');
  return prisma;
}

/**
 * The single read path for registry settings.
 *
 * Resolution order for one key, most specific first:
 *
 *   1. the run's pinned snapshot, for `runPinned` keys inside a run
 *   2. WORKFLOW_TEMPLATE → CHANNEL → TEAM → ORGANIZATION → GLOBAL overrides
 *   3. the definition's env var, so a deployment already driving the value
 *      from the environment keeps working until an admin saves an override
 *   4. the definition default — the constant the setting replaced
 *
 * Every candidate override for a context is fetched in one query and cached
 * under one key, so resolving twenty settings for a run costs one round trip,
 * not twenty. The TTL is the same one the agent and credential resolvers use,
 * which is what makes "how long until my change takes effect" answerable
 * without reading source.
 */

/// Cache key for one resolution context. Every ctx field that can select a row
/// appears, so two different teams never share an entry.
function contextCacheKey(ctx: SettingResolveCtx | undefined): string {
  // Segments are encoded, not just joined: ids are UUIDs today and the API
  // validates them as such, but an id containing the separator would make two
  // different contexts share one entry — which is a cross-tenant read. Encoding
  // removes the class rather than relying on every future caller's id format.
  return [
    'settings',
    encodeURIComponent(ctx?.workflowTemplateId ?? ''),
    encodeURIComponent(ctx?.channelId ?? ''),
    encodeURIComponent(ctx?.teamId ?? ''),
    encodeURIComponent(ctx?.orgId ?? ''),
  ].join(':');
}

/// Loads every override visible from `ctx` in one query, keyed by setting key
/// and then by scope. Rows for keys the registry no longer defines are dropped
/// here so a stale row can never reach a caller.
async function loadOverrides(
  ctx: SettingResolveCtx | undefined
): Promise<Map<string, Map<SettingScope, unknown>>> {
  const orConditions: Record<string, unknown>[] = [{ scope: 'GLOBAL' }];
  if (ctx?.orgId) {
    orConditions.push({ orgId: ctx.orgId, scope: 'ORGANIZATION' });
  }
  if (ctx?.teamId) {
    orConditions.push({ scope: 'TEAM', teamId: ctx.teamId });
  }
  if (ctx?.channelId) {
    orConditions.push({ channelId: ctx.channelId, scope: 'CHANNEL' });
  }
  if (ctx?.workflowTemplateId) {
    orConditions.push({ scope: 'WORKFLOW_TEMPLATE', workflowTemplateId: ctx.workflowTemplateId });
  }

  // Deliberately cross-tenant: the GLOBAL branch of this OR selects rows that
  // belong to no tenant by definition — they are the deployment-wide defaults.
  // Every other branch names exactly one tenant id taken from the caller's ctx,
  // so the query can only widen to GLOBAL, never to another team's overrides.
  const rows = await runUnscoped(
    'GLOBAL settings are the deployment-wide defaults and have no tenant; the other OR branches are pinned to the caller ctx',
    ['ConfigSetting'],
    () =>
      db().then((prisma) =>
        prisma.configSetting.findMany({
          select: { key: true, scope: true, value: true },
          where: { key: { in: SETTING_KEYS }, OR: orConditions },
        })
      )
  );

  const byKey = new Map<string, Map<SettingScope, unknown>>();
  for (const row of rows) {
    let scopes = byKey.get(row.key);
    if (!scopes) {
      scopes = new Map();
      byKey.set(row.key, scopes);
    }
    scopes.set(row.scope, row.value);
  }
  return byKey;
}

function cachedOverrides(
  ctx: SettingResolveCtx | undefined
): Promise<Map<string, Map<SettingScope, unknown>>> {
  return withCache(contextCacheKey(ctx), configCacheTtlMs(), () => loadOverrides(ctx));
}

/// Validates a stored or pinned value against the definition. A value that no
/// longer parses — a row written before the schema tightened, a hand-edited
/// JSON column — is ignored rather than thrown, so a bad row degrades that one
/// key to its default instead of failing every activity that reads config.
function accept<T>(definition: SettingDefinition<T>, raw: unknown): T | undefined {
  const parsed = definition.schema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  // Falling through to the next tier keeps one bad row from failing every
  // activity that reads config — but silently ignoring a value an operator
  // saved is its own trap: they see their row in the database and "DEFAULT" in
  // the dashboard, with nothing connecting the two.
  console.warn(
    `[config] ignoring stored value for '${definition.key}': ${parsed.error.issues
      .map((issue) => issue.message)
      .join('; ')}`
  );
  return undefined;
}

function fromEnv<T>(definition: SettingDefinition<T>): T | undefined {
  if (!definition.envVar) {
    return undefined;
  }
  const raw = process.env[definition.envVar];
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const parsed = definition.parseEnv ? definition.parseEnv(raw) : (raw as unknown as T);
  return parsed === undefined ? undefined : accept(definition, parsed);
}

/// Resolves one key against already-loaded overrides. Split out so the batch
/// and single-key entry points share exactly one resolution rule.
function resolveFrom<K extends SettingKey>(
  key: K,
  overrides: Map<string, Map<SettingScope, unknown>>,
  ctx: SettingResolveCtx | undefined
): ResolvedSetting<SettingValue<K>> {
  const definition = getSettingDefinition(key) as unknown as SettingDefinition<SettingValue<K>>;

  // `pinnedSettings` comes from an untyped Json column, so it may be a string or
  // a number on a hand-edited row. `in` throws on those, which would break every
  // activity in the run — the opposite of this module's rule that a malformed
  // stored value degrades one key.
  if (
    definition.runPinned &&
    typeof ctx?.pinnedSettings === 'object' &&
    ctx.pinnedSettings !== null &&
    key in ctx.pinnedSettings
  ) {
    const pinned = accept(definition, ctx.pinnedSettings[key]);
    if (pinned !== undefined) {
      // Which scope supplied it was decided at run start and is not recorded in
      // the snapshot, so the provenance an operator sees is 'PINNED' — which is
      // the fact that matters when asking why a live edit is not taking effect.
      return { key, source: 'PINNED', value: pinned };
    }
  }

  const scopes = overrides.get(key);
  if (scopes) {
    for (const scope of SETTING_SCOPE_ORDER) {
      if (!scopes.has(scope)) {
        continue;
      }
      // A definition that forbids a scope must be honoured on the way OUT as
      // well as on the way in. The write path checks `overridableAt`, but a row
      // can exist without passing through it — written by direct SQL, or left
      // behind when a definition later narrows its scopes — and a
      // platform-wide security control that a stray TEAM row can switch off is
      // not a control. `workspace.blockMetadata` is exactly this case.
      if (scope !== 'GLOBAL' && !definition.overridableAt.includes(scope)) {
        continue;
      }
      const value = accept(definition, scopes.get(scope));
      if (value !== undefined) {
        return { key, source: scope, value };
      }
    }
  }

  const envValue = fromEnv(definition);
  if (envValue !== undefined) {
    return { key, source: 'ENV', value: envValue };
  }

  return { key, source: 'DEFAULT', value: definition.defaultValue };
}

/// Reads one setting. Prefer `resolveSettings` when a caller needs several —
/// both cost one query, but the batch form avoids re-walking the cache.
export async function resolveSetting<K extends SettingKey>(
  key: K,
  ctx?: SettingResolveCtx
): Promise<SettingValue<K>> {
  const overrides = await cachedOverrides(ctx);
  return resolveFrom(key, overrides, ctx).value;
}

/// Reads several settings in one round trip.
export async function resolveSettings<K extends SettingKey>(
  keys: readonly K[],
  ctx?: SettingResolveCtx
): Promise<{ [P in K]: SettingValue<P> }> {
  const overrides = await cachedOverrides(ctx);
  const out = {} as { [P in K]: SettingValue<P> };
  for (const key of keys) {
    out[key] = resolveFrom(key, overrides, ctx).value;
  }
  return out;
}

/// Every setting with its resolved value and the scope that supplied it. Backs
/// the effective-config view, which is the diagnostic for "why is this run
/// behaving that way" — there was no way to answer that before.
export async function resolveEffectiveSettings(
  ctx?: SettingResolveCtx
): Promise<ResolvedSetting[]> {
  const overrides = await cachedOverrides(ctx);
  return SETTING_KEYS.map((key) => resolveFrom(key, overrides, ctx) as ResolvedSetting);
}

/// Snapshot of every run-pinned setting, taken once at run start and stored on
/// `WorkflowRun.pinnedSettings`. Reads the live cascade, so it must run before
/// the run makes any decision that depends on these values.
export async function snapshotPinnedSettings(
  ctx?: SettingResolveCtx
): Promise<Record<string, unknown>> {
  const overrides = await cachedOverrides(ctx);
  const snapshot: Record<string, unknown> = {};
  for (const key of RUN_PINNED_SETTING_KEYS) {
    snapshot[key] = resolveFrom(key, overrides, ctx).value;
  }
  return snapshot;
}

/// Drops every cached resolution context so an admin's save is visible on the
/// next read rather than after the TTL. Deliberately not targeted: a write at
/// one scope changes what many contexts resolve to (a GLOBAL edit affects every
/// team's entry), and a stale entry is worse than a rebuild that costs one
/// query.
export function invalidateSettingsCache(): void {
  invalidatePrefix('settings:');
}

export { SETTING_DEFINITIONS };
