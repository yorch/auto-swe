import { createRequire } from 'node:module';
import path from 'node:path';
import { ApplicationFailure } from '@temporalio/activity';
import type { ContainerArch, ContainerLibc } from '../harness/binary.js';

/** The platform probe and the binary hash are the harness runtime's, shared by every adapter. */
export {
  binarySha256,
  type ContainerArch,
  type ContainerLibc,
  PLATFORM_PROBE,
  parseContainerPlatform,
} from '../harness/binary.js';

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
