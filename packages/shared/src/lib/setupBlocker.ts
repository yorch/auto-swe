import { z } from 'zod';

export const SetupBlockerKindSchema = z.enum([
  'missing_secret',
  'secret_decrypt_failed',
  'missing_tool',
  'egress_denied',
  'git_auth',
  'git_fetch',
  'lfs_missing',
  'step_failed',
  'step_timeout',
  'invalid_config',
  'secret_leak',
  'internal',
]);

export const SetupBlockerSchema = z.object({
  detail: z.string().max(2000),
  kind: SetupBlockerKindSchema,
  step: z.string().optional(),
  subject: z.string(),
});

export type SetupBlocker = z.infer<typeof SetupBlockerSchema>;

export function setupBlockerRemedy(blocker: SetupBlocker): string {
  switch (blocker.kind) {
    case 'missing_secret':
      return `Add secret ${blocker.subject} under the repository's setup secrets.`;
    case 'secret_decrypt_failed':
      return `Save secret ${blocker.subject} again under the repository's setup secrets.`;
    case 'missing_tool':
      return `Install \`${blocker.subject}\` in a setup step or use an image that has it.`;
    case 'egress_denied':
      return `Add host ${blocker.subject} to the team egress allowlist.`;
    case 'git_auth':
      return 'Check the repository credentials and their access to the requested Git repository.';
    case 'git_fetch':
      return 'Check that the requested Git objects are available and the Git host is reachable.';
    case 'lfs_missing':
      return 'Use a workspace image that includes git-lfs.';
    case 'step_failed':
      return 'Correct the failing setup command and try setup again.';
    case 'step_timeout':
      return 'Check the setup command for hangs or increase its timeoutSeconds.';
    case 'invalid_config':
      return 'Correct the repository setup configuration and try setup again.';
    case 'secret_leak':
      return 'Remove secret-bearing files with cleanup or stop setup from writing secrets to disk.';
    case 'internal':
      return 'Check the workspace setup diagnostics and retry setup.';
  }
}

export function classifySetupStepFailure(input: {
  exitCode: number | null;
  output: string;
  command: string;
  step: string;
}): SetupBlocker {
  const missing =
    /(?:^|\n)(?:\/?[\w/.-]*\b(?:ba|da|a|k|z)?sh):\s*(?:(?:line\s+)?\d+:\s*)?([\w./@+-]+): (?:command )?not found\b/m.exec(
      input.output
    );
  const isMissing =
    input.exitCode === 127 || /\bcommand not found\b/i.test(input.output) || Boolean(missing);
  return {
    detail: input.output.slice(-2000),
    kind: isMissing ? 'missing_tool' : 'step_failed',
    step: input.step,
    subject: isMissing ? (missing?.[1] ?? input.command.trim().split(/\s+/)[0] ?? '') : input.step,
  };
}
