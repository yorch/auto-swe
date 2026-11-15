import type { PrismaClient } from '@auto-swe/shared';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { runtimeModelError } from '@auto-swe/shared/types/api';

/** The runtime settings whose `claude-code` value strands agents on a model the harness cannot drive. */
export const RUNTIME_SETTING_KEYS = ['workspace.agentRunRuntime', 'workspace.implementerRuntime'];

/**
 * The personas the worker runs through the implementer turn runner (`buildImplementerTurnRunner`),
 * which is what `workspace.implementerRuntime` selects for. The worker decides by caller, not by
 * inheritance, so this is a fixed set: a custom persona inheriting from `implementer` is not one.
 */
export const IMPLEMENTER_RUNTIME_AGENT_KEYS = [
  'implementer',
  'gateFixer',
  'reviewFixer',
  'ciFixer',
  'mergeConflictResolver',
];

/** How many agents a warning names before it says `+N more`. */
export const RUNTIME_WARNING_AGENT_CAP = 8;

type AgentReader = Pick<PrismaClient, 'agent'>;

interface Row {
  inheritsModelFrom: string | null;
  key: string;
  modelSpec: string | null;
  runtime: string | null;
}

/**
 * The key's lineage as the worker's `walkModelChain` (agentResolver.ts) follows it: itself, then
 * each `inheritsModelFrom` parent, stopping at the first row that names a model of its own. That
 * row's runtime still counts; nothing beyond it does.
 */
function chain(byKey: Map<string, Row>, from: string): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  let key: string | null = from;
  while (key && !seen.has(key)) {
    seen.add(key);
    const row = byKey.get(key);
    if (!row) {
      break;
    }
    rows.push(row);
    if (row.modelSpec) {
      break;
    }
    key = row.inheritsModelFrom;
  }
  return rows;
}

/**
 * Advisory note for saving a runtime setting: the platform-wide active agents that name no runtime
 * of their own (directly or along their `inheritsModelFrom` chain) and so follow the setting, but
 * whose resolved model the harness cannot drive. Their runs would fail with
 * `HARNESS_UNSUPPORTED_MODEL`. Only `claude-code` strands anything: `pi` drives any model, and
 * Mastra is the loop every model supports. Scoped overrides are not walked; a run resolving one is
 * checked when it runs. One read of the GLOBAL rows, none for any other key or value.
 */
export async function runtimeSettingWarnings(
  prisma: AgentReader,
  key: string,
  value: unknown
): Promise<string[]> {
  if (!RUNTIME_SETTING_KEYS.includes(key) || value !== 'claude-code') {
    return [];
  }
  // GLOBAL rows belong to no tenant, and only a platform ADMIN reaches this (both settings
  // require it), so the read is marked unscoped rather than tenant-filtered.
  const rows = await runUnscoped(
    'a platform admin saving a runtime setting reads the platform-wide (GLOBAL) agent rows',
    ['Agent'],
    () =>
      prisma.agent.findMany({
        distinct: ['key'],
        orderBy: [{ key: 'asc' }, { version: 'desc' }],
        select: { inheritsModelFrom: true, key: true, modelSpec: true, runtime: true },
        where: { isActive: true, scope: 'GLOBAL' },
      })
  );
  // `distinct` keeps the first row per key in this order, the newest version; the map guards it.
  const byKey = new Map<string, Row>();
  for (const row of rows) {
    if (!byKey.has(row.key)) {
      byKey.set(row.key, row);
    }
  }

  const affected: string[] = [];
  for (const row of byKey.values()) {
    const lineage = chain(byKey, row.key);
    if (
      key === 'workspace.implementerRuntime' &&
      !IMPLEMENTER_RUNTIME_AGENT_KEYS.includes(row.key)
    ) {
      continue;
    }
    if (lineage.some((r) => r.runtime)) {
      continue; // has an opinion of its own: the setting is not what selects its loop
    }
    const spec = lineage[lineage.length - 1]?.modelSpec;
    // The same check the agent save applies to a version's own model.
    if (spec && runtimeModelError('claude-code', spec)) {
      affected.push(`${row.key} (${spec})`);
    }
  }
  if (affected.length === 0) {
    return [];
  }
  affected.sort();
  const shown = affected.slice(0, RUNTIME_WARNING_AGENT_CAP).join(', ');
  const more =
    affected.length > RUNTIME_WARNING_AGENT_CAP
      ? ` +${affected.length - RUNTIME_WARNING_AGENT_CAP} more`
      : '';
  const when =
    key === 'workspace.agentRunRuntime'
      ? 'when run as an agent run or `agent` node'
      : 'when run as the implementer';
  return [
    `${key} = claude-code: ${affected.length} platform-wide agent${affected.length === 1 ? '' : 's'} that follow it (scoped overrides are not checked) use a model the harness cannot drive (it needs anthropic/…) and fail with HARNESS_UNSUPPORTED_MODEL ${when}: ${shown}${more}. Give them an Anthropic model or their own runtime, or keep this setting on mastra.`,
  ];
}
