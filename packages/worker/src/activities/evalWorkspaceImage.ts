/**
 * Base image for eval workspaces — pinned, and the one image a workspace may
 * use without inheriting the operator's configured image. The harness scores
 * cases in it (`runCaseDefault`), and a case's reference is run in it for
 * re-validation and flake screening (`runCaseReference`), so a reference is
 * checked in the environment it is scored in.
 *
 * That is the same frozen-fixture reasoning as `EvalCase.baselineSha`: a
 * benchmark score is comparable against its own history only if the environment
 * it ran in did not move. So these workspaces deliberately ignore the
 * connection's `executorImage` and the `WORKSPACE_IMAGE` default, both of
 * which an operator can change at any time.
 *
 * Changing this constant silently rebases every stored eval score onto a
 * different environment — regressions and improvements measured across the
 * change are not comparable. Treat it as a benchmark epoch, not a config knob:
 * if it must move, expect to re-baseline, and to re-screen every case.
 *
 * It is a named constant rather than an inline literal so the shape of the
 * exception is greppable, and so `scripts/check-invariants.mjs` can hold every
 * other call site to inheriting without maintaining a list of exemptions. It
 * lives in its own module so the re-validation path can share it without
 * loading the harness.
 */
export const EVAL_WORKSPACE_IMAGE = 'node:24-alpine';

/**
 * The pinned base image for each toolchain an eval case may name, by `EvalCase.stack`.
 * A case names a stack, never an image: the image is code that runs a repository's
 * tests, so the set is closed and fixed here, and — like `EVAL_WORKSPACE_IMAGE` — each
 * entry is a benchmark epoch. `node` is the constant above, so a case with no stack
 * runs exactly where it always did.
 *
 * These are upstream toolchain bases, not the curated executor images (which are built
 * per repository and have no shared tag). They carry the language toolchain and, for
 * the JVM, Maven (the JDK major is 21 either way); no other build tool beyond it. A
 * Gradle case brings its wrapper, and an image without `git` gets one installed when
 * the workspace starts.
 *
 * Changing an entry is a benchmark epoch for the cases on that stack, as for
 * `EVAL_WORKSPACE_IMAGE`: scores recorded before and after are not comparable, and the
 * cases need re-screening.
 */
const EVAL_STACK_IMAGES: Readonly<Record<string, string>> = Object.freeze({
  go: 'golang:1.26-bookworm@sha256:386f0cbb8fb3402ff5a15048c96731e6ff37142d31182f3b72306359a1f5e9b7',
  jvm: 'maven:3.9-eclipse-temurin-21@sha256:99e61abcff91a9b1333463bd8451fb18495d6eba9250ac66a338b518f8278320',
  node: EVAL_WORKSPACE_IMAGE,
  python:
    'python:3.13-slim@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f',
});

/**
 * The image an eval case runs in. A missing stack is node. A stack outside the set is
 * an error, not node: scoring a Python case on a Node image would fail it for the
 * environment and read as the candidate's regression.
 */
export function evalWorkspaceImageFor(stack: string | null | undefined): string {
  if (stack === null || stack === undefined) {
    return EVAL_WORKSPACE_IMAGE;
  }
  const image = Object.hasOwn(EVAL_STACK_IMAGES, stack) ? EVAL_STACK_IMAGES[stack] : undefined;
  if (!image) {
    throw new Error(`Unknown eval case stack '${stack}' (expected node, python, jvm or go)`);
  }
  return image;
}
