/**
 * Reads the capability catalog and renders the reference matrix, with no dependencies.
 *
 * The catalog is TypeScript, but each domain file is one `defineCapabilities({ … })` call over a
 * plain object literal, so the object is cut out of the source text and evaluated as JavaScript.
 * That keeps `yarn docs:check` runnable before `yarn install`, as the CI docs job runs it.
 * `packages/shared/src/permissions/docGenerator.test.ts` pins this reader to the real catalog, so a
 * catalog file whose shape the reader cannot follow fails a test rather than rendering a wrong doc.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const PERMISSIONS_DIR = 'packages/shared/src/permissions';

/** Domain files in catalog order, with the heading each is rendered under. */
export const CATALOG_FILES = [
  { file: 'platform.ts', heading: 'Platform' },
  { file: 'org.ts', heading: 'Organization' },
  { file: 'teams.ts', heading: 'Teams' },
  { file: 'repos.ts', heading: 'Repositories' },
  { file: 'templates.ts', heading: 'Templates, knowledge and lessons' },
  { file: 'runs.ts', heading: 'Runs and approvals' },
  { file: 'automations.ts', heading: 'Automations, reports and review' },
];

function evaluate(source, label) {
  try {
    return runInNewContext(`(${source})`, Object.create(null), { timeout: 1000 });
  } catch (error) {
    throw new Error(`could not read ${label} as a literal: ${error.message}`);
  }
}

/** The object literal inside `defineCapabilities({ … })`. */
function catalogLiteral(source, label) {
  const start = source.indexOf('defineCapabilities(');
  const end = source.lastIndexOf('});');
  if (start < 0 || end < 0) {
    throw new Error(`${label} has no defineCapabilities({ … }) call`);
  }
  return source.slice(source.indexOf('{', start), end + 1);
}

/** Every capability, grouped by domain file: `[{ heading, entries: [[key, def], …] }, …]`. */
export function loadCatalog(root) {
  return CATALOG_FILES.map(({ file, heading }) => {
    const label = `${PERMISSIONS_DIR}/catalog/${file}`;
    const defs = evaluate(catalogLiteral(readFileSync(join(root, label), 'utf8'), label), label);
    return { entries: Object.entries(defs), heading };
  });
}

/** The constraints list from `constraints.ts`. */
export function loadConstraints(root) {
  const label = `${PERMISSIONS_DIR}/constraints.ts`;
  const source = readFileSync(join(root, label), 'utf8');
  const start = source.indexOf('export const CONSTRAINTS');
  const open = source.indexOf('= [', start);
  const end = source.indexOf('\n];', open);
  if (start < 0 || open < 0 || end < 0) {
    throw new Error(`${label} has no CONSTRAINTS array`);
  }
  return evaluate(source.slice(open + 2, end + 2), label);
}

/** Whether the team must be active, as `requiresActiveTeam` in `can.ts` decides. */
export function needsActiveTeam(def) {
  return def.requiresActiveTeam ?? def.class !== 'read';
}

/** Whether an org role can confer the capability, as `orgRuleApplies` in `can.ts` decides. */
export function orgConfers(def) {
  return (
    def.org !== undefined &&
    (def.scope !== 'team' || def.class === 'governance' || def.class === 'read')
  );
}

const cell = (text) => text.replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();

/** The matrix: one table per domain, then the constraints. */
export function renderMatrix(groups, constraints) {
  const out = [];
  out.push(
    '_Generated from `packages/shared/src/permissions/catalog/` by `scripts/gen-permissions-doc.mjs`. Do not edit between the markers._',
    ''
  );
  for (const { heading, entries } of groups) {
    out.push(
      `### ${heading}`,
      '',
      '| Capability | Scope | Class | Team role | Org role | Platform admin | Needs active team | Allows |',
      '|---|---|---|---|---|---|---|---|'
    );
    for (const [key, def] of entries) {
      const team = def.team ?? '—';
      const org = orgConfers(def) ? def.org : '—';
      const admin = def.platformAdmin === false ? 'no' : 'yes';
      const active = def.scope === 'team' || def.team ? (needsActiveTeam(def) ? 'yes' : 'no') : '—';
      out.push(
        `| \`${key}\` | ${def.scope} | ${def.class} | ${team} | ${org} | ${admin} | ${active} | ${cell(def.description)} |`
      );
    }
    out.push('');
  }
  out.push('### Constraints', '', '| Constraint | Applies beside | Rule |', '|---|---|---|');
  for (const c of constraints) {
    const beside = c.accompanies.map((k) => `\`${k}\``).join(', ');
    out.push(`| \`${c.name}\` | ${beside} | ${cell(c.description)} |`);
  }
  return out.join('\n');
}
