import type { Workspace } from '../activities/workspace.js';
import { shellQuote } from './shellQuote.js';

const GIT =
  'GIT_NO_REPLACE_OBJECTS=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git ' +
  '-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.attributesFile=/dev/null ' +
  '-c core.autocrlf=false -c commit.gpgsign=false';

export class StoredPatchError extends Error {}

export function storedPatchPaths(diff: string): string[] {
  if (
    diff.includes('\0') ||
    /^(GIT binary patch|Binary files |(?:new file|deleted file|old|new) mode (?!100644|100755)|index .* (?:120000|160000)$|(?:rename|copy) (?:from|to) )/m.test(
      diff
    )
  ) {
    throw new StoredPatchError(
      'Stored patch contains binary, symlink, submodule, or unsupported metadata'
    );
  }
  const paths = new Set<string>();
  let current: string | undefined;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      const name = match?.[1];
      if (
        !name ||
        name !== match?.[2] ||
        [...name].some(
          (char) =>
            char.charCodeAt(0) < 32 ||
            char.charCodeAt(0) === 127 ||
            char === '\\' ||
            char === '\uFFFD'
        ) ||
        name.split('/').some((part) => !part || ['.', '..', '.git'].includes(part.toLowerCase()))
      ) {
        throw new StoredPatchError('Stored patch contains an unsafe or quoted path');
      }
      current = name;
      paths.add(name);
      inHunk = false;
    } else if (line.startsWith('@@ ')) {
      inHunk = true;
    } else if (!inHunk && (line.startsWith('--- ') || line.startsWith('+++ '))) {
      const path = line.slice(4);
      const expected = `${line.startsWith('--- ') ? 'a' : 'b'}/${current}`;
      if (!current || (path !== '/dev/null' && path !== expected)) {
        throw new StoredPatchError('Stored patch file headers do not match');
      }
    }
  }
  if (!paths.size) {
    throw new StoredPatchError('Stored patch has no supported file changes');
  }
  return [...paths];
}

export async function applyStoredPatch(
  workspace: Workspace,
  change: { baseSha: string; diff: string },
  commit = false
): Promise<string> {
  if (!/^[a-f0-9]{40}$/i.test(change.baseSha)) {
    throw new StoredPatchError('Stored base commit is invalid');
  }
  const paths = storedPatchPaths(change.diff);
  const base = (await workspace.exec(`${GIT} rev-parse HEAD`)).trim();
  if (base !== change.baseSha) {
    throw new StoredPatchError('Stored base checkout does not match');
  }
  await workspace.exec(`set -e\nfor target in ${paths.map(shellQuote).join(' ')}; do
    p="$target"
    while [ "$p" != "." ]; do
      if [ -L "$p" ]; then exit 1; fi
      p=$(dirname -- "$p")
    done
  done`);
  await workspace.execStdin(`${GIT} apply --check --index --whitespace=nowarn -`, change.diff);
  await workspace.execStdin(`${GIT} apply --index --whitespace=nowarn -`, change.diff);
  const stat = await workspace.exec(`${GIT} diff --cached --numstat --no-ext-diff --no-textconv`);
  if (/^-\t-\t/m.test(stat)) {
    throw new StoredPatchError('Stored patch modifies binary content');
  }
  if (commit) {
    await workspace.exec(
      `${GIT} -c user.name=auto-swe -c user.email=review@auto-swe.invalid commit --allow-empty -q -m 'Verify stored review diff'`
    );
    const head = (await workspace.exec(`${GIT} rev-parse HEAD`)).trim();
    if (!/^[a-f0-9]{40}$/i.test(head)) {
      throw new StoredPatchError('Stored review commit identity is invalid');
    }
    return head;
  }
  return base;
}
