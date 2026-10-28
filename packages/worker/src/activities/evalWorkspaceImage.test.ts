import { describe, expect, it } from 'vitest';
import { EVAL_WORKSPACE_IMAGE, evalWorkspaceImageFor } from './evalWorkspaceImage.js';

describe('evalWorkspaceImageFor', () => {
  it('keeps a case with no stack on the image every stored score was taken on', () => {
    expect(evalWorkspaceImageFor(null)).toBe(EVAL_WORKSPACE_IMAGE);
    expect(evalWorkspaceImageFor(undefined)).toBe(EVAL_WORKSPACE_IMAGE);
    expect(evalWorkspaceImageFor('node')).toBe(EVAL_WORKSPACE_IMAGE);
  });

  it('pins every other toolchain by digest', () => {
    for (const stack of ['python', 'jvm', 'go']) {
      expect(evalWorkspaceImageFor(stack), stack).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it('refuses a stack outside the set rather than scoring it on the node image', () => {
    for (const bad of ['ruby', '', 'toString', '__proto__', 'constructor']) {
      expect(() => evalWorkspaceImageFor(bad), bad).toThrow(/Unknown eval case stack/);
    }
  });
});
