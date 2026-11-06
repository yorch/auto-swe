import { parseRepoSetup, type RepoSetup } from '@auto-swe/shared/lib/repoSetup';

export type SubmodulesChoice = 'off' | 'on' | 'recursive';

export interface SetupStepDraft {
  name: string;
  run: string;
  workdir: string;
  /** Seconds as typed; empty keeps the default. */
  timeout: string;
}

/**
 * The Workspace setup section of the repository form as plain editable fields. `enabled` false
 * stores no definition, so the repository's `.auto-swe/setup.yml` (or stack defaults) applies.
 */
export interface RepoSetupDraft {
  enabled: boolean;
  submodules: SubmodulesChoice;
  lfs: boolean;
  env: Array<{ key: string; value: string }>;
  steps: SetupStepDraft[];
  /** One path per line. */
  cachePaths: string;
  /** One file per line. */
  cacheKeyFiles: string;
}

export const EMPTY_STEP: SetupStepDraft = { name: '', run: '', timeout: '', workdir: '' };

export function setupDraft(setup: RepoSetup | null | undefined): RepoSetupDraft {
  return {
    cacheKeyFiles: (setup?.cache?.keyFiles ?? []).join('\n'),
    cachePaths: (setup?.cache?.paths ?? []).join('\n'),
    enabled: setup != null,
    env: Object.entries(setup?.env ?? {}).map(([key, value]) => ({ key, value })),
    lfs: setup?.lfs ?? false,
    steps: (setup?.steps ?? []).map((s) => ({
      name: s.name ?? '',
      run: s.run,
      timeout: s.timeoutSeconds != null ? String(s.timeoutSeconds) : '',
      workdir: s.workdir ?? '',
    })),
    submodules: setup?.submodules === 'recursive' ? 'recursive' : setup?.submodules ? 'on' : 'off',
  };
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * The definition the draft describes, checked against the shared schema: null when the section
 * is off. Blank step and env rows are dropped rather than refused.
 */
export function draftToSetup(
  draft: RepoSetupDraft
): { ok: true; setup: RepoSetup | null } | { ok: false; error: string } {
  if (!draft.enabled) {
    return { ok: true, setup: null };
  }
  const value: Record<string, unknown> = {};
  if (draft.submodules !== 'off') {
    value.submodules = draft.submodules === 'recursive' ? 'recursive' : true;
  }
  if (draft.lfs) {
    value.lfs = true;
  }
  const env = draft.env.filter((e) => e.key.trim() || e.value);
  if (env.length) {
    value.env = Object.fromEntries(env.map((e) => [e.key.trim(), e.value]));
  }
  const steps = [];
  for (const [i, s] of draft.steps.entries()) {
    if (!s.name.trim() && !s.run.trim() && !s.workdir.trim() && !s.timeout.trim()) {
      continue;
    }
    const timeout = s.timeout.trim();
    if (timeout && !/^\d+$/.test(timeout)) {
      return { error: `step ${i + 1}: timeout must be a whole number of seconds`, ok: false };
    }
    steps.push({
      ...(s.name.trim() ? { name: s.name.trim() } : {}),
      run: s.run,
      ...(timeout ? { timeoutSeconds: Number(timeout) } : {}),
      ...(s.workdir.trim() ? { workdir: s.workdir.trim() } : {}),
    });
  }
  if (steps.length) {
    value.steps = steps;
  }
  const paths = lines(draft.cachePaths);
  const keyFiles = lines(draft.cacheKeyFiles);
  if (paths.length || keyFiles.length) {
    value.cache = { ...(keyFiles.length ? { keyFiles } : {}), paths };
  }
  return parseRepoSetup(value);
}
