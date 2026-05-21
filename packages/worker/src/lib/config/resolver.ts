import { prisma } from '@auto-swe/shared/db';
import { decryptSecret } from '@auto-swe/shared/lib/crypto';
import { parseProviderModelSpec, providerEnvPrefix } from '../providerUtils.js';
import { configCacheTtlMs, invalidate, withCache } from './cache.js';
import {
  type AgentRole,
  type ResolveCtx,
  type ResolvedModelConfig,
  ROLE_TO_PRISMA,
} from './types.js';

/// Resolves the model spec + (optional) credential override for a role at a
/// given scope. Cascade: WORKFLOW_TEMPLATE → TEAM → GLOBAL → env-var fallback.
/// The env fallback exists so tests and pre-seed worker boots don't crash;
/// in normal operation `seedConfigFromEnv` populates the GLOBAL row on first
/// boot and the env path is no longer hit. If the seed fails (DB unreachable
/// at boot), env continues to serve as a degraded fallback until a real
/// GLOBAL row exists. Env-fallback results are NOT cached so a freshly-seeded
/// row takes effect on the next call rather than after the TTL window.
export async function resolveModelConfig(
  role: AgentRole,
  ctx?: ResolveCtx
): Promise<ResolvedModelConfig> {
  const cacheKey = `model:${role}:${ctx?.workflowTemplateId ?? ''}:${ctx?.teamId ?? ''}`;
  const resolved = await withCache(cacheKey, configCacheTtlMs(), () =>
    resolveModelConfigUncached(role, ctx)
  );
  // Don't let the cache pin an env-fallback result — a freshly-seeded DB row
  // should take effect immediately, not after the next 30s TTL window.
  if (resolved.scope === 'ENV_FALLBACK') invalidate(cacheKey);
  return resolved;
}

async function resolveModelConfigUncached(
  role: AgentRole,
  ctx?: ResolveCtx
): Promise<ResolvedModelConfig> {
  const prismaRole = ROLE_TO_PRISMA[role];

  // 1. Workflow template scope
  if (ctx?.workflowTemplateId) {
    const row = await prisma.modelRoleConfig.findFirst({
      include: { credential: true },
      where: {
        role: prismaRole,
        scope: 'WORKFLOW_TEMPLATE',
        workflowTemplateId: ctx.workflowTemplateId,
      },
    });
    if (row) return materializeRow(row, 'WORKFLOW_TEMPLATE', ctx);
  }

  // 2. Team scope
  if (ctx?.teamId) {
    const row = await prisma.modelRoleConfig.findFirst({
      include: { credential: true },
      where: { role: prismaRole, scope: 'TEAM', teamId: ctx.teamId },
    });
    if (row) return materializeRow(row, 'TEAM', ctx);
  }

  // 3. Global scope
  const globalRow = await prisma.modelRoleConfig.findFirst({
    include: { credential: true },
    where: { role: prismaRole, scope: 'GLOBAL' },
  });
  if (globalRow) return materializeRow(globalRow, 'GLOBAL', ctx);

  // 4. Env-var fallback (only hit before the seed has run, or in unit tests).
  const envSpec = process.env[ROLE_ENV_VAR[role]]?.trim() || DEFAULT_MODELS[role];
  return { scope: 'ENV_FALLBACK', spec: envSpec };
}

/// Look up the credential for `<provider>` at the given scope. Cascade is
/// TEAM → GLOBAL (templates intentionally don't have their own credentials —
/// they reference an existing one via `ModelRoleConfig.credentialId`).
export async function resolveProviderCredential(
  provider: string,
  ctx?: ResolveCtx
): Promise<{ apiBase?: string; apiKey: string } | undefined> {
  const cacheKey = `cred:${provider}:${ctx?.teamId ?? ''}`;
  const resolved = await withCache(cacheKey, configCacheTtlMs(), () =>
    resolveProviderCredentialUncached(provider, ctx)
  );
  // Don't pin a "no credential" miss — operators frequently add a credential
  // in response to a startup failure and shouldn't wait out a 30s TTL.
  if (!resolved) invalidate(cacheKey);
  return resolved;
}

async function resolveProviderCredentialUncached(
  provider: string,
  ctx?: ResolveCtx
): Promise<{ apiBase?: string; apiKey: string } | undefined> {
  if (ctx?.teamId) {
    const row = await prisma.providerCredential.findFirst({
      where: { provider, scope: 'TEAM', teamId: ctx.teamId },
    });
    if (row) return decryptRow(row);
  }
  const globalRow = await prisma.providerCredential.findFirst({
    where: { provider, scope: 'GLOBAL' },
  });
  if (globalRow) return decryptRow(globalRow);
  return undefined;
}

type ProviderCredentialRow = NonNullable<
  Awaited<ReturnType<typeof prisma.providerCredential.findFirst>>
>;
type ModelRoleConfigWithCredential = NonNullable<
  Awaited<ReturnType<typeof prisma.modelRoleConfig.findFirst>>
> & {
  credential: ProviderCredentialRow | null;
};

async function materializeRow(
  row: ModelRoleConfigWithCredential,
  scope: 'WORKFLOW_TEMPLATE' | 'TEAM' | 'GLOBAL',
  ctx: ResolveCtx | undefined
): Promise<ResolvedModelConfig> {
  const spec = row.modelSpec;
  const { provider } = parseProviderModelSpec(spec);

  // Pinned credential on the row (template-scope override). If absent, cascade
  // through the provider's TEAM/GLOBAL credentials.
  if (row.credential) {
    const decrypted = decryptRow(row.credential);
    return { apiBase: decrypted.apiBase, apiKey: decrypted.apiKey, scope, spec };
  }
  const cred = await resolveProviderCredential(provider, ctx);
  return { apiBase: cred?.apiBase, apiKey: cred?.apiKey, scope, spec };
}

function decryptRow(row: ProviderCredentialRow): { apiBase?: string; apiKey: string } {
  const apiKey = decryptSecret({
    authTag: row.apiKeyAuthTag,
    ciphertext: row.apiKeyCiphertext,
    keyVersion: row.keyVersion,
    nonce: row.apiKeyNonce,
  });
  return { apiBase: row.apiBase ?? undefined, apiKey };
}

// ── Env-fallback defaults (mirrors the table in packages/worker/src/lib/models.ts) ──

const DEFAULT_MODELS: Record<AgentRole, string> = {
  commitToMemory: 'anthropic/claude-opus-4-7',
  implementer: 'anthropic/claude-opus-4-7',
  planner: 'anthropic/claude-sonnet-4-6',
  reviewer: 'anthropic/claude-opus-4-7',
  securityReview: 'anthropic/claude-sonnet-4-6',
  validateContext: 'anthropic/claude-sonnet-4-6',
};

const ROLE_ENV_VAR: Record<AgentRole, string> = {
  commitToMemory: 'MEMORY_SUMMARIZER_MODEL',
  implementer: 'IMPLEMENTER_MODEL',
  planner: 'PLANNER_MODEL',
  reviewer: 'REVIEWER_MODEL',
  securityReview: 'SECURITY_REVIEW_MODEL',
  validateContext: 'CONTEXT_VALIDATOR_MODEL',
};

/// Exposed for the seed routine so the env→DB migration uses the same defaults.
export function envFallbackSpec(role: AgentRole): string {
  return process.env[ROLE_ENV_VAR[role]]?.trim() || DEFAULT_MODELS[role];
}

/// Exposed so the seed can iterate the role list without hardcoding it again.
export const ALL_ROLES: readonly AgentRole[] = [
  'implementer',
  'reviewer',
  'planner',
  'securityReview',
  'validateContext',
  'commitToMemory',
] as const;

/// Env-var prefixes that we KNOW are not LLM providers and should never be
/// auto-seeded as credentials even if they happen to expose `<X>_API_BASE` +
/// `<X>_API_KEY` pairs. Conservative list; ops can disable auto-discovery
/// entirely with `LLM_PROVIDER_AUTODISCOVER=false`.
const AUTODISCOVER_BLOCKLIST = new Set([
  'ANTHROPIC',
  'OPENAI',
  'GOOGLE_GENERATIVE_AI',
  'CONFIG',
  'DATABASE',
  'GITHUB',
  'SLACK',
  'TEMPORAL',
  'AWS',
  'S3',
  'OTEL',
  'OTEL_EXPORTER_OTLP',
  'NEXTAUTH',
  'BETTER_AUTH',
  'JWT',
]);

/// Tells the resolver/env-fallback machinery which env-var names to seed from.
/// Returns built-in provider keys plus, optionally, any `<X>_API_BASE` /
/// `<X>_API_KEY` pairs discovered in the environment (opt-out via
/// `LLM_PROVIDER_AUTODISCOVER=false`).
export function envCredentialsFromProcess(): {
  provider: string;
  apiKey: string;
  apiBase?: string;
}[] {
  const out: { provider: string; apiKey: string; apiBase?: string }[] = [];

  // Built-in providers — Vercel AI SDK defaults
  if (process.env.ANTHROPIC_API_KEY) {
    out.push({ apiKey: process.env.ANTHROPIC_API_KEY, provider: 'anthropic' });
  }
  if (process.env.OPENAI_API_KEY) {
    out.push({ apiKey: process.env.OPENAI_API_KEY, provider: 'openai' });
  }
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    out.push({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY, provider: 'google' });
  }

  // OpenAI-compatible providers — discover by `<X>_API_BASE` and pair with
  // `<X>_API_KEY`. Opt-out for ops worried about coincidental prefix matches
  // (e.g. an unrelated `FOO_API_BASE` + `FOO_API_KEY` pair from a different service).
  if (process.env.LLM_PROVIDER_AUTODISCOVER === 'false') return out;

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.endsWith('_API_BASE') || !value) continue;
    const prefix = key.slice(0, -'_API_BASE'.length);
    if (AUTODISCOVER_BLOCKLIST.has(prefix)) continue;
    // Block any prefix that starts with a known reserved word (e.g.
    // `OTEL_EXPORTER_OTLP_API_BASE` shouldn't seed an "otel-exporter-otlp" provider).
    if ([...AUTODISCOVER_BLOCKLIST].some((reserved) => prefix.startsWith(`${reserved}_`))) continue;
    const provider = prefix.toLowerCase().replace(/_/g, '-');
    const apiKey = process.env[`${prefix}_API_KEY`];
    if (!apiKey) continue;
    out.push({ apiBase: value, apiKey, provider });
  }

  return out;
}

export { providerEnvPrefix };
