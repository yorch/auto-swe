import { runRegexBatch } from '@auto-swe/shared/lib/regexExec';
import { chunkScanText } from '@auto-swe/shared/lib/regexSafety';
import { makePatternLoader } from './scannerPatternLoader.js';

const { load: loadSensitiveFilePatterns, invalidate } = makePatternLoader(
  'SENSITIVE_FILE',
  'sensitiveFileScanner'
);

export { invalidate as invalidateSensitiveFilePatternCache };

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
  const patterns = await loadSensitiveFilePatterns();
  const normalized = filePath.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;

  const targets = [
    ...chunkScanText(basename).map((text, i) => ({ key: `base:${i}`, text })),
    ...chunkScanText(normalized).map((text, i) => ({ key: `path:${i}`, text })),
  ];
  const { hits, incomplete } = await runRegexBatch(
    patterns.map((p) => ({ flags: p.flags, key: p.label, source: p.source })),
    targets,
    { label: 'sensitiveFileScanner' }
  );

  const hit = hits[0];
  if (hit) {
    return (
      `Write blocked: '${filePath}' matches sensitive file pattern [${hit.patternKey}].\n` +
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
