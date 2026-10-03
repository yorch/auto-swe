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
 *  - the output is `{ guidance, previousRefreshOpen }` and nothing else, since the
 *    output is recorded in Temporal history and bound into the implementer's prompt.
 *
 * Before any of that — before a workspace exists, and before a credential is read —
 * it checks the repository: the catalog file must be there, and a previous refresh's
 * branch or open pull request must not be, so a fork that lacks the file or still has
 * last run's work open costs nothing.
 */
import { prisma } from '@auto-swe/shared/db';
import { BUILTIN_MODELS_PATH } from '@auto-swe/shared/lib/builtinModels';
import { decryptSecret } from '@auto-swe/shared/lib/crypto';
import { listProviderModels as listProviderModelsLive } from '@auto-swe/shared/lib/modelDiscovery';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { ApplicationFailure, log } from '@temporalio/activity';
import { requireRepoId } from '../lib/requireRepoId.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';

const CATALOG_MARKER = 'export const BUILTIN_MODELS';

export const PREVIOUS_REFRESH_OPEN_NOTE =
  'A previous catalog refresh is still open; merge or close it and delete its branch.';

export interface ListProviderModelsInput {
  request: RepoWorkRequest;
}

export interface ListProviderModelsResult {
  guidance: string;
  /** True when last run's branch or pull request is still there; the run ends without work. */
  previousRefreshOpen: boolean;
  note?: string;
}

/** The providers the catalog file already prices, read from its `provider: '…'` fields. */
function providersInCatalog(source: string): Set<string> {
  return new Set([...source.matchAll(/\bprovider:\s*'([a-z0-9._-]+)'/g)].map((m) => m[1] ?? ''));
}

/**
 * An id with a colon names a fine-tune or an organization's own model
 * (`ft:gpt-…:acme:…`): private to the credential's owner, and not something a public
 * catalog may carry or the agent be told about.
 */
const isPublicModelId = (id: string): boolean => !id.includes(':');

export async function listProviderModels(
  input: ListProviderModelsInput
): Promise<ListProviderModelsResult> {
  const catalogPath = BUILTIN_MODELS_PATH;

  // Precondition, before any workspace: the file this run exists to edit is there.
  const repo = await prisma.connection.findUniqueOrThrow({
    include: { installation: { select: { installationId: true } } },
    where: { id: requireRepoId(input.request, 'listProviderModels') },
  });
  const repoRef = toRepoRef(repo);
  const scm = getScmProvider(repoRef);
  const source = await scm.fetchFileContent(repoRef, catalogPath);
  if (source === null) {
    throw ApplicationFailure.nonRetryable(
      `${repo.organizationName}/${repo.repoName} has no file at '${catalogPath}'. Point the ` +
        'run at a repository that holds the built-in model catalog, such as a fork of auto-swe.',
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

  // A schedule fires with the same ticket id, so every firing wants the same branch.
  // If the last one's branch or pull request is still there, this run would collide
  // with it (or push onto it): stop here, before any credential, workspace or agent.
  const branch = `${(await resolveWorkflowDefaults()).branchPrefix}/${input.request.externalTicketId}`;
  const work = await scm.findBranchWork(repoRef, branch);
  if (work.branchExists || work.openPr) {
    return { guidance: '', note: PREVIOUS_REFRESH_OPEN_NOTE, previousRefreshOpen: true };
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
        const bullets = (ids: Iterable<string>) =>
          [...new Set(ids)]
            .filter(isPublicModelId)
            .sort()
            .map((id) => `- ${id}`)
            .join('\n');
        const candidates = `Text and embedding models to consider adding if the catalog lacks them:\n\n${bullets(listed.models.map((m) => m.modelId))}`;
        // Retirement is judged against everything the provider lists, not the
        // filtered candidates: a catalog model the name filter drops is still served.
        const retirement = listed.complete
          ? `Every id the provider still lists. Retire a catalog row only if its id is missing from this list:\n\n${bullets(listed.listedIds)}`
          : 'This listing may be incomplete: do not mark any model RETIRED.';
        return `### ${label}\n\n${candidates}\n\n${retirement}`;
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
      : `${header}\n\nModel ids each provider lists right now, fetched by the platform.\n\n${sections.join('\n\n')}`;
  return { guidance, previousRefreshOpen: false };
}
