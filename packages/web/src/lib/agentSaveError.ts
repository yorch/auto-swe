import { ApiError } from '@/lib/api';
import { errMsg } from '@/lib/errors';
import { visibleText } from '@/lib/visibleText';

const PROFILE_TITLES: Record<string, string> = {
  PROFILE_DISABLED: 'A bound plugin is disabled',
  PROFILE_DUPLICATE: 'A plugin is listed more than once',
  PROFILE_NAME_COLLISION: 'Two plugins hold a plugin of the same name',
  PROFILE_NOT_ENABLED: 'A plugin is not enabled for this team',
  PROFILE_NOT_FOUND: 'A bound plugin does not exist',
  PROFILE_RUNTIME_MISMATCH: 'Plugins need the Claude Code runtime',
};

const PROFILE_NEXT_STEP: Partial<Record<string, string>> = {
  PROFILE_DUPLICATE: 'Remove the repeated entry.',
  PROFILE_NAME_COLLISION: 'Bind only one of the two.',
  PROFILE_NOT_ENABLED:
    'A team admin enables it under the team’s settings, Plugins, before an agent can bind it.',
  PROFILE_RUNTIME_MISMATCH: 'Set the runtime to Claude Code, or clear the plugins.',
};

/** Whether an error is one of the plugin-binding refusals on an agent save. */
export const isProfileSaveError = (err: unknown): err is ApiError =>
  err instanceof ApiError && err.code !== null && err.code in PROFILE_TITLES;

/**
 * What to tell the person whose agent save failed. A plugin-binding refusal gets its title and the
 * next step, with the server's sentence (which names the plugins involved) kept and made visible;
 * anything else is the error's own message.
 */
export function describeAgentSaveError(err: unknown, fallback: string): string {
  if (!isProfileSaveError(err) || err.code === null) {
    return errMsg(err, fallback);
  }
  const next = PROFILE_NEXT_STEP[err.code];
  return `${PROFILE_TITLES[err.code]}. ${visibleText(err.message)}${next ? ` ${next}` : ''}`;
}
