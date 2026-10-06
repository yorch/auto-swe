import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ApplicationFailure } from '@temporalio/activity';

export type ContainerArch = 'x64' | 'arm64';
export type ContainerLibc = 'glibc' | 'musl';

/**
 * Shell run in the container to learn its platform: `uname -m`, then the musl
 * loader, a glibc loader and the first line of `ldd --version`, each when the
 * image has one. Alpine is musl; Debian and Ubuntu images are glibc. A glibc
 * image can also carry a musl loader (Debian's `musl` package installs one),
 * so the loader alone does not decide it.
 */
export const PLATFORM_PROBE = [
  'uname -m',
  'ls /lib/ld-musl-* /usr/lib/ld-musl-* 2>/dev/null | head -n 1',
  'ls /lib*/ld-linux-* /lib/*/ld-linux-* /usr/lib*/ld-linux-* 2>/dev/null | head -n 1',
  'ldd --version 2>&1 | head -n 1',
  'true',
].join('; ');

/**
 * Reads the {@link PLATFORM_PROBE} output.
 *
 * What `ldd` says about itself wins, since it is the C library the image's
 * programs actually link against: glibc's names itself GLIBC or GNU libc,
 * musl's says musl (Alpine with `gcompat` has a glibc-named loader but musl's
 * `ldd`). Without a verdict from `ldd`, a glibc loader means glibc even when a
 * musl loader sits beside it; only a musl loader alone means musl.
 */
export function parseContainerPlatform(probe: string): {
  arch: ContainerArch;
  libc: ContainerLibc;
} {
  const [machine = '', ...rest] = probe.trim().split('\n');
  const arch = { aarch64: 'arm64', arm64: 'arm64', x86_64: 'x64' }[machine.trim()] as
    | ContainerArch
    | undefined;
  if (!arch) {
    throw ApplicationFailure.nonRetryable(
      `The workspace image reports architecture "${machine.trim()}"; the Claude Code runtime supports x86_64 and aarch64.`,
      'HARNESS_UNSUPPORTED_PLATFORM'
    );
  }
  const loaders = rest.filter((l) => l.trim().startsWith('/'));
  const ldd = rest.filter((l) => !l.trim().startsWith('/')).join('\n');
  const libc: ContainerLibc = /glibc|gnu libc|gnu c library/i.test(ldd)
    ? 'glibc'
    : /musl/i.test(ldd)
      ? 'musl'
      : loaders.some((l) => l.includes('/ld-linux-'))
        ? 'glibc'
        : loaders.some((l) => l.includes('/ld-musl-'))
          ? 'musl'
          : 'glibc';
  return { arch, libc };
}

/** The SDK's own package for one platform's native binary. */
export function claudeBinaryPackage(arch: ContainerArch, libc: ContainerLibc): string {
  return `@anthropic-ai/claude-agent-sdk-linux-${arch}${libc === 'musl' ? '-musl' : ''}`;
}

type ResolvePackageJson = (specifier: string) => string;

/**
 * Where the worker keeps the Claude Code binary for a container platform.
 *
 * The SDK ships a native binary per platform as an optional dependency, and the
 * container's libc is the executor image's, not the worker's — so `.yarnrc.yml`
 * installs both libc variants for the build architecture. A missing package is
 * therefore a deployment problem (an executor on an architecture the worker was
 * not built for), and retrying cannot fix it.
 */
export function resolveClaudeBinary(
  arch: ContainerArch,
  libc: ContainerLibc,
  resolve: ResolvePackageJson = createRequire(import.meta.url).resolve
): string {
  const pkg = claudeBinaryPackage(arch, libc);
  try {
    return path.join(path.dirname(resolve(`${pkg}/package.json`)), 'claude');
  } catch {
    throw ApplicationFailure.nonRetryable(
      `The worker has no Claude Code binary for linux-${arch} (${libc}) (${pkg}). ` +
        'It installs the linux binaries for its own build architecture; run the executor on that architecture.',
      'HARNESS_BINARY_MISSING'
    );
  }
}

const digests = new Map<string, Promise<string>>();

/**
 * The SHA-256 of a binary the worker holds, hex-encoded, computed once per path
 * per process: the copy in a container is compared against it before every turn.
 */
export function binarySha256(file: string): Promise<string> {
  let digest = digests.get(file);
  if (!digest) {
    digest = new Promise<string>((resolve, reject) => {
      const hash = createHash('sha256');
      createReadStream(file)
        .on('error', reject)
        .on('data', (chunk) => hash.update(chunk))
        .on('end', () => resolve(hash.digest('hex')));
    });
    // A read that failed is not remembered: the next turn tries again.
    digest.catch(() => digests.delete(file));
    digests.set(file, digest);
  }
  return digest;
}
