#!/usr/bin/env node
/**
 * Generates the capability matrix in `docs/permissions.md` from the catalog under
 * `packages/shared/src/permissions/catalog/`.
 *
 *   node scripts/gen-permissions-doc.mjs           rewrite the matrix between the markers
 *   node scripts/gen-permissions-doc.mjs --check   exit 1 when the committed matrix is stale
 *
 * Dependency-free (see `permissions-catalog.mjs`), so `yarn docs:check` runs it before an install.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCatalog, loadConstraints, renderMatrix } from './permissions-catalog.mjs';

export const DOC = 'docs/permissions.md';
export const START = '<!-- permissions:matrix:start -->';
export const END = '<!-- permissions:matrix:end -->';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `doc` with the matrix between the markers replaced by the one generated from `root`. */
export function withMatrix(doc, root) {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`${DOC} needs ${START} and ${END}, in that order`);
  }
  const matrix = renderMatrix(loadCatalog(root), loadConstraints(root));
  return `${doc.slice(0, start + START.length)}\n\n${matrix}\n\n${doc.slice(end)}`;
}

/**
 * Why the committed matrix is stale, or `null` when it is current. A missing doc is stale, except
 * under a fixture root, where the docs tree is a stand-in.
 */
export function matrixDrift(root, { allowMissingDoc = false } = {}) {
  const path = join(root, DOC);
  if (!existsSync(path)) {
    return allowMissingDoc ? null : `${DOC} does not exist`;
  }
  const current = readFileSync(path, 'utf8');
  let expected;
  try {
    expected = withMatrix(current, root);
  } catch (error) {
    return error.message;
  }
  return expected === current
    ? null
    : `the capability matrix in ${DOC} differs from the catalog; run \`node scripts/gen-permissions-doc.mjs\``;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const check = process.argv.includes('--check');
  if (check) {
    const drift = matrixDrift(REPO);
    if (drift) {
      console.error(drift);
      process.exit(1);
    }
    console.log('Permissions matrix is current.');
  } else {
    const path = join(REPO, DOC);
    writeFileSync(path, withMatrix(readFileSync(path, 'utf8'), REPO));
    console.log(`Wrote the capability matrix to ${DOC}.`);
  }
}
