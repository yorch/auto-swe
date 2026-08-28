/**
 * Isolate-safe re-exports of the deterministic workflow engine pieces.
 *
 * Workflow files under `src/workflows/*` must not import runtime values from
 * external packages (especially `@auto-swe/shared`) because the Temporal V8
 * isolate bundler and determinism rules treat every outside import with
 * suspicion. Re-exporting the engine through a worker-internal `lib/` file lets
 * workflow files import from `../lib/workflowEngine.js` while still sharing
 * the implementation in `@auto-swe/shared`.
 */

export { CHANNEL_TASK_STEER_SIGNAL } from '@auto-swe/shared/lib/channelTask';
export { lookupPath } from '@auto-swe/shared/workflow/expr';
export {
  BranchCancelledError,
  readInterpreterLimits,
  runSpec,
} from '@auto-swe/shared/workflow/interpreter';
export { SignalSlots } from '@auto-swe/shared/workflow/signalSlots';
