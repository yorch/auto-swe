/**
 * Natural-language workflow authoring helpers.
 *
 * These are the pure (I/O-free) pieces shared by the worker activity that
 * generates a {@link WorkflowSpec} from a plain-language intent, the gateway
 * route that persists the result, and the unit tests. The dynamic catalog
 * (which steps / agents / MCP connections exist in a given workspace) is built
 * by the caller from the DB and rendered here into the prompt the model sees.
 *
 * The static WorkflowSpec format + node-type reference + rules live in
 * `WORKFLOW_AUTHOR_PROMPT` (the seeded agent's system prompt); this module only
 * carries the *dynamic* catalog and the request/repair message scaffolding so
 * the LLM picks from real building blocks and never invents step/agent names.
 */

import { z } from 'zod';
import { listSteps } from './stepRegistry.js';

/**
 * Structured output the workflow-author agent returns. We deliberately ask for
 * the spec as a JSON *string* rather than a typed object: the WorkflowSpec is a
 * discriminated union of 15 node types, which round-trips poorly through the
 * provider's structured-output JSON-schema conversion. A string field is robust,
 * and `parseWorkflowSpec` is the real validation gate (with a repair loop on top).
 */
export const WorkflowAuthorOutputSchema = z.object({
  /** The WorkflowSpec serialized as a JSON string. */
  specJson: z.string().min(2),
  /** One- or two-sentence description of what the generated workflow does. */
  summary: z.string().default(''),
});
export type WorkflowAuthorOutput = z.infer<typeof WorkflowAuthorOutputSchema>;

/** A library Agent the author may reference via an `agent` node's `agentRef`. */
export interface AuthoringAgentRef {
  key: string;
  name: string;
  description?: string | null;
}

/** An `mcp` Connection the author may reference via an `mcp` node's `connectionRef`. */
export interface AuthoringMcpRef {
  id: string;
  name: string;
  description?: string | null;
}

export interface AuthoringCatalog {
  /** Library agents available in scope, by key. */
  agents: AuthoringAgentRef[];
  /** Active `mcp` Connections available in scope. */
  mcpConnections: AuthoringMcpRef[];
  /** Whether shell / containerStep authoring is permitted for the requester. */
  allowShell: boolean;
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Render the dynamic building-block catalog the model must choose from. Step
 * names come from the in-process registry; agents + MCP connections are passed
 * in by the caller (resolved from the DB at the requester's scope).
 */
export function renderAuthoringCatalog(catalog: AuthoringCatalog): string {
  const lines: string[] = [];

  lines.push('## Registered steps (use as `step` node "step" value)');
  for (const s of listSteps()) {
    lines.push(`- ${s.name} [${s.category}] — ${truncate(s.description, 160)}`);
  }

  lines.push('');
  lines.push('## Library agents (use as `agent` node "agentRef" value)');
  if (catalog.agents.length === 0) {
    lines.push('- (none available — avoid `agent` nodes)');
  } else {
    for (const a of catalog.agents) {
      const desc = a.description ? ` — ${truncate(a.description, 140)}` : '';
      lines.push(`- ${a.key} (${a.name})${desc}`);
    }
  }

  lines.push('');
  lines.push('## MCP connections (use as `mcp` node "connectionRef" value)');
  if (catalog.mcpConnections.length === 0) {
    lines.push('- (none available — do not emit `mcp` nodes)');
  } else {
    for (const c of catalog.mcpConnections) {
      const desc = c.description ? ` — ${truncate(c.description, 140)}` : '';
      lines.push(`- ${c.id} (${c.name})${desc}`);
    }
  }

  lines.push('');
  lines.push(
    catalog.allowShell
      ? '## Shell: allowed — `shell`/`containerStep` nodes are permitted if the intent needs a container command.'
      : '## Shell: NOT allowed — do not emit `shell` or `containerStep` nodes.'
  );

  return lines.join('\n');
}

/** Build the first user message: the catalog followed by the user's intent. */
export function buildAuthorRequestMessage(intent: string, catalog: AuthoringCatalog): string {
  return [
    'Generate a WorkflowSpec for the following request.',
    '',
    '# CATALOG',
    renderAuthoringCatalog(catalog),
    '',
    '# REQUEST',
    intent.trim(),
  ].join('\n');
}

/**
 * Build a repair message after a generated spec failed JSON parsing or
 * WorkflowSpec validation. Echoes the catalog + intent so the single-shot
 * `runAgent` call (which has no conversation memory) has full context, plus the
 * previous attempt and the concrete errors to fix.
 */
export function buildRepairRequestMessage(args: {
  intent: string;
  catalog: AuthoringCatalog;
  previousSpecJson: string;
  errors: string[];
}): string {
  return [
    'The previous WorkflowSpec was invalid. Fix the errors and return the corrected full spec.',
    '',
    '# ERRORS',
    ...args.errors.map((e) => `- ${e}`),
    '',
    '# PREVIOUS ATTEMPT (specJson)',
    truncate(args.previousSpecJson, 6000),
    '',
    '# CATALOG',
    renderAuthoringCatalog(args.catalog),
    '',
    '# REQUEST',
    args.intent.trim(),
  ].join('\n');
}
