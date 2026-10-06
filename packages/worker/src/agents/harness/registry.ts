import type { ImplementerRuntimeKind } from '@auto-swe/shared/types/api';
import { ApplicationFailure } from '@temporalio/activity';
import type { HarnessCapabilities, HarnessRuntimeOptions } from './adapter.js';
import type { HarnessRuntime } from './runtime.js';

/** A `workspace.implementerRuntime` value served by a harness rather than the Mastra loop. */
export type HarnessKind = Exclude<ImplementerRuntimeKind, 'mastra'>;

/** The Agent's resolved model, as `resolveAgent` binds it. */
export interface HarnessModel {
  apiBase?: string | null;
  apiKey: string;
  spec: string;
}

/**
 * A harness as the registry knows it. `Access` is what the harness runs on — the
 * model id and credential in the shape its client wants.
 */
export interface HarnessDefinition<Access> {
  kind: HarnessKind;
  /** Names the harness in messages (`Claude Code`). */
  label: string;
  capabilities: HarnessCapabilities;
  /**
   * The Agent's model, in the harness's terms. Throws a non-retryable failure
   * for a model the harness cannot speak to.
   */
  bindModel(agentKey: string, model: HarnessModel): Access;
  createRuntime(options: HarnessRuntimeOptions<Access>): HarnessRuntime;
}

/** A harness bound to one Agent's model: its access sealed in, ready to build runtimes. */
export interface BoundHarness {
  kind: HarnessKind;
  label: string;
  build(options: Omit<HarnessRuntimeOptions<never>, 'access'>): HarnessRuntime;
}

/** A registered harness, its access type sealed in. */
export interface RegisteredHarness {
  kind: HarnessKind;
  label: string;
  capabilities: HarnessCapabilities;
  /**
   * Bind the Agent's resolved model. Throws, without building anything, for a
   * model the harness cannot speak to — so a caller can refuse it before it
   * creates a container.
   */
  bind(agentKey: string, model: HarnessModel): BoundHarness;
}

export function defineHarness<Access>(definition: HarnessDefinition<Access>): RegisteredHarness {
  const { bindModel, capabilities, createRuntime, kind, label } = definition;
  return {
    bind(agentKey, model) {
      const access = bindModel(agentKey, model);
      return { build: (options) => createRuntime({ ...options, access }), kind, label };
    },
    capabilities,
    kind,
    label,
  };
}

function unenforceable(harness: Pick<RegisteredHarness, 'kind' | 'label'>): Error {
  return ApplicationFailure.nonRetryable(
    `The ${harness.label} runtime (${harness.kind}) cannot have the worker decide every tool call before it runs, so it cannot be used for a workspace run.`,
    'HARNESS_POLICY_UNENFORCEABLE'
  );
}

export interface HarnessRegistry {
  /** The kinds registered, in registration order. */
  kinds(): HarnessKind[];
  /**
   * The harness for a `workspace.implementerRuntime` value. Throws, without
   * retrying, for a value nothing serves or a harness that cannot enforce the
   * per-call policy.
   */
  select(kind: string): RegisteredHarness;
}

/**
 * The harnesses a worker can run. Registration refuses any harness that does
 * not declare `enforcesPerCallPolicyInWorker`: the worker's scanners are what
 * make a harness safe to point at a workspace, and a harness that runs some
 * calls without asking makes them advisory. Selection checks it again, so a
 * definition changed after registration is still refused.
 */
export function createHarnessRegistry(harnesses: readonly RegisteredHarness[]): HarnessRegistry {
  const byKind = new Map<string, RegisteredHarness>();
  for (const harness of harnesses) {
    if (!harness.capabilities.enforcesPerCallPolicyInWorker) {
      throw unenforceable(harness);
    }
    if (byKind.has(harness.kind)) {
      throw new Error(`Two harnesses are registered for '${harness.kind}'.`);
    }
    byKind.set(harness.kind, harness);
  }
  return {
    kinds: () => [...byKind.values()].map((h) => h.kind),
    select(kind) {
      const harness = byKind.get(kind);
      if (!harness) {
        throw ApplicationFailure.nonRetryable(
          `No harness is registered for workspace.implementerRuntime '${kind}'.`,
          'HARNESS_UNAVAILABLE'
        );
      }
      if (!harness.capabilities.enforcesPerCallPolicyInWorker) {
        throw unenforceable(harness);
      }
      return harness;
    },
  };
}
