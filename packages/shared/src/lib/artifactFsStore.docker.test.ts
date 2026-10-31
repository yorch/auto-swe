import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The deployment contract of the filesystem artifact store, with the store's own
 * compiled code: one named volume, seeded by the image's mount-point ownership,
 * written by the worker's user (uid 1000) through `ensureFsStore`/`writeFsArtifact`,
 * and read through the gateway's read-only mount by `assertFsStore`/
 * `openFsArtifactStream`. The store's identity marker must survive between
 * containers, and a read-only mount must not be able to create a store.
 *
 * A unit test cannot see any of this: it depends on the mount, its ownership and
 * the read-only flag, which is what a wrong compose/k8s mount gets wrong.
 *
 * Requires the shared package build (the docker-tests CI job runs it before the
 * suites) and a Docker daemon:
 *
 *   yarn workspace @auto-swe/shared build
 *   ARTIFACT_FS_DOCKER_TEST=1 yarn vitest run \
 *     packages/shared/src/lib/artifactFsStore.docker.test.ts
 */
const enabled = process.env.ARTIFACT_FS_DOCKER_TEST === '1';
const BASE_IMAGE = process.env.ARTIFACT_FS_TEST_IMAGE ?? 'node:26-alpine';
const IMAGE = `asw-artifact-fs-test-${process.pid}`;
const BUILD = fileURLToPath(new URL('../../dist/lib/artifactFsStore.js', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const STORE_ROOT = '/var/lib/auto-swe/artifacts';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const EVIDENCE_ID = '33333333-3333-4333-8333-333333333333';
const RELATIVE = `${RUN_ID}/ui.screenshot/${EVIDENCE_ID}`;
const volume = `asw-artifact-store-test-${process.pid}`;
let prepared = false;

function docker(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function removeContainer(name: string): void {
  try {
    docker(['rm', '-f', name]);
  } catch {
    // Already gone.
  }
}

/**
 * A minimal image with the shipped images' artifact mount point. Its `RUN` is
 * the line both Dockerfiles carry (asserted below); what matters here is that
 * Docker seeds an empty named volume from it (ownership included), which is what
 * the compose files rely on and a manual `chown` in the test would hide.
 */
function prepare(): void {
  if (prepared) {
    return;
  }
  const context = mkdtempSync(join(tmpdir(), 'asw-artifact-image-'));
  try {
    writeFileSync(
      join(context, 'Dockerfile'),
      [
        `FROM ${BASE_IMAGE}`,
        `RUN mkdir -p ${STORE_ROOT} && chown node:node /var/lib/auto-swe ${STORE_ROOT}`,
        'USER node',
        '',
      ].join('\n')
    );
    docker(['build', '-q', '-t', IMAGE, context]);
  } finally {
    rmSync(context, { force: true, recursive: true });
  }
  try {
    docker(['volume', 'rm', '-f', volume]);
  } catch {
    // A first run has no volume to remove.
  }
  docker(['volume', 'create', volume]);
  prepared = true;
}

function runIn(
  image: string,
  name: string,
  args: string[],
  readOnly: boolean,
  env: Record<string, string> = {},
  storeVolume: string = volume
): string {
  return docker([
    'run',
    '--rm',
    '--name',
    name,
    '--user',
    'node',
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    '-v',
    `${storeVolume}:${STORE_ROOT}${readOnly ? ':ro' : ''}`,
    '-v',
    `${BUILD}:/app/artifactFsStore.js:ro`,
    image,
    'node',
    '--input-type=module',
    '-e',
    args.join('\n'),
  ]);
}

describe.skipIf(!enabled)('filesystem artifact store volume (Docker)', () => {
  afterAll(() => {
    removeContainer('asw-artifact-writer');
    removeContainer('asw-artifact-reader');
    for (const cleanup of [
      ['volume', 'rm', '-f', volume],
      ['image', 'rm', '-f', IMAGE],
    ]) {
      try {
        docker(cleanup);
      } catch {
        // Best effort.
      }
    }
  });

  it('keeps the mount point provisioned in both shipped images', () => {
    for (const dockerfile of ['packages/gateway/Dockerfile', 'packages/worker/Dockerfile']) {
      const text = readFileSync(join(REPO_ROOT, dockerfile), 'utf8');
      expect(text, `${dockerfile} must create the artifact mount point`).toContain(
        'mkdir -p /var/lib/auto-swe/artifacts'
      );
      expect(text, `${dockerfile} must give it to the service user`).toContain(
        'chown node:node /var/lib/auto-swe /var/lib/auto-swe/artifacts'
      );
    }
  });

  it('writes as uid 1000 and reads through a read-only mount from another container', () => {
    prepare();
    const wrote = runIn(
      IMAGE,
      'asw-artifact-writer',
      [
        "import { ensureFsStore, writeFsArtifact } from '/app/artifactFsStore.js';",
        'const marker = await ensureFsStore(process.env.STORE);',
        "await writeFsArtifact({ body: Buffer.from('page-bytes'), relativePath: process.env.RELATIVE, root: process.env.STORE });",
        'console.log(JSON.stringify({ storeId: marker.storeId }));',
      ],
      false,
      { RELATIVE, STORE: STORE_ROOT }
    );
    const written = JSON.parse(wrote) as { storeId: string };
    expect(written.storeId).toMatch(/^[0-9a-f-]{36}$/);

    const read = runIn(
      IMAGE,
      'asw-artifact-reader',
      [
        "import { assertFsStore, openFsArtifactStream } from '/app/artifactFsStore.js';",
        'const fs = await import("node:fs/promises");',
        'await assertFsStore(process.env.STORE, process.env.STORE_ID);',
        'const opened = await openFsArtifactStream({ relativePath: process.env.RELATIVE, root: process.env.STORE });',
        'const chunks = [];',
        'for await (const chunk of opened.stream) chunks.push(chunk);',
        'const stat = await fs.stat(process.env.STORE + "/" + process.env.RELATIVE);',
        'const marker = JSON.parse(await fs.readFile(process.env.STORE + "/.auto-swe-artifacts.json", "utf8"));',
        'console.log(JSON.stringify({ bytes: Buffer.concat(chunks).toString("utf8"), mode: stat.mode & 0o777, size: opened.sizeBytes, storeId: marker.storeId }));',
      ],
      true,
      { RELATIVE, STORE: STORE_ROOT, STORE_ID: written.storeId }
    );
    const readBack = JSON.parse(read) as {
      bytes: string;
      mode: number;
      size: number;
      storeId: string;
    };

    expect(readBack.bytes).toBe('page-bytes');
    expect(readBack.size).toBe(10);
    // The store's own code owns the mode; the assertion is not the test setting it.
    expect(readBack.mode).toBe(0o600);
    expect(readBack.storeId).toBe(written.storeId);
  }, 180_000);

  it('cannot initialise a store through a read-only mount', () => {
    prepare();
    // A fresh, empty volume: the read-only mount must not be able to create the
    // identity marker there (a gateway that mounted the store writable by
    // mistake would).
    const empty = `${volume}-empty`;
    try {
      docker(['volume', 'rm', '-f', empty]);
    } catch {
      // Nothing to remove.
    }
    docker(['volume', 'create', empty]);
    try {
      let failure: unknown;
      try {
        runIn(
          IMAGE,
          'asw-artifact-reader',
          [
            "import { ensureFsStore } from '/app/artifactFsStore.js';",
            'await ensureFsStore(process.env.STORE);',
          ],
          true,
          { STORE: STORE_ROOT },
          empty
        );
      } catch (error) {
        failure = error;
      }
      // A negative test must name the failure: a broken setup fails differently
      // from the read-only mount this asserts.
      expect(failure).toBeDefined();
      const stderr = String((failure as { stderr?: unknown }).stderr ?? '');
      expect(stderr).toMatch(/EROFS|EACCES|read-only/i);
    } finally {
      try {
        docker(['volume', 'rm', '-f', empty]);
      } catch {
        // Best effort.
      }
    }
  }, 120_000);
});
