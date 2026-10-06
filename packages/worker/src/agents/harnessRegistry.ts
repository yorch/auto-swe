import { claudeCodeHarness } from './claudeCode/harness.js';
import { createHarnessRegistry } from './harness/registry.js';

/**
 * Every harness this worker can run an implementer turn on, by its
 * `workspace.implementerRuntime` value. A harness that cannot have the worker
 * decide each of its tool calls is refused here, at import, so the worker does
 * not start with one registered.
 */
export const HARNESSES = createHarnessRegistry([claudeCodeHarness]);
