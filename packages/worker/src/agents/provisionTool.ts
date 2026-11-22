import { resolveSettings } from '@auto-swe/shared/config';
import {
  ToolInstallError,
  ToolKeySchema,
  ToolVersionSchema,
} from '@auto-swe/shared/lib/toolCatalog';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Workspace } from '../activities/workspace.js';
import type { AgentTracer } from '../lib/agentTracer.js';
import { ToolRefusal } from '../lib/workspaceTools.js';
import type { WorkerTool } from './workerTool.js';

/** The tool key an Agent's `toolKeys` must name; `null` never implies it. */
export const PROVISION_TOOL_KEY = 'provisionTool' as const;

/** True only when the grant names `provisionTool`; an unrestricted (`null`) list does not. */
export function grantsProvisionTool(toolKeys: readonly string[] | null): boolean {
  return toolKeys?.includes(PROVISION_TOOL_KEY) === true;
}

const OutputSchema = z.object({
  error: z.string().optional(),
  installed: z
    .object({ key: z.string(), version: z.string(), warning: z.string().optional() })
    .optional(),
  ok: z.boolean(),
});
type ProvisionResult = z.infer<typeof OutputSchema>;

const ProvisionToolInput = z.object({
  key: ToolKeySchema.describe('The tool catalog key, e.g. "just"'),
  version: ToolVersionSchema.optional().describe('An exact catalog version; default latest'),
});

const RETRY_HINT = 'It may be retried by calling provisionTool again.';

/** What the model is told `provisionTool` does, on every loop that offers it. */
export const PROVISION_TOOL_DESCRIPTION =
  'Install a pinned tool from the platform tool catalog into this workspace so later ' +
  'commands can run it. Pass the catalog key (and optionally a version). Only catalog tools ' +
  'the repository allows can be installed; the result says why a request was refused.';

export interface ProvisionToolOptions {
  workspace: Workspace;
  /** The resolved Agent's tool keys, re-checked at call time. */
  toolKeys: readonly string[] | null;
  /** Scope the two switches resolve at; the same one `planWorkspaceTools` uses. */
  ctx?: { teamId?: string; orgId?: string };
  tracer?: AgentTracer;
}

/**
 * Let an agent ask for a pinned catalog tool by key. The platform runs the install
 * (`workspace.installTools`), not the agent's shell: no URL, script or checksum comes from the
 * agent, and the connection's deny list, the per-run cap and the catalog all apply. It never
 * throws — every refusal and failure is a structured result with a fixed message that names the
 * tool and the reason but carries no installer output or URL.
 */
export function createProvisionTool(options: ProvisionToolOptions) {
  return createTool({
    description: PROVISION_TOOL_DESCRIPTION,
    execute: ({ key, version }: { key: string; version?: string }) =>
      provisionToolCall(options, key, version),
    id: PROVISION_TOOL_KEY,
    inputSchema: ProvisionToolInput,
    outputSchema: OutputSchema,
  });
}

/**
 * {@link createProvisionTool} in the runtime-neutral shape a harness binds
 * (`workerTool.ts`): the same installer, the same grants, the same refusals and
 * the same trace rows, called from the other loop.
 */
export function provisionWorkerTool(options: ProvisionToolOptions): WorkerTool {
  return {
    call: async (args) => {
      const { key, version } = ProvisionToolInput.parse(args);
      return provisionToolCall(options, key, version);
    },
    description: PROVISION_TOOL_DESCRIPTION,
    inputSchema: ProvisionToolInput,
    name: PROVISION_TOOL_KEY,
    outputSchema: OutputSchema,
  };
}

/** One install attempt: the trace row both bindings above write, then the installer. */
async function provisionToolCall(
  options: ProvisionToolOptions,
  key: string,
  version: string | undefined
): Promise<ProvisionResult> {
  const start = Date.now();
  const result = await install(options, key, version);
  options.tracer?.addToolCall({
    durationMs: Date.now() - start,
    inputJson: { key, ...(version ? { version } : {}) },
    outputJson: result,
    toolName: PROVISION_TOOL_KEY,
    ...(result.ok ? {} : { error: result.error }),
  });
  return result;
}

async function install(
  options: ProvisionToolOptions,
  key: string,
  version: string | undefined
): Promise<ProvisionResult> {
  const { workspace, toolKeys, ctx } = options;
  const fail = (reason: string): ProvisionResult => ({
    error: `Could not install '${key}': ${reason}`,
    ok: false,
  });
  if (!grantsProvisionTool(toolKeys)) {
    return fail('this agent is not allowed to install tools.');
  }
  try {
    const settings = await resolveSettings(
      ['workspace.toolInstall.enabled', 'workspace.toolInstall.agentCallable'],
      {
        ...(ctx?.teamId ? { teamId: ctx.teamId } : {}),
        ...(ctx?.orgId ? { orgId: ctx.orgId } : {}),
      }
    );
    if (
      !settings['workspace.toolInstall.enabled'] ||
      !settings['workspace.toolInstall.agentCallable']
    ) {
      return fail('installing tools is not enabled for this workspace.');
    }
    if (!workspace.installTools) {
      return fail(
        'this workspace is not tied to a repository connection, so it cannot install tools.'
      );
    }
    const [installed] = await workspace.installTools([{ key, ...(version ? { version } : {}) }]);
    if (!installed) {
      return fail('the installer returned nothing.');
    }
    return {
      installed: {
        key: installed.key,
        version: installed.version,
        ...(installed.warning ? { warning: installed.warning } : {}),
      },
      ok: true,
    };
  } catch (err) {
    if (err instanceof ToolRefusal) {
      return fail(`${err.message}.${err.retryable ? ` ${RETRY_HINT}` : ''}`);
    }
    if (err instanceof ToolInstallError) {
      // The message may carry installer output (a download URL): say only what a retry can do.
      return fail(
        err.retryable
          ? `the download failed. ${RETRY_HINT}`
          : 'the installation failed and retrying will not help.'
      );
    }
    return fail(`an unexpected error occurred. ${RETRY_HINT}`);
  }
}
