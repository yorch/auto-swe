import type {
  AdminTokenSummary,
  PatSummary,
  UserSummary,
  WorkflowTemplateAnalytics,
} from '@auto-swe/shared/types/api';
import type { LinkedAccount, ProviderFlags } from '../../src/hooks/useAccountSettings';
import type { McpGrantsResponse } from '../../src/hooks/useMcpGrants';
import type { ProviderCredentialRow } from '../../src/hooks/useModelConfig';
import type { Readiness } from '../../src/hooks/useReadiness';
import type { MyCredentials } from '../../src/hooks/useRepositories';
import type { ModelCatalogEntry, RolePrice } from '../../src/lib/modelCatalog';
import { ago, ahead, TEAMS } from './common';
import { VIEWER } from './session';

const teamRef = (i: number) => ({ id: TEAMS[i].id, name: TEAMS[i].name, slug: TEAMS[i].slug });

export const USERS: UserSummary[] = [
  {
    createdAt: ago(60 * 24 * 200),
    email: VIEWER.email,
    id: VIEWER.id,
    isActive: true,
    memberships: [{ id: 'm-1', role: 'LEAD', team: teamRef(0) }],
    role: 'ADMIN',
    slackId: 'U012ADA',
  },
  {
    createdAt: ago(60 * 24 * 120),
    email: 'grace.hopper@example.com',
    id: 'user-0002',
    isActive: true,
    memberships: [
      { id: 'm-2', role: 'MEMBER', team: teamRef(0) },
      { id: 'm-3', role: 'LEAD', team: teamRef(1) },
    ],
    role: 'LEAD',
    slackId: null,
  },
  {
    createdAt: ago(60 * 24 * 45),
    email: 'alan.turing@example.com',
    id: 'user-0003',
    isActive: true,
    memberships: [{ id: 'm-4', role: 'MEMBER', team: teamRef(1) }],
    role: 'ENGINEER',
    slackId: 'U034ALN',
  },
  {
    createdAt: ago(60 * 24 * 2),
    email: 'new.joiner@example.com',
    id: 'user-0004',
    isActive: false,
    memberships: [],
    role: 'ENGINEER',
    slackId: null,
  },
];

export const ACCESS_TOKENS: AdminTokenSummary[] = [
  {
    createdAt: ago(60 * 24 * 30),
    expiresAt: ahead(60 * 24 * 60),
    id: 'tok-0001',
    lastUsedAt: ago(14),
    name: 'CI pipeline',
    prefix: 'aswe_pat_3f9a',
    revokedAt: null,
    scopes: [],
    servicePrincipal: null,
    user: { email: VIEWER.email, id: VIEWER.id },
  },
  {
    createdAt: ago(60 * 24 * 10),
    expiresAt: ahead(60 * 24 * 355),
    id: 'tok-0002',
    lastUsedAt: ago(60 * 5),
    name: 'Nightly dependency bot',
    prefix: 'aswe_svc_c41d',
    revokedAt: null,
    scopes: ['runs:launch', 'runs:read'],
    servicePrincipal: { id: 'sp-0001', name: 'dependency-bot', team: TEAMS[1] },
    user: null,
  },
  {
    createdAt: ago(60 * 24 * 90),
    expiresAt: null,
    id: 'tok-0003',
    lastUsedAt: null,
    name: 'Old laptop',
    prefix: 'aswe_pat_77e0',
    revokedAt: ago(60 * 24 * 20),
    scopes: [],
    servicePrincipal: null,
    user: { email: 'grace.hopper@example.com', id: 'user-0002' },
  },
];

export const PATS: PatSummary[] = [
  {
    createdAt: ago(60 * 24 * 30),
    expiresAt: ahead(60 * 24 * 60),
    id: 'tok-0001',
    lastUsedAt: ago(14),
    name: 'CI pipeline',
    prefix: 'aswe_pat_3f9a',
    revokedAt: null,
  },
  {
    createdAt: ago(60 * 24 * 6),
    expiresAt: null,
    id: 'tok-0004',
    lastUsedAt: null,
    name: 'Local CLI',
    prefix: 'aswe_pat_9b12',
    revokedAt: null,
  },
];

export const MY_CREDENTIALS: MyCredentials = { credentials: [], enabled: false };

export const MCP_GRANTS: McpGrantsResponse = {
  data: [
    {
      clientId: 'client-0001',
      clientName: 'Claude Desktop',
      grantedAt: ago(60 * 24 * 4),
      redirectUris: ['http://127.0.0.1:33418/callback'],
      scopes: ['openid', 'runs:read'],
    },
  ],
  mcp: { enabled: true, writeToolsEnabled: false },
};

export const AUTH_PROVIDERS: ProviderFlags = {
  github: true,
  google: true,
  magicLink: false,
  okta: false,
};

export const LINKED_ACCOUNTS: LinkedAccount[] = [
  { accountId: '1234567', createdAt: ago(60 * 24 * 200), id: 'acct-1', providerId: 'github' },
];

const credential = (
  id: string,
  provider: string,
  lastFour: string,
  agents: string[],
  embedding = false
): ProviderCredentialRow => ({
  apiBase: null,
  createdAt: ago(60 * 24 * 60),
  createdById: VIEWER.id,
  id,
  keyVersion: 1,
  lastFour,
  maskedKey: `••••••••${lastFour}`,
  orgId: null,
  provider,
  scope: 'GLOBAL',
  teamId: null,
  updatedAt: ago(60 * 24 * 60),
  usage: { agents, embedding },
});

export const CREDENTIALS: ProviderCredentialRow[] = [
  credential('cred-1', 'anthropic', '4f2a', ['implementer', 'reviewer', 'planner']),
  credential('cred-2', 'openai', '91bc', [], true),
];

export const READINESS: Readiness = {
  gaps: [],
  items: [
    {
      detail: '2 credentials',
      href: '/models',
      id: 'credentials',
      label: 'Model credentials',
      ok: true,
    },
    {
      detail: 'openai/text-embedding-3-large',
      href: '/models?tab=embeddings',
      id: 'embeddings',
      label: 'Embeddings',
      ok: true,
    },
    {
      detail: 'Personal access token',
      href: '/admin/integrations',
      id: 'github',
      label: 'GitHub',
      ok: true,
    },
    {
      detail: '3 repositories',
      href: '/connections',
      id: 'connections',
      label: 'Connections',
      ok: true,
    },
  ],
  providers: [
    { present: true, provider: 'anthropic', required: true, usedBy: ['implementer'] },
    { present: true, provider: 'openai', required: true, usedBy: ['embeddings'] },
  ],
  ready: true,
};

const catalog = (
  provider: string,
  modelId: string,
  input: number,
  output: number,
  extra: Partial<ModelCatalogEntry> = {}
): ModelCatalogEntry => ({
  builtin: { inputUsdPerMTok: input, kind: 'CHAT', outputUsdPerMTok: output, status: 'ACTIVE' },
  cacheDefaults: {
    cacheReadMultiplier: 0.1,
    cacheWrite1hMultiplier: 2,
    cacheWrite5mMultiplier: 1.25,
  },
  cacheReadMultiplier: null,
  cacheWrite1hMultiplier: null,
  cacheWrite5mMultiplier: null,
  displayName: null,
  id: `cat-${provider}-${modelId}`,
  inputUsdPerMTok: input,
  isBuiltIn: true,
  isCustomized: false,
  kind: 'CHAT',
  modelId,
  notes: null,
  outputUsdPerMTok: output,
  provider,
  status: 'ACTIVE',
  ...extra,
});

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  catalog('anthropic', 'claude-opus-5-5', 5, 25),
  catalog('anthropic', 'claude-sonnet-5-5', 3, 15),
  catalog('anthropic', 'claude-haiku-4-5-20251001', 1, 5),
  catalog('openai', 'gpt-6.1-sol', 2.5, 12, {
    inputUsdPerMTok: 2,
    isCustomized: true,
    notes: 'Negotiated rate',
  }),
  catalog('google', 'gemini-3.8-flash', 0.3, 2.5),
  catalog('anthropic', 'claude-sonnet-4-20250514', 3, 15, { status: 'DEPRECATED' }),
  catalog('openai', 'text-embedding-3-large', 0.13, 0, {
    builtin: { inputUsdPerMTok: 0.13, kind: 'EMBEDDING', outputUsdPerMTok: 0, status: 'ACTIVE' },
    kind: 'EMBEDDING',
  }),
];

export const ROLE_PRICING: Record<string, RolePrice> = {
  implementer: { inputUsdPerMTok: 5, modelSpec: 'anthropic/claude-opus-5-5', outputUsdPerMTok: 25 },
  planner: { inputUsdPerMTok: 3, modelSpec: 'anthropic/claude-sonnet-5-5', outputUsdPerMTok: 15 },
  reviewer: { inputUsdPerMTok: 5, modelSpec: 'anthropic/claude-opus-5-5', outputUsdPerMTok: 25 },
};

export const TEMPLATE_ANALYTICS: WorkflowTemplateAnalytics = {
  agentErrorRate: 0.04,
  autonomyRate: 0.62,
  avgCostPerRun: 3.1,
  estimatedHumanTimeSavedTotal: 2340,
  failed: 4,
  humanReviewRate: 0.38,
  isTruncated: false,
  p50DurationMs: 31 * 60_000,
  p95DurationMs: 58 * 60_000,
  perOutcome: [{ outcomeType: 'pull_request', runCount: 22, totalCost: 68.2 }],
  perStepFailureRates: [{ failed: 4, failureRate: 0.15, nodeId: 'runTests', total: 26 }],
  perVersionCounts: [
    { count: 18, version: 3 },
    { count: 8, version: 2 },
  ],
  significanceHint: null,
  succeeded: 22,
  successRate: 0.85,
  totalCost: 80.6,
  totalRuns: 26,
  windowDays: 30,
};
