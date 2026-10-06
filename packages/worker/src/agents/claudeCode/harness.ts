import { ApplicationFailure } from '@temporalio/activity';
import { defineHarness } from '../harness/registry.js';
import { CLAUDE_CODE_CAPABILITIES, harnessToolsGranting } from './policy.js';
import { type ClaudeCodeAccess, claudeCodeRuntime } from './runtime.js';

const ANTHROPIC_PREFIX = 'anthropic/';

/**
 * Claude Code in the harness registry.
 *
 * The harness runs on the same Agent row, and the same decrypted credential,
 * the Mastra runtime would have used. Claude Code speaks the Anthropic Messages
 * API, so the Agent's model must be an Anthropic one. Pointing the credential's
 * `apiBase` at a gateway that routes to Anthropic is how a deployment sends the
 * harness through its own gateway.
 */
export const claudeCodeHarness = defineHarness<ClaudeCodeAccess>({
  bindModel(agentKey, model) {
    if (!model.spec.startsWith(ANTHROPIC_PREFIX)) {
      throw ApplicationFailure.nonRetryable(
        `The claude-code runtime needs an Anthropic model, but agent '${agentKey}' resolves to '${model.spec}'. Set the agent's model to anthropic/<model>, or set its runtime (or workspace.implementerRuntime) back to mastra.`,
        'HARNESS_UNSUPPORTED_MODEL'
      );
    }
    return {
      apiBase: model.apiBase ?? undefined,
      apiKey: model.apiKey,
      modelId: model.spec.slice(ANTHROPIC_PREFIX.length),
    };
  },
  capabilities: CLAUDE_CODE_CAPABILITIES,
  createRuntime: ({ exactToolKeys, ...options }) =>
    claudeCodeRuntime(
      exactToolKeys ? { ...options, tools: harnessToolsGranting(exactToolKeys) } : options
    ),
  kind: 'claude-code',
  label: 'Claude Code',
});
