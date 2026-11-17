import {
  CancelIntentSchema,
  MessageIntentSchema,
  RequestRepoIntentSchema,
  SpawnIntentSchema,
} from '@auto-swe/shared/lib/orchestration';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { OrchestratorIntent } from '../lib/orchestrationTypes.js';

/**
 * The orchestrator's four tools. They perform NOTHING: each validates the shape of its input with
 * the shared schema and records the intent into the turn's collector, then returns a structured
 * acknowledgement. They hold no gateway client, no database handle and no credentials, so a
 * prompt-injected orchestrator can ask for things but cannot do any of them. After the turn,
 * `applyOrchestrationIntents` (fixed code) validates each recorded intent against the platform's
 * rules and applies it or refuses it (`docs/specs/2026-11-17-orchestrated-agent-runs.md` §2, §11).
 *
 * Modelled on the channel assistant's `delegateTask`.
 */

/** Most intents one turn may record; a model that loops cannot flood the apply step. */
export const MAX_INTENTS_PER_TURN = 16;

export const ORCHESTRATOR_TOOL_IDS = [
  'spawnAgent',
  'messageAgent',
  'cancelAgent',
  'requestRepo',
] as const;

/** Collects the intents one turn records. A fresh instance per turn. */
export class IntentCollector {
  private readonly recorded: OrchestratorIntent[] = [];

  get intents(): OrchestratorIntent[] {
    return [...this.recorded];
  }

  /** Records `intent`; false when the turn already recorded as many as it may. */
  add(intent: OrchestratorIntent): boolean {
    if (this.recorded.length >= MAX_INTENTS_PER_TURN) {
      return false;
    }
    this.recorded.push(intent);
    return true;
  }

  /** Whether the turn already asked for a repository: at most one request per turn. */
  hasRepoRequest(): boolean {
    return this.recorded.some((i) => i.kind === 'requestRepo');
  }
}

const AckSchema = z.object({
  note: z.string(),
  recorded: z.boolean(),
});

type Ack = z.infer<typeof AckSchema>;

function rejected(note: string): Ack {
  return { note, recorded: false };
}

function issueSummary(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
    .join('; ');
}

export function createOrchestratorTools(collector: IntentCollector) {
  const full = 'Too many requests this turn; wait for the outcome of the earlier ones.';

  const spawnAgent = createTool({
    description:
      'Ask for a sub-agent to be started. Records a request only; platform code checks it against the allowlist, limits and path-scope rules and starts it, or refuses it and tells you in a later turn. ' +
      'role "reader" investigates and delivers nothing. role "writer" changes a repository (needs a repository, deliver "branch" or "draft_pr", and at least one path scope).',
    execute: async (input) => {
      const parsed = SpawnIntentSchema.safeParse(input);
      if (!parsed.success) {
        return rejected(`Not recorded: ${issueSummary(parsed.error)}`);
      }
      if (!collector.add({ intent: parsed.data, kind: 'spawn' })) {
        return rejected(full);
      }
      return {
        note: `Recorded a request to start "${parsed.data.label}". It has not started yet; you will be told the outcome.`,
        recorded: true,
      };
    },
    id: 'spawnAgent',
    inputSchema: SpawnIntentSchema,
    outputSchema: AckSchema,
  });

  const messageAgent = createTool({
    description:
      'Ask for a steering message to be delivered to a running child agent you started. It reaches the child at its next step boundary, and only on loops that can take a message mid-run.',
    execute: async (input) => {
      const parsed = MessageIntentSchema.safeParse(input);
      if (!parsed.success) {
        return rejected(`Not recorded: ${issueSummary(parsed.error)}`);
      }
      if (!collector.add({ intent: parsed.data, kind: 'message' })) {
        return rejected(full);
      }
      return { note: 'Recorded a request to message that child.', recorded: true };
    },
    id: 'messageAgent',
    inputSchema: MessageIntentSchema,
    outputSchema: AckSchema,
  });

  const cancelAgent = createTool({
    description:
      'Ask for a running child agent to be cancelled. Branches it already pushed stay in place.',
    execute: async (input) => {
      const parsed = CancelIntentSchema.safeParse(input);
      if (!parsed.success) {
        return rejected(`Not recorded: ${issueSummary(parsed.error)}`);
      }
      if (!collector.add({ intent: parsed.data, kind: 'cancel' })) {
        return rejected(full);
      }
      return { note: 'Recorded a request to cancel that child.', recorded: true };
    },
    id: 'cancelAgent',
    inputSchema: CancelIntentSchema,
    outputSchema: AckSchema,
  });

  const requestRepo = createTool({
    description:
      'Ask the person to attach a repository, with a short reason. Only the person can attach one, by confirming a card; at most one request can be open at a time.',
    execute: async (input) => {
      const parsed = RequestRepoIntentSchema.safeParse(input);
      if (!parsed.success) {
        return rejected(`Not recorded: ${issueSummary(parsed.error)}`);
      }
      if (collector.hasRepoRequest()) {
        return rejected('A repository request is already recorded for this turn.');
      }
      if (!collector.add({ intent: parsed.data, kind: 'requestRepo' })) {
        return rejected(full);
      }
      return {
        note: 'Recorded a request for a repository. The person must confirm before one is attached.',
        recorded: true,
      };
    },
    id: 'requestRepo',
    inputSchema: RequestRepoIntentSchema,
    outputSchema: AckSchema,
  });

  return { cancelAgent, messageAgent, requestRepo, spawnAgent };
}
