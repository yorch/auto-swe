import { createRequire } from 'node:module';
import path from 'node:path';
import { ApplicationFailure } from '@temporalio/activity';

export type ContainerArch = 'x64' | 'arm64';
export type ContainerLibc = 'glibc' | 'musl';

/**
 * Shell run in the container to learn its platform: `uname -m`, then the musl
 * loader if the image has one. Alpine is musl; Debian and Ubuntu images are
 * glibc and have no `ld-musl`.
 */
export const PLATFORM_PROBE =
  'uname -m; ls /lib/ld-musl-* /usr/lib/ld-musl-* 2>/dev/null | head -n 1; true';

/** Reads the {@link PLATFORM_PROBE} output. */
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
  return { arch, libc: rest.some((l) => l.includes('ld-musl')) ? 'musl' : 'glibc' };
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
