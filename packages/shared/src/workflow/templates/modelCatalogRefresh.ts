import { type Node, SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  initCounters,
  mergeNodes,
  openPullRequest,
  prResult,
  qualityGate,
  reviewLoop,
  statusStamp,
  terminate,
} from './authoring/index.js';

type StepNode = Extract<Node, { type: 'step' }>;

/**
 * The criteria the reviewers hold the change to. Exported so the template's test
 * can assert the sentence the design depends on is the one that ships.
 */
export const MODEL_CATALOG_REFRESH_CRITERIA = [
  'Every changed price cites an official URL; no invented figures.',
  'A price that is not literally on the fetched official pricing page leaves its row unchanged, ' +
    'marked UNVERIFIED in a comment on that row.',
  'Only providers already present in BUILTIN_MODELS are touched, and no price changes outside a ' +
    'row whose source page was fetched in this run.',
  'Every row keeps an https priceSourceUrl on its provider pricing host, and no row is deleted.',
];

/** Run by the `runTests` gate: installs (a no-op when already installed), then the one test file. */
export const MODEL_CATALOG_REFRESH_TEST_COMMAND =
  'yarn install --immutable && yarn vitest run packages/shared/src/lib/builtinModels.test.ts';

export const MODEL_CATALOG_REFRESH_PROMPT = `You maintain the built-in model price table of a repository: the \`BUILTIN_MODELS\` array in the catalog file named under "Live model ids" in your guidance. Bring it in line with what the providers list and publish, and never invent a figure. A person reviews your draft pull request, and every price you change is checked against the source you cite.

PROCEDURE
1. Read the catalog file. Its header cites the official pricing page of each provider; every row has a \`priceSourceUrl\`.
2. Model ids. Use only the ids in your guidance; you have no API keys and must not look for any. A provider whose section says the listing failed keeps its ids exactly as they are. A listed id that has no row is a candidate for a new row (kind CHAT, or EMBEDDING for an embedding model). An ACTIVE row whose id a complete listing no longer includes becomes status 'RETIRED'; never delete a row, and never retire on a listing the guidance calls incomplete.
3. Prices, only for providers already present in the file. There is no curl in this workspace: fetch each provider's pricing page from the header with node, and strip the HTML, for example
   node -e "fetch(process.argv[1]).then(r=>r.text()).then(t=>console.log(t.replace(/<[^>]*>/g,' ')))" <url> | tr -s '[:space:]' ' ' > /tmp/page.txt
   then search the text (grep -o with context) for each model name. Prices are USD per million tokens at base (non-cached, non-batch) rates.
4. A figure is verified only if it appears literally in the text you fetched in this run, beside that model. If it does not: leave that row unchanged (or, for a new model, add no row), and put a comment \`// UNVERIFIED: <what you could not confirm> (<page url>)\` on that row so the reviewer sees it in the diff. Remove an UNVERIFIED comment once a run verifies the figure. Uncertain is never "close enough": do not round, convert, infer from a sibling model, or recall a price from memory.
5. For every row you add or whose price you change, set \`priceSourceUrl\` to the provider's pricing page from the header (an https URL on that host) and keep the keys in the file's sorted order.
6. Run \`yarn vitest run packages/shared/src/lib/builtinModels.test.ts\` and make it pass. If nothing needs to change, change nothing: an empty diff is a correct result.

CONSTRAINTS
- Only edit the catalog file, and only the rows in question.
- Do not touch a provider that is not already in the file, and do not change any price you did not verify.
- Do not add dependencies or modify unrelated files.`;

/**
 * Keeps auto-swe's own built-in model catalog current. Run it against your fork of
 * auto-swe, by hand or on a schedule (a `ScheduledWorkRequest`). The run ends at a
 * DRAFT pull request: no CI loop, and no approval inside the run. The draft and the
 * sources it cites are the control, and a person merges.
 *
 * Model ids are listed by the platform itself (`listProviderModels`), because only
 * the worker may hold provider keys; the agent reads the pricing pages in its
 * workspace. A run that changes nothing ends SUCCESS without a pull request.
 */
export const MODEL_CATALOG_REFRESH_SPEC: WorkflowSpec = {
  description:
    "Keep the built-in model catalog current: list each provider's live model ids through the " +
    'platform, read the official pricing pages, update BUILTIN_MODELS with a cited source for every ' +
    'changed price, and open a DRAFT pull request for a person to review. Uncertain figures are ' +
    'left unchanged and called out. A run with nothing to change opens no pull request. ' +
    'Point it at your auto-swe fork and schedule it.',
  entry: 'setCriteria',
  name: 'model-catalog-refresh',
  nodes: mergeNodes(
    {
      setCriteria: {
        group: 'prepare',
        next: 'listModels',
        title: 'Set the success criteria',
        type: 'set',
        values: { 'context.successCriteria': { literal: MODEL_CATALOG_REFRESH_CRITERIA } },
      },
      // Fails here, before any workspace exists, when the repository has no catalog file.
      listModels: {
        group: 'prepare',
        next: 'setImplementing',
        step: 'listProviderModels',
        title: 'List the live model ids',
        type: 'step',
      },
      setImplementing: statusStamp('IMPLEMENTING', 'implement', { group: 'implement' }),
      implement: {
        config: { systemPrompt: MODEL_CATALOG_REFRESH_PROMPT },
        group: 'implement',
        inputs: { guidance: { from: 'nodes.listModels.output.guidance' } },
        next: 'checkChanges',
        step: 'executeImplementation',
        title: 'Update the catalog',
        type: 'step',
      },
      checkChanges: {
        expr: 'nodes.implement.output.filesChanged.length == 0',
        group: 'implement',
        onFalse: 'initCounters',
        onTrue: 'doneNoChange',
        title: 'Anything changed?',
        type: 'cond',
      },
      initCounters: initCounters('runTests', { ci: false, group: 'implement' }),
      runTests: {
        ...(qualityGate('runTests', 'setReviewing', { group: 'verify' }) as StepNode),
        config: { command: MODEL_CATALOG_REFRESH_TEST_COMMAND },
      },
    },
    reviewLoop({ approved: 'openPR' }),
    openPullRequest({ draft: true, next: 'done' }),
    {
      done: terminate('SUCCESS', { group: 'finish', result: prResult(), title: 'Draft PR opened' }),
      // No group: a second terminal in `finish` would split that group in two pieces.
      doneNoChange: terminate('SUCCESS', {
        result: { changed: { literal: false } },
        title: 'Catalog already current',
      }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
