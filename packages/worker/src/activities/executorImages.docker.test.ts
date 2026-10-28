/**
 * The curated executor images (`defaults/Dockerfile.<stack>`) against the executor image
 * contract (docs/repositories.md) and their own toolchain, in a real container.
 *
 * Nothing else builds these images or runs anything in them: the unit suites mock the
 * workspace, and a Dockerfile that stops producing a usable image changes no type, lint
 * rule or unit test. Needs a Docker daemon and the base images' registries:
 *
 *   EXECUTOR_IMAGES_DOCKER_TEST=1 yarn vitest run \
 *     packages/worker/src/activities/executorImages.docker.test.ts
 *
 * `EXECUTOR_IMAGES_DOCKER_TEST_STACKS=go,python` narrows it to those stacks (CI runs all four).
 *
 * Containers run with the flags the agent workspace uses (`--init`, `--cap-drop=ALL`,
 * `no-new-privileges`) as the image's own default user, which is what the executor runs as.
 * Go is also run through the stack's real gate commands, because its build needs no network;
 * the Python and JVM gates need a package index, so they are checked for their toolchain only.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  detectedGateDefaults,
  detectStack,
  stackGateDefaults,
} from '@auto-swe/shared/lib/stackDetection';
import { beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.EXECUTOR_IMAGES_DOCKER_TEST === '1';
const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

async function docker(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, {
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (e) {
    const err = e as { code?: number; stderr?: string; stdout?: string };
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      out: `${err.stdout ?? ''}${err.stderr ?? ''}`,
    };
  }
}

const tag = (stack: string) => `asw-executor-${stack}:docker-test`;

/** Run a shell script in the image as its default user, under the workspace's hardening flags. */
function run(stack: string, script: string) {
  return docker([
    'run',
    '--rm',
    '--init',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    tag(stack),
    'sh',
    '-c',
    script,
  ]);
}

// What every image must provide. `bash` is left out of node on purpose: that image is
// Alpine without it, and the harness installs it where it can or says it cannot.
const CONTRACT = [
  ['git', 'git --version'],
  ['tar', 'tar --version || tar --help'],
  ['ripgrep', 'rg --version'],
  ['sha256sum', 'sha256sum /dev/null'],
  ['a writable workspace', 'touch /workspace/target-repo/.probe'],
  ['a non-root uid 1000', 'test "$(id -u)" = 1000'],
] as const;

const TOOLCHAIN: Record<string, string> = {
  go: 'go version',
  jvm: 'java -version && mvn -version',
  node: 'node --version && npm --version && yarn --version && pnpm --version',
  python: 'python --version && uv --version',
};

const STACKS = Object.keys(TOOLCHAIN).filter((s) => {
  const only = process.env.EXECUTOR_IMAGES_DOCKER_TEST_STACKS;
  return !only || only.split(',').includes(s);
});

describe.skipIf(!enabled)('curated executor images', () => {
  beforeAll(async () => {
    for (const stack of STACKS) {
      const built = await docker([
        'build',
        '-q',
        '-f',
        path.join(REPO_ROOT, `defaults/Dockerfile.${stack}`),
        '-t',
        tag(stack),
        path.join(REPO_ROOT, 'defaults'),
      ]);
      expect(built.code, `building Dockerfile.${stack}:\n${built.out}`).toBe(0);
    }
  }, 1_500_000);

  for (const stack of STACKS) {
    describe(stack, () => {
      for (const [name, script] of CONTRACT) {
        it(`provides ${name}`, async () => {
          const r = await run(stack, script);
          expect(r.code, r.out).toBe(0);
        }, 120_000);
      }

      if (stack !== 'node') {
        it('provides bash', async () => {
          const r = await run(stack, 'bash --version');
          expect(r.code, r.out).toBe(0);
        }, 120_000);
      }

      it('has its toolchain on the default user’s PATH', async () => {
        const r = await run(stack, TOOLCHAIN[stack] as string);
        expect(r.code, r.out).toBe(0);
      }, 120_000);
    });
  }

  it.skipIf(!STACKS.includes('go'))(
    'go: the commands for a repository whose only component is a subdirectory run in it',
    async () => {
      const gates = detectedGateDefaults(detectStack(['README.md', 'services/api-v2/go.mod']));
      expect(gates?.runTests).toBe("cd 'services/api-v2' && go test ./...");
      const script = [
        'set -e',
        'mkdir -p /workspace/target-repo/services/api-v2',
        'cd /workspace/target-repo/services/api-v2',
        'printf "module example.test/y\\n\\ngo 1.22\\n" > go.mod',
        'printf "package y\\n\\nimport \\"testing\\"\\n\\nfunc TestY(t *testing.T) {}\\n" > y_test.go',
        // Each gate runs from the repository root in its own `sh -c`, as the workspace runs it;
        // a subshell each keeps one command's `cd` from leaking into the next.
        'cd /workspace/target-repo',
        `(${gates?.runBuild}) && (${gates?.runLint}) && (${gates?.runTests})`,
      ].join(' && ');
      const r = await run('go', script);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/ok\s+example\.test\/y/);
      // A directory that is not there fails the gate instead of passing it.
      const gone = await run('go', `cd /workspace/target-repo && ${gates?.runTests}`);
      expect(gone.code).not.toBe(0);
    },
    300_000
  );

  it.skipIf(!STACKS.includes('go'))(
    'go: the stack’s own gate commands build, vet and test a module, as the executor user',
    async () => {
      const gates = stackGateDefaults('go', new Set());
      const commands = [gates.runBuild, gates.runLint, gates.runTests];
      expect(commands.every((c) => typeof c === 'string')).toBe(true);
      const script = [
        'set -e',
        'cd /workspace/target-repo',
        'printf "module example.test/x\\n\\ngo 1.22\\n" > go.mod',
        'printf "package x\\n\\nfunc Add(a, b int) int { return a + b }\\n" > x.go',
        'printf "package x\\n\\nimport \\"testing\\"\\n\\nfunc TestAdd(t *testing.T) {\\n\\tif Add(1, 2) != 3 {\\n\\t\\tt.Fatal(\\"bad\\")\\n\\t}\\n}\\n" > x_test.go',
        ...(commands as string[]),
      ].join(' && ');
      const r = await run('go', script);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/ok\s+example\.test\/x/);
    },
    300_000
  );
});
