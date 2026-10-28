import { afterEach, describe, expect, it } from 'vitest';
import { executorImageFor } from './executorImage.js';

const ENV = ['WORKSPACE_IMAGE_PYTHON', 'WORKSPACE_IMAGE_JVM', 'WORKSPACE_IMAGE_GO'] as const;
const stack = (path: string, s: string) => ({
  components: [{ path, stacks: [s] }],
  evidence: [],
});

afterEach(() => {
  for (const k of ENV) {
    delete process.env[k];
  }
});

describe('executorImageFor', () => {
  it('is undefined — the deployment default — with nothing configured, whatever the stack', () => {
    for (const s of ['python', 'jvm', 'go', 'node']) {
      expect(
        executorImageFor({ detectedStack: stack('', s), executorImage: null }),
        s
      ).toBeUndefined();
    }
    expect(executorImageFor({})).toBeUndefined();
  });

  it('picks the deployer’s image for the detected stack', () => {
    process.env.WORKSPACE_IMAGE_PYTHON = 'registry.example/executor-python:1';
    process.env.WORKSPACE_IMAGE_GO = `registry.example/executor-go@sha256:${'a'.repeat(64)}`;
    expect(executorImageFor({ detectedStack: stack('', 'python') })).toBe(
      'registry.example/executor-python:1'
    );
    expect(executorImageFor({ detectedStack: stack('svc', 'go') })).toMatch(/executor-go@sha256/);
    // No image for jvm was set, so jvm runs on the default.
    expect(executorImageFor({ detectedStack: stack('', 'jvm') })).toBeUndefined();
  });

  it('lets an admin-set executorImage win, and never reads the stack then', () => {
    process.env.WORKSPACE_IMAGE_PYTHON = 'registry.example/executor-python:1';
    expect(
      executorImageFor({ detectedStack: stack('', 'python'), executorImage: 'custom/image:2' })
    ).toBe('custom/image:2');
  });

  it('gives Node no stack image, even when every variable is set', () => {
    for (const k of ENV) {
      process.env[k] = 'registry.example/x:1';
    }
    expect(executorImageFor({ detectedStack: stack('', 'node') })).toBeUndefined();
  });

  it('falls through for an ambiguous layout, a truncated tree and an unreadable detection', () => {
    for (const k of ENV) {
      process.env[k] = 'registry.example/x:1';
    }
    expect(
      executorImageFor({
        detectedStack: {
          components: [
            { path: 'a', stacks: ['go'] },
            { path: 'b', stacks: ['jvm'] },
          ],
        },
      })
    ).toBeUndefined();
    expect(
      executorImageFor({ detectedStack: { ...stack('svc', 'go'), treeTruncated: true } })
    ).toBeUndefined();
    expect(executorImageFor({ detectedStack: 'nonsense' })).toBeUndefined();
    expect(executorImageFor({ detectedStack: stack('../x', 'go') })).toBeUndefined();
  });

  it('ignores a variable that is not an image reference', () => {
    process.env.WORKSPACE_IMAGE_GO = 'x; rm -rf /';
    expect(executorImageFor({ detectedStack: stack('', 'go') })).toBeUndefined();
  });
});
