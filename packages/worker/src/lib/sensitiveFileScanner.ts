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
 */
export async function checkSensitiveFilePath(filePath: string): Promise<string | null> {
  const patterns = await loadSensitiveFilePatterns();
  const normalized = filePath.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;

  for (const { label, re } of patterns) {
    re.lastIndex = 0;
    if (re.test(basename) || re.test(normalized)) {
      return (
        `Write blocked: '${filePath}' matches sensitive file pattern [${label}].\n` +
        'Store secrets in environment variables or a secrets manager, not in source files.'
      );
    }
  }
  return null;
}
