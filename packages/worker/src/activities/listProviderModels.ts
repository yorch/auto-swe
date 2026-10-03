/**
 * The model-id half of the `model-catalog-refresh` template: lists the models each
 * provider offers, through the GLOBAL provider credentials, and hands the agent a
 * markdown list of ids. The agent's workspace never holds a key — decryption and
 * the provider calls happen here, in the worker process, and the only thing that
 * leaves is text built from model ids and fixed wording.
 *
 * Two rules keep it that way:
 *  - the step's output, its logs and its failures never carry a provider error
 *    string, because a transport error can quote the request (a header value, URL
 *    userinfo). A failed provider is reported in fixed words, nothing else;
 *  - the output is `{ guidance }` and nothing else, since the output is recorded
 *    in Temporal history and bound into the implementer's prompt.
 *
 * Before any of that — before a workspace exists — it checks the file the run is
 * about to edit, so a fork that moved or lacks the catalog fails here, cheaply.
 */
import { prisma } from '@auto-swe/shared/db';
import { decryptSecret } from '@auto-swe/shared/lib/crypto';
import { listProviderModels as listProviderModelsLive } from '@auto-swe/shared/lib/modelDiscovery';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { ApplicationFailure, log } from '@temporalio/activity';
import { requireRepoId } from '../lib/requireRepoId.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';

export const DEFAULT_CATALOG_PATH = 'packages/shared/src/lib/builtinModels.ts';
const CATALOG_MARKER = 'export const BUILTIN_MODELS';

export interface ListProviderModelsInput {
  request: RepoWorkRequest;
  /** Repo-relative path of the catalog file. Defaults to {@link DEFAULT_CATALOG_PATH}. */
  catalogPath?: string;
}

export interface ListProviderModelsResult {
  guidance: string;
}

function validCatalogPath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.split('/').includes('..');
}

/** The providers the catalog file already prices, read from its `provider: '…'` fields. */
function providersInCatalog(source: string): Set<string> {
  return new Set([...source.matchAll(/\bprovider:\s*'([a-z0-9._-]+)'/g)].map((m) => m[1] ?? ''));
}

export async function listProviderModels(
  input: ListProviderModelsInput
): Promise<ListProviderModelsResult> {
  const catalogPath = input.catalogPath ?? DEFAULT_CATALOG_PATH;
  if (!validCatalogPath(catalogPath)) {
    throw ApplicationFailure.nonRetryable(
      `catalogPath '${catalogPath}' must be a path inside the repository.`,
      'CATALOG_PATH_INVALID'
    );
  }

  // Precondition, before any workspace: the file this run exists to edit is there.
  const repo = await prisma.connection.findUniqueOrThrow({
    include: { installation: { select: { installationId: true } } },
    where: { id: requireRepoId(input.request, 'listProviderModels') },
  });
  const repoRef = toRepoRef(repo);
  const source = await getScmProvider(repoRef).fetchFileContent(repoRef, catalogPath);
  if (source === null) {
    throw ApplicationFailure.nonRetryable(
      `${repo.organizationName}/${repo.repoName} has no file at '${catalogPath}'. Point the ` +
        'run at a repository that holds the built-in model catalog (a fork of auto-swe), or set ' +
        '`catalogPath` on this step if it lives elsewhere.',
      'CATALOG_FILE_MISSING'
    );
  }
  if (!source.includes(CATALOG_MARKER)) {
    throw ApplicationFailure.nonRetryable(
      `'${catalogPath}' in ${repo.organizationName}/${repo.repoName} does not contain ` +
        `'${CATALOG_MARKER}', so it is not the built-in model catalog.`,
      'CATALOG_FILE_INVALID'
    );
  }

  const known = providersInCatalog(source);
  const credentials = (
    await runUnscoped(
      'the catalog refresh lists models through the GLOBAL provider credentials',
      ['ProviderCredential'],
      () =>
        prisma.providerCredential.findMany({
          orderBy: { provider: 'asc' },
          where: { scope: 'GLOBAL' },
        })
    )
  ).filter((c) => known.has(c.provider));

  const sections = await Promise.all(
    credentials.map(async (cred): Promise<string> => {
      // Only providers named in the catalog file reach here, and `providersInCatalog`
      // matches `[a-z0-9._-]+`, so the name is a plain token, never admin-entered text.
      const label = cred.provider;
      const failed = `### ${label}\n\nListing failed. Leave this provider's model ids as they are.`;
      try {
        const apiKey = decryptSecret({
          authTag: cred.apiKeyAuthTag,
          ciphertext: cred.apiKeyCiphertext,
          keyVersion: cred.keyVersion,
          nonce: cred.apiKeyNonce,
        });
        const listed = await listProviderModelsLive({
          apiBase: cred.apiBase,
          apiKey,
          provider: cred.provider,
        });
        if (!listed.ok) {
          // The error string is deliberately dropped: it is provider/transport text.
          log.warn('catalog refresh: provider listing failed', { provider: label });
          return failed;
        }
        const ids = [...new Set(listed.models.map((m) => m.modelId))].sort();
        const note = listed.complete
          ? ''
          : '\nThis listing may be incomplete: do not mark a model RETIRED because it is absent.\n';
        return `### ${label}\n${note}\n${ids.map((id) => `- ${id}`).join('\n')}`;
      } catch {
        // Decryption or an unexpected throw: nothing about it is safe to repeat.
        log.warn('catalog refresh: provider listing failed', { provider: label });
        return failed;
      }
    })
  );

  const header = `## Live model ids\n\nCatalog file: \`${catalogPath}\`.`;
  const guidance =
    sections.length === 0
      ? `${header}\n\nNo provider credential is configured for the providers in the catalog, so no ` +
        'live model ids are available. Leave the catalog rows as they are.'
      : `${header}\n\nModel ids each provider lists right now, fetched by the platform. ` +
        `Use them to find models missing from the catalog and catalog models no longer listed.\n\n` +
        sections.join('\n\n');
  return { guidance };
}
