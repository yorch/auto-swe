import { randomBytes } from 'node:crypto';
import type { Workspace } from '../activities/workspace.js';
import { shellQuote } from './shellQuote.js';
import { workspaceBackend } from './workspaceBackend/index.js';

const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const IMPORT_REF = 'refs/asw-delivery/import';
const EXPORT_REF = 'refs/asw-delivery/export';

export const bundleGit = (command: string): string =>
  `GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0 git ` +
  '-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.attributesFile=/dev/null ' +
  '-c core.askPass= -c credential.helper= -c protocol.ext.allow=never ' +
  '-c submodule.recurse=false -c fetch.recurseSubmodules=false -c gc.auto=0 ' +
  '-c maintenance.auto=false -c transfer.fsckObjects=true -c fetch.fsckObjects=true ' +
  command;

/** Only the worker's shell-quoted delivery commands are accepted, not arbitrary shell scripts. */
function words(command: string): string[] {
  const tokens = command.match(/(?:[A-Za-z0-9_./:+=-]+|'[^']*'|\\')+/g) ?? [];
  if (tokens.join(' ') !== command) {
    throw new Error('Unsupported delivery git command');
  }
  return tokens.map((token) =>
    token.replace(/'([^']*)'|\\'/g, (_, quoted: string | undefined) => quoted ?? "'")
  );
}

function sha(value: string): string {
  const result = value.trim();
  if (!SHA.test(result)) {
    throw new Error('Invalid delivery commit');
  }
  return result;
}

async function copyBundle(source: Workspace, target: Workspace, file: string): Promise<void> {
  const exported = await source.copyFileOut(file, MAX_BUNDLE_BYTES);
  try {
    const backend = workspaceBackend();
    const result = await backend.copyFileIn(
      backend.attach(target.containerId),
      exported.path,
      file,
      {
        heartbeatLabel: 'delivery: copying bundle',
        timeoutMs: 600_000,
      }
    );
    if (result.exitCode !== 0) {
      throw new Error(`Could not copy delivery bundle: ${result.stderr}`);
    }
  } finally {
    await exported.cleanup();
  }
}

async function ensureBase(trusted: Workspace, base: string): Promise<void> {
  const present = await trusted.execCapture(bundleGit(`cat-file -e ${base}^{commit}`));
  if (present.exitCode !== 0) {
    await trusted.gitAuthed(`fetch --depth=1 origin ${base}`);
  }
}

async function exportBundle(
  source: Workspace,
  file: string,
  ref: string,
  base: string
): Promise<void> {
  const ancestor = await source.execCapture(bundleGit(`merge-base --is-ancestor ${base} ${ref}`));
  const exclusion = ancestor.exitCode === 0 ? ` ^${base}` : '';
  await source.exec(bundleGit(`bundle create ${shellQuote(file)} ${shellQuote(ref)}${exclusion}`), {
    timeoutMs: 600_000,
  });
}

/** A fresh trusted workspace owns all remote credentials; the source supplies only capped bytes. */
export async function runBundleDeliveryGit(
  agent: Workspace,
  createTrusted: () => Promise<Workspace>,
  base: string,
  command: string
): Promise<string> {
  sha(base);
  const args = words(command);
  const trusted = await createTrusted();
  const file = `/workspace/.delivery-${randomBytes(16).toString('hex')}.bundle`;
  try {
    if (
      args[0] === 'ls-remote' &&
      args[1] === '--heads' &&
      args[2] === 'origin' &&
      args.length === 4
    ) {
      return await trusted.gitAuthed(command);
    }
    if (args[0] === 'fetch' && args[1] === 'origin' && args.length > 2) {
      const refs = args.slice(2).map((refspec) => {
        const match = /^\+refs\/heads\/(.+):refs\/remotes\/origin\/\1$/.exec(refspec);
        if (!match) {
          throw new Error('Unsupported delivery fetch refspec');
        }
        return `refs/remotes/origin/${match[1]}`;
      });
      const result = await trusted.gitAuthed(command);
      await ensureBase(trusted, base);
      // Deepen only when the cheap clone does not span the source workspace's base.
      for (const ref of refs) {
        const ancestor = await trusted.execCapture(
          bundleGit(`merge-base --is-ancestor ${base} ${shellQuote(ref)}`)
        );
        if (ancestor.exitCode !== 0) {
          if (
            (await trusted.exec(bundleGit('rev-parse --is-shallow-repository'))).trim() === 'true'
          ) {
            await trusted.gitAuthed('fetch --unshallow origin');
          }
          break;
        }
      }
      // Separate bundles preserve each destination ref, including unrelated source branches.
      for (const ref of refs) {
        const tip = sha(
          await trusted.exec(bundleGit(`rev-parse --verify ${shellQuote(`${ref}^{commit}`)}`))
        );
        if (tip === base) {
          await agent.exec(bundleGit(`update-ref ${shellQuote(ref)} ${base}`));
          continue;
        }
        await exportBundle(trusted, file, ref, base);
        await copyBundle(trusted, agent, file);
        await agent.exec(
          bundleGit(`fetch --no-tags ${shellQuote(file)} ${shellQuote(`+${ref}:${ref}`)}`),
          { timeoutMs: 600_000 }
        );
      }
      return result;
    }
    if (args[0] !== 'push' || args[1] !== 'origin' || args.length !== 3) {
      throw new Error('Unsupported delivery git operation');
    }
    const [source, destination = source] = (args[2] ?? '').split(':');
    if (!source || !destination) {
      throw new Error('Invalid delivery refspec');
    }
    const branch = destination.replace(/^refs\/heads\//, '');
    await trusted.exec(bundleGit(`check-ref-format ${shellQuote(`refs/heads/${branch}`)}`));
    const sourceRef = source.startsWith('refs/heads/') ? source : `refs/heads/${source}`;
    const localSha =
      args[2]?.includes(':') && SHA.test(source)
        ? source
        : sha(
            await agent.exec(bundleGit(`rev-parse --verify ${shellQuote(`${sourceRef}^{commit}`)}`))
          );
    const listing = await trusted.gitAuthed(
      `ls-remote --heads origin ${shellQuote(`refs/heads/${branch}`)}`
    );
    const remote = listing
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find(([, ref]) => ref === `refs/heads/${branch}`);
    const expected = remote ? sha(remote[0] ?? '') : base;
    await ensureBase(trusted, base);
    if (remote) {
      await trusted.gitAuthed(
        `fetch origin ${shellQuote(`+refs/heads/${branch}:refs/remotes/origin/${branch}`)}`
      );
      const fetched = sha(
        await trusted.exec(
          bundleGit(`rev-parse --verify ${shellQuote(`refs/remotes/origin/${branch}^{commit}`)}`)
        )
      );
      if (fetched !== expected) {
        throw new Error('Remote branch changed during delivery');
      }
    }
    if (localSha !== base) {
      await agent.exec(bundleGit(`update-ref ${EXPORT_REF} ${localSha}`));
      await exportBundle(agent, file, EXPORT_REF, base);
      await copyBundle(agent, trusted, file);
      await trusted.exec(bundleGit(`bundle verify ${shellQuote(file)}`), { timeoutMs: 600_000 });
      await trusted.exec(
        bundleGit(`fetch --no-tags ${shellQuote(file)} +${EXPORT_REF}:${IMPORT_REF}`),
        { timeoutMs: 600_000 }
      );
      const imported = sha(
        await trusted.exec(bundleGit(`rev-parse --verify ${IMPORT_REF}^{commit}`))
      );
      if (imported !== localSha) {
        throw new Error('Delivery bundle does not match the requested commit');
      }
    }
    await trusted.exec(bundleGit('fsck --strict --no-reflogs'), { timeoutMs: 600_000 });
    await trusted.exec(bundleGit(`merge-base --is-ancestor ${expected} ${localSha}`));
    return await trusted.gitAuthed(`push origin ${localSha}:refs/heads/${shellQuote(branch)}`);
  } finally {
    try {
      await trusted.destroy();
    } finally {
      await agent.exec(`rm -f -- ${shellQuote(file)}`).catch(() => {});
    }
  }
}
