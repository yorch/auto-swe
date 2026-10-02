#!/usr/bin/env node
/** Manual review attestation, never invoked by sync/build or CI. Read the skill first. */
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildExplorerData,
  EXPLORER_ROOT,
  fingerprintCode,
  REPO_ROOT,
  readAnalysis,
  uncommittedCodePaths,
} from './platformExplorer.mjs';

const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
}).trim();
if (process.argv.length !== 3 || process.argv[2] !== commit) {
  throw new Error(
    'Pass the full current HEAD commit after reviewing the analysis against code. ' +
      'See .claude/skills/platform-explorer/SKILL.md; this command does not perform that review.'
  );
}
const dirty = uncommittedCodePaths();
if (dirty.length > 0) {
  throw new Error(`Commit platform code before attesting its review: ${dirty.join(', ')}`);
}
const analysis = await readAnalysis();
const codeHashes = await fingerprintCode();
const sourceHashes = {};
for (const { path } of analysis.sources) {
  if (!codeHashes[path]) {
    throw new Error(`Evidence must name a tracked code file: ${path}`);
  }
  sourceHashes[path] = codeHashes[path];
}
const reviewed = { ...analysis, codeHashes, reviewedCommit: commit, sourceHashes };
await buildExplorerData({ analysis: reviewed, commit });
await writeFile(
  join(EXPLORER_ROOT, 'analysis.json'),
  `${JSON.stringify(reviewed, null, 2)}\n`,
  'utf8'
);
console.log(
  `Recorded narrative review at ${commit}. This is a manual attestation, not a test result.`
);
