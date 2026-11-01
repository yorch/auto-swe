/**
 * Run every stored connection's own check and report them together: the five integrations
 * (GitHub, Slack, issue tracker, knowledge base, Figma), each per-host GitHub credential, the
 * approver App, every active package registry and every model-provider key.
 *
 * Each entry is the same check its own "Test connection" button runs, so the answer here and on
 * the integration's page cannot disagree. A connection that is not configured is `skipped`, not
 * `failed`: an unused integration is not a fault. A check that throws is a failed entry rather
 * than a failed request, so one broken connection never hides the rest.
 *
 * Not covered: MCP servers (each is tested on its own page, and a probe can take a minute) and a
 * repository's access (a per-repository question; ask it from the repository).
 */
import type { PrismaClient } from '@auto-swe/shared';
import {
  resolveFigmaConfig,
  resolveGitHubApproverAppConfig,
  resolveGitHubConfig,
  resolveIssueTrackerConfig,
  resolveKnowledgeBaseConfig,
  resolveSlackConfig,
} from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { probeApproverApp, probeHostCredential, probeRegistryRow } from './connectionProbes.js';
import { testStoredCredential } from './credentialService.js';
import {
  testFigmaConnection,
  testGitHubConnection,
  testIssueTrackerConnection,
  testKnowledgeBaseConnection,
  testSlackConnection,
} from './systemConfigService.js';

export type HealthStatus = 'ok' | 'failed' | 'skipped';

export interface HealthEntry {
  id: string;
  group: 'integration' | 'github-host' | 'registry' | 'model-provider';
  label: string;
  status: HealthStatus;
  detail: string;
  durationMs: number;
  /** The studio page where this connection is configured. */
  href: string;
}

type Outcome = { ok: boolean; detail: string } | { skipped: string };
type Meta = Pick<HealthEntry, 'id' | 'group' | 'label' | 'href'>;

async function entry(meta: Meta, run: () => Promise<Outcome>): Promise<HealthEntry> {
  const startedAt = Date.now();
  try {
    const outcome = await run();
    if ('skipped' in outcome) {
      return { ...meta, detail: outcome.skipped, durationMs: 0, status: 'skipped' };
    }
    return {
      ...meta,
      detail: outcome.detail,
      durationMs: Date.now() - startedAt,
      status: outcome.ok ? 'ok' : 'failed',
    };
  } catch {
    return {
      ...meta,
      detail: 'The check could not run.',
      durationMs: Date.now() - startedAt,
      status: 'failed',
    };
  }
}

const NOT_CONFIGURED = { skipped: 'Not configured.' } as const;

export interface CheckAllOptions {
  /** A real ticket the tracker check fetches; without one the tracker is skipped. */
  trackerTicketId?: string;
}

export async function checkAllConnections(
  prisma: PrismaClient,
  options: CheckAllOptions = {}
): Promise<HealthEntry[]> {
  const integrations = '/admin/integrations';
  const [hostRows, registries, credentials, approver] = await Promise.all([
    prisma.gitHubHostCredential.findMany({ orderBy: { host: 'asc' } }),
    // Platform admins see every team's registries — a deliberate cross-team read, as in the listing.
    runUnscoped(
      'connection health check of package registries across teams',
      ['PackageRegistry'],
      () => prisma.packageRegistry.findMany({ orderBy: { name: 'asc' }, where: { isActive: true } })
    ),
    runUnscoped(
      'connection health check of model-provider keys across teams',
      ['ProviderCredential'],
      () => prisma.providerCredential.findMany({ orderBy: [{ provider: 'asc' }, { scope: 'asc' }] })
    ),
    prisma.gitHubApproverApp.findUnique({ where: { id: 'default' } }),
  ]);

  const checks: Array<Promise<HealthEntry>> = [
    entry({ group: 'integration', href: integrations, id: 'github', label: 'GitHub' }, async () => {
      const config = await resolveGitHubConfig();
      if (!(config.token || (config.appId && config.appPrivateKey))) {
        return NOT_CONFIGURED;
      }
      return testGitHubConnection();
    }),
    entry({ group: 'integration', href: integrations, id: 'slack', label: 'Slack' }, async () =>
      (await resolveSlackConfig()).botToken ? testSlackConnection() : NOT_CONFIGURED
    ),
    entry(
      { group: 'integration', href: integrations, id: 'issue-tracker', label: 'Issue tracker' },
      async () => {
        const config = await resolveIssueTrackerConfig();
        if (!config.provider) {
          return NOT_CONFIGURED;
        }
        if (!options.trackerTicketId) {
          return { skipped: 'Needs a real ticket id to fetch; pass one to check it.' };
        }
        return testIssueTrackerConnection(options.trackerTicketId);
      }
    ),
    entry(
      { group: 'integration', href: integrations, id: 'knowledge-base', label: 'Knowledge base' },
      async () => {
        const config = await resolveKnowledgeBaseConfig();
        return config.provider && config.enabled ? testKnowledgeBaseConnection() : NOT_CONFIGURED;
      }
    ),
    entry({ group: 'integration', href: integrations, id: 'figma', label: 'Figma' }, async () => {
      const config = await resolveFigmaConfig();
      return config.enabled ? testFigmaConnection() : NOT_CONFIGURED;
    }),
    ...(approver?.appId
      ? [
          entry(
            {
              group: 'integration',
              href: integrations,
              id: 'github-approver-app',
              label: 'GitHub approver App',
            },
            async () => {
              // A row with an id but no slug or key is half-configured, which is a fault to show.
              if (!(await resolveGitHubApproverAppConfig().catch(() => null))) {
                return { detail: 'The approver App is not fully configured.', ok: false };
              }
              return probeApproverApp();
            }
          ),
        ]
      : []),
    ...hostRows.map((row) =>
      entry(
        {
          group: 'github-host',
          href: integrations,
          id: `github-host:${row.id}`,
          label: `GitHub host ${row.host}`,
        },
        () => probeHostCredential(row.host)
      )
    ),
    ...registries.map((row) =>
      entry(
        {
          group: 'registry',
          href: integrations,
          id: `registry:${row.id}`,
          label: `${row.ecosystem} registry ${row.name}`,
        },
        () => probeRegistryRow(row)
      )
    ),
    ...credentials.map((row) =>
      entry(
        {
          group: 'model-provider',
          href: '/models',
          id: `model-provider:${row.id}`,
          label: `${row.provider} key ····${row.lastFour} (${row.scope.toLowerCase()})`,
        },
        async () => {
          const result = await testStoredCredential(row);
          return result.ok
            ? { detail: 'The provider accepted the key.', ok: true }
            : {
                detail: result.status
                  ? `The provider returned ${result.status}.`
                  : `The provider could not be reached (${result.error ?? 'request failed'}).`,
                ok: false,
              };
        }
      )
    ),
  ];
  return Promise.all(checks);
}
