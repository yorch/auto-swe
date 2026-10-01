/**
 * Builds the use-case pages from the built-in workflow templates.
 *
 * Imports TypeScript from `packages/shared`, so it runs under `tsx` (the `sync` script)
 * or vitest — never under bare `node`, and never from `astro.config.mjs`.
 */

import { BUILTIN_TEMPLATES } from '../../packages/shared/src/workflow/templates/index.ts';
import { siteUrl } from './manifest.mjs';
import { specToMermaid, summarizeSpec } from './templateGraph.mjs';
import {
  MATURITY,
  USE_CASE_GROUPS,
  USE_CASE_ROUTE_PREFIX,
  USE_CASES,
  useCaseSlug,
} from './useCases.mjs';

/** What a run works on, by workspace provider, in a reader's words. */
const WORKS_ON = {
  api_only: 'An external API — no workspace',
  document: 'A document (Notion)',
  git_repo: 'A git repository, cloned into an isolated Docker sandbox',
  issue_tracker: 'An issue tracker (Linear or Jira)',
  record: 'A record in an external system (Zendesk)',
};

const PERSON_VERB = {
  approval: 'approves or rejects',
  decision: 'chooses a path',
  input: 'fills in a form',
  merge: 'merges on GitHub',
  review: 'reviews and annotates',
};

/**
 * Fails when the catalogue and the templates disagree, in either direction.
 *
 * A template without an entry would ship with no public page; an entry without a
 * template would publish a page for a workflow nobody can run.
 */
export function assertCatalogueCovers(templates, catalogue) {
  const names = new Set(templates.map((t) => t.name));
  const groups = new Set(USE_CASE_GROUPS.map((g) => g.id));
  const problems = [
    ...[...names]
      .filter((name) => !catalogue[name])
      .map((name) => `  built-in template with no use-case entry: ${name}`),
    ...Object.keys(catalogue)
      .filter((name) => !names.has(name))
      .map((name) => `  use-case entry for a template that does not exist: ${name}`),
    ...Object.entries(catalogue)
      .filter(([, entry]) => !groups.has(entry.group) || !MATURITY[entry.maturity])
      .map(([name]) => `  use-case entry with an unknown group or maturity: ${name}`),
  ];
  if (problems.length > 0) {
    throw new Error(
      `The use-case catalogue is out of sync with the built-in templates.\n${problems.join('\n')}\n\n` +
        'Fix it in site/scripts/useCases.mjs (USE_CASES).'
    );
  }
}

function peopleSentence(people, workspace) {
  if (people.length === 0) {
    // True of the run, and misleading about the outcome without the second half:
    // the pull request it opens is still merged by a person, on GitHub.
    return workspace === 'git_repo'
      ? 'Nobody inside the run. The pull request it opens is merged by a person, outside it.'
      : 'Nobody inside the run.';
  }
  return people
    .map((p) => `**${p.title}** — a person ${PERSON_VERB[p.kind]}, waiting up to ${p.timeout}`)
    .join('<br/>');
}

/** Everything the landing page and the index need about one use case, as plain data. */
export function describeUseCases(templates = BUILTIN_TEMPLATES, catalogue = USE_CASES) {
  assertCatalogueCovers(templates, catalogue);
  return templates.map((template) => {
    const entry = catalogue[template.name];
    return {
      ...entry,
      facts: summarizeSpec(template.spec),
      mermaid: specToMermaid(template.spec),
      name: template.name,
      slug: useCaseSlug(template.name),
      workspace: template.workspaceProvider ?? 'git_repo',
    };
  });
}

/** Markdown for one use case's page. */
export function renderUseCasePage(useCase, { repoUrl, ref }) {
  const { facts } = useCase;
  const maturity = MATURITY[useCase.maturity];
  const waits = facts.waits.map((w) => `${w.name}, up to ${w.timeout}`).join('<br/>');

  const rows = [
    ['Template', `\`${useCase.name}\``],
    ['Works on', WORKS_ON[useCase.workspace] ?? useCase.workspace],
    ['Where a person acts', peopleSentence(facts.people, useCase.workspace)],
    waits ? ['Waits on systems', waits] : null,
    facts.agents.length > 0
      ? ['Agents it calls by name', facts.agents.map((a) => `\`${a}\``).join(', ')]
      : null,
    facts.parallel ? ['Parallel work', 'Yes — branches run concurrently'] : null,
    facts.sandboxed ? ['Container step', 'Runs a command in an ephemeral container'] : null,
  ].filter(Boolean);

  return [
    useCase.summary,
    '',
    '| | |',
    '|---|---|',
    ...rows.map(([key, value]) => `| ${key} | ${value} |`),
    '',
    '## The workflow',
    '',
    'Drawn from the template spec at build time. Bookkeeping nodes that only record ' +
      'status are left out; amber nodes are where a person acts.',
    '',
    '```mermaid',
    useCase.mermaid,
    '```',
    '',
    `## Maturity: ${maturity.label.toLowerCase()}`,
    '',
    `${maturity.text} See [product overview §8](${siteUrl('docs/product-overview')}#8-maturity).`,
    '',
    '## Use it',
    '',
    'Every built-in template is seeded into the workflow library and can be cloned, edited ' +
      'on the visual canvas, and versioned — see ' +
      `[architecture](${siteUrl('docs/architecture')}) for the node types. The spec lives in ` +
      `[\`${useCase.source}\`](${repoUrl}/blob/${ref}/${useCase.source}).`,
    '',
  ].join('\n');
}

/** Markdown for the index of all use cases. */
export function renderUseCaseIndex(useCases) {
  const sections = USE_CASE_GROUPS.map((group) => {
    const items = useCases.filter((u) => u.group === group.id);
    const lines = items.map((u) => {
      const people = u.facts.people.length;
      const stops =
        people === 0
          ? 'no person inside the run'
          : `${people} place${people === 1 ? '' : 's'} a person acts`;
      return `| [${u.title}](${siteUrl(u.slug)}) | ${stops} | ${MATURITY[u.maturity].label} |`;
    });
    return [
      `## ${group.label}`,
      '',
      group.intro,
      '',
      '| Use case | Stops for people | Maturity |',
      '|---|---|---|',
      ...lines,
      '',
    ].join('\n');
  });

  return [
    `Every workflow below ships with auto-swe as a built-in template. Each page is generated ` +
      `from the template's own spec, so its diagram and its list of human steps are what ` +
      `the run actually does. ${useCases.length} templates, one engine: a team that needs ` +
      'something else authors its own on the same nodes.',
    '',
    ...sections,
  ].join('\n');
}

export { USE_CASE_ROUTE_PREFIX };
