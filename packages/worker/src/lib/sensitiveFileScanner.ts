import {
  type RegexTarget,
  resolveRegexBudgetMs,
  runRegexBatch,
  toRegexSpecs,
} from '@auto-swe/shared/lib/regexExec';
import { chunkScanText } from '@auto-swe/shared/lib/regexSafety';
import { makePatternLoader } from './scannerPatternLoader.js';

const { load: loadSensitiveFilePatterns, invalidate } = makePatternLoader(
  'SENSITIVE_FILE',
  'sensitiveFileScanner'
);

export { invalidate as invalidateSensitiveFilePatternCache };

interface SensitiveFileScan {
  /** Index (into the caller's path list) of the earliest matching path, if any. */
  hitIndex: number | null;
  hitPatternKey: string | null;
  incomplete: boolean;
}

/**
 * Runs every candidate path through the SENSITIVE_FILE patterns in ONE
 * `runRegexBatch` call, regardless of how many paths are given — each pattern
 * is tested against both the basename and the full normalized path of every
 * path, so rules work regardless of directory depth. Shared by the single-path
 * check below and by `scanShellCommand`, which otherwise paid one serialized
 * round trip per write target it found in a command.
 */
async function scanSensitiveFilePaths(filePaths: string[]): Promise<SensitiveFileScan> {
  const patterns = await loadSensitiveFilePatterns();
  const targets: RegexTarget[] = [];
  filePaths.forEach((filePath, i) => {
    const normalized = filePath.replace(/\\/g, '/');
    const basename = normalized.split('/').pop() ?? normalized;
    for (const [j, text] of chunkScanText(basename).entries()) {
      targets.push({ key: `${i}:base:${j}`, text });
    }
    for (const [j, text] of chunkScanText(normalized).entries()) {
      targets.push({ key: `${i}:path:${j}`, text });
    }
  });

  const budgetMs = await resolveRegexBudgetMs();
  const { hits, incomplete } = await runRegexBatch(toRegexSpecs(patterns), targets, {
    budgetMs,
    label: 'sensitiveFileScanner',
  });

  let hitIndex: number | null = null;
  let hitPatternKey: string | null = null;
  for (const hit of hits) {
    const index = Number(hit.targetKey.split(':')[0]);
    if (hitIndex === null || index < hitIndex) {
      hitIndex = index;
      hitPatternKey = hit.patternKey;
    }
  }
  return { hitIndex, hitPatternKey, incomplete };
}

/**
 * Checks a file path against DB-backed SENSITIVE_FILE patterns.
 * Returns a block message if the path matches, null if clean.
 * Each pattern is tested against both the basename and the full normalized path
 * so rules work regardless of directory depth.
 *
 * Blocking scanner: patterns run under the executor's wall-clock budget, and a
 * scan that cannot complete blocks the write rather than waving it through.
 * Both candidate strings are covered in full (in overlapping windows for an
 * absurdly long path) — truncating either would be a place to hide a suffix.
 */
export async function checkSensitiveFilePath(filePath: string): Promise<string | null> {
  const { hitPatternKey, incomplete } = await scanSensitiveFilePaths([filePath]);
  if (hitPatternKey) {
    return (
      `Write blocked: '${filePath}' matches sensitive file pattern [${hitPatternKey}].\n` +
      'Store secrets in environment variables or a secrets manager, not in source files.'
    );
  }
  if (incomplete) {
    return (
      `Write blocked: the sensitive-file scan of '${filePath}' could not complete.\n` +
      'A scanner pattern exceeded its execution budget, so the path could not be ' +
      'cleared. Retry; if this persists, an administrator must fix the offending ' +
      'pattern at /admin/scanner.'
    );
  }
  return null;
}

/**
 * Checks several write-target paths against the SENSITIVE_FILE policy in a
 * SINGLE round trip through the regex executor, instead of one call per path.
 * Returns the earliest (by input order) blocked path, or null when every path
 * is clean. Fails closed exactly like {@link checkSensitiveFilePath}: a scan
 * that cannot complete blocks — since a combined batch can't attribute an
 * incomplete result to one specific path, it conservatively reports the first.
 */
export async function checkSensitiveFilePaths(filePaths: string[]): Promise<string | null> {
  if (filePaths.length === 0) {
    return null;
  }
  const { hitIndex, incomplete } = await scanSensitiveFilePaths(filePaths);
  if (incomplete) {
    return filePaths[0] ?? null;
  }
  return hitIndex === null ? null : (filePaths[hitIndex] ?? null);
}
