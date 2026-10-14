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
