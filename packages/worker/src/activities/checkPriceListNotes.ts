/**
 * The catalog refresh's price-list rule, enforced: after the review approves,
 * this compares the pushed catalog file with the one the change started from and
 * finds every added or repriced row whose figure differs from the community price
 * list without a `// price list says …` comment. A finding goes back to the
 * review fixer like a rejection, so the run either explains each difference or
 * corrects it before a pull request opens.
 *
 * It never blocks on what it cannot see: with the list turned off or unreadable
 * there is nothing to compare against, so the check passes and says why. A
 * catalog file it cannot read at either commit fails the activity (retried as
 * usual), since passing would wave through exactly the change it exists to check.
 */
import { prisma } from '@auto-swe/shared/db';
import { BUILTIN_MODELS_PATH } from '@auto-swe/shared/lib/builtinModels';
import { loadPriceList } from '@auto-swe/shared/lib/modelPriceList';
import type { CodeResult, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { ApplicationFailure } from '@temporalio/activity';
import {
  findUnnotedPriceRows,
  type UnnotedRow,
  unnotedRowsSummary,
} from '../lib/priceListNotes.js';
import { requireRepoId } from '../lib/requireRepoId.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';

export interface CheckPriceListNotesInput {
  request: RepoWorkRequest;
  codeResult: CodeResult;
}

export interface CheckPriceListNotesResult {
  ok: boolean;
  /** The fixer's finding when not ok; a fixed sentence otherwise. */
  summary: string;
  unnoted: UnnotedRow[];
}

export async function checkPriceListNotes(
  input: CheckPriceListNotesInput
): Promise<CheckPriceListNotesResult> {
  const list = await loadPriceList();
  if (!list?.ok) {
    return {
      ok: true,
      summary: list
        ? 'The community price list could not be read, so the price-list rule was not checked.'
        : 'The community price list is turned off, so the price-list rule was not checked.',
      unnoted: [],
    };
  }

  const { codeResult } = input;
  const repo = await prisma.connection.findUniqueOrThrow({
    include: { installation: { select: { host: true, installationId: true } } },
    where: { id: codeResult.repoId ?? requireRepoId(input.request, 'checkPriceListNotes') },
  });
  const repoRef = toRepoRef(repo);
  const scm = getScmProvider(repoRef);
  const baseRef = codeResult.baseSha || codeResult.baseBranch || repo.defaultBranch;
  const [base, head] = await Promise.all([
    scm.fetchFileContent(repoRef, BUILTIN_MODELS_PATH, baseRef),
    scm.fetchFileContent(repoRef, BUILTIN_MODELS_PATH, codeResult.headSha),
  ]);
  if (base === null || head === null) {
    throw ApplicationFailure.nonRetryable(
      `'${BUILTIN_MODELS_PATH}' could not be read at ${base === null ? 'the base' : 'the pushed'} commit.`,
      'CATALOG_FILE_MISSING'
    );
  }

  const unnoted = findUnnotedPriceRows(base, head, list.table);
  return unnoted.length === 0
    ? {
        ok: true,
        summary: 'Every added or repriced row matches the price list or says why not.',
        unnoted,
      }
    : { ok: false, summary: unnotedRowsSummary(unnoted), unnoted };
}
