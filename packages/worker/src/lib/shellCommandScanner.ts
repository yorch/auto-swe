import { makePatternLoader } from './scannerPatternLoader.js';

const { load: loadShellPatterns, invalidate } = makePatternLoader(
  'SHELL_COMMAND',
  'shellCommandScanner'
);

export { invalidate as invalidateShellCommandPatternCache };

/**
 * Checks a shell command against active SHELL_COMMAND scanner patterns.
 * Returns a human-readable block message (for the agent to self-correct) if
 * the command matches, or null if it is clean.
 */
export async function scanShellCommand(command: string): Promise<string | null> {
  const patterns = await loadShellPatterns();
  for (const { label, re } of patterns) {
    re.lastIndex = 0;
    if (re.test(command)) {
      const truncated = command.length > 200 ? `${command.slice(0, 200)}…` : command;
      return (
        `Command blocked by security policy [${label}]:\n  ${truncated}\n` +
        'Modify the command to avoid the restricted pattern and retry.'
      );
    }
  }
  return null;
}
