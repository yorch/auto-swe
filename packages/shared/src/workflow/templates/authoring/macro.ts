/**
 * The authored form of a built-in template.
 *
 * A template calls {@link macro} where it used to call a helper directly, and
 * {@link authored} where it used to call `mergeNodes`. The result is the same
 * flat `nodes` map (the helper's output, each node additionally tagged
 * `use: <useId>`) together with the spec's top-level `uses` map recording the
 * macro and the arguments that produced them, so the stored spec carries its
 * authored form beside the flat one (see `workflow/macros.ts`).
 *
 * This file is deliberately NOT exported from `./index.js`: `macros.ts` imports
 * that barrel for the helpers, and this file imports `macros.ts` for
 * `expandUse`, so exporting it there would close an import cycle.
 */

import { expandUse } from '../../macros.js';
import type { WorkflowSpec } from '../../spec.js';
import {
  type CiLoopOptions,
  mergeNodes,
  type NodeMap,
  type OpenPullRequestOptions,
  type ReviewLoopOptions,
  type ValidatePhaseOptions,
} from './index.js';

type Uses = NonNullable<WorkflowSpec['uses']>;

/** The argument type of each macro, by `<name>@<version>`. */
export interface MacroArgsByRef {
  'ciLoop@1': CiLoopOptions;
  'openPullRequest@1': OpenPullRequestOptions;
  'reviewLoop@1': ReviewLoopOptions;
  'validatePhase@1': ValidatePhaseOptions;
}

/** Tagged nodes plus the `uses` entries that account for the tags. */
export interface Authored {
  nodes: NodeMap;
  uses?: Uses;
}

const authoredResults = new WeakSet<object>();

function brand(value: Authored): Authored {
  authoredResults.add(value);
  return value;
}

/**
 * One macro use: the helper's nodes, each tagged `use: useId`, and the `uses`
 * entry for it. Arguments must satisfy the macro's schema (plain JSON); the
 * expansion throws a `MacroUseError` naming the use otherwise.
 */
export function macro<K extends keyof MacroArgsByRef>(
  useId: string,
  ref: K,
  args: MacroArgsByRef[K]
): Authored {
  const use = { args: structuredClone(args) as unknown as Record<string, unknown>, macro: ref };
  return brand({ nodes: expandUse(useId, use), uses: { [useId]: use } });
}

/**
 * `mergeNodes` for a spec that has macro uses: merges plain node maps and
 * {@link macro} / {@link authored} results, failing on a duplicate node id or use
 * id, and returns `{ nodes, uses }` to spread into the spec. `uses` is omitted
 * when no part carried one.
 */
export function authored(...parts: Array<NodeMap | Authored | undefined>): Authored {
  const uses: Uses = {};
  const maps = parts.map((part) => {
    if (part !== undefined && authoredResults.has(part)) {
      const a = part as Authored;
      for (const [id, use] of Object.entries(a.uses ?? {})) {
        if (Object.hasOwn(uses, id)) {
          throw new Error(`duplicate use id '${id}': declared by more than one part of the spec`);
        }
        uses[id] = use;
      }
      return a.nodes;
    }
    return part as NodeMap | undefined;
  });
  const result: Authored = { nodes: mergeNodes(...maps) };
  if (Object.keys(uses).length > 0) {
    result.uses = uses;
  }
  return brand(result);
}
