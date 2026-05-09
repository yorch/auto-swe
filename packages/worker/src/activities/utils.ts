import type { FileChange, TestRunResult } from '@auto-swe/shared/types/workflow';

/**
 * Detect the test command from a package.json string.
 * Returns the most appropriate test runner command based on the project's
 * scripts and devDependencies. Falls back to 'npm test' if no recognizable
 * test script is found.
 */
export function detectTestCommand(packageJsonStr: string): string {
  try {
    const pkg = JSON.parse(packageJsonStr);
    const testScript = pkg.scripts?.test;

    // No test script or npm's default placeholder — try to detect framework
    if (!testScript || testScript === 'echo "Error: no test specified" && exit 1') {
      const deps = { ...pkg.devDependencies, ...pkg.dependencies };
      if (deps.vitest) return 'npx vitest run';
      if (deps.jest) return 'npx jest';
      if (deps.mocha) return 'npx mocha';
      return 'npm test';
    }

    // Has a valid test script — use npm test which delegates to it
    return 'npm test';
  } catch {
    return 'npm test';
  }
}

/**
 * Parse test runner output into a structured result.
 * Handles common output formats from Jest, Vitest, and Mocha.
 */
export function parseTestOutput(output: string, durationMs: number): TestRunResult {
  const passMatch = output.match(/(\d+)\s+pass(?:ed|ing)?/i);
  const failMatch = output.match(/(\d+)\s+fail(?:ed|ing|ure)?/i);
  const passing = passMatch ? parseInt(passMatch[1], 10) : 0;
  const failing = failMatch ? parseInt(failMatch[1], 10) : 0;

  return {
    passed: failing === 0 && passing > 0,
    total: passing + failing,
    passing,
    failing,
    stdout: output.slice(-10_000),
    duration_ms: durationMs,
  };
}

/**
 * Parse a unified diff string into structured file change records.
 */
export function parseDiffToFileChanges(diff: string): FileChange[] {
  const files: FileChange[] = [];
  const fileRegex = /^diff --git a\/(.+) b\/(.+)$/gm;
  for (const match of diff.matchAll(fileRegex)) {
    const path = match[2];
    const ext = path.split('.').pop() ?? '';
    const nextDiffIndex = diff.indexOf('diff --git', match.index + 1);
    const section = diff.slice(match.index, nextDiffIndex === -1 ? undefined : nextDiffIndex);
    const added = (section.match(/^\+[^+]/gm) || []).length;
    const removed = (section.match(/^-[^-]/gm) || []).length;
    const isNew = section.includes('new file mode');
    const isDeleted = section.includes('deleted file mode');

    files.push({
      path,
      operation: isNew ? 'CREATE' : isDeleted ? 'DELETE' : 'MODIFY',
      language: ext,
      linesAdded: added,
      linesRemoved: removed,
    });
  }
  return files;
}
