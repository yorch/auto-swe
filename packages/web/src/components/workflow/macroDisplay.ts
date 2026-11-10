/**
 * How a macro use (an entry of the spec's `uses` map, see `workflow/macros.ts`)
 * is named on screen: the macro's friendly name and the use id, `CI loop · ci`.
 *
 * Kept apart from `macroEdits` so the read-only graph can name a folded use
 * without pulling in the edit helpers.
 */
import type { WorkflowSpec } from '@auto-swe/shared/workflow';

/**
 * Friendly names by macro name (the part of a ref before `@`). A version bump
 * keeps its name; a macro missing here reads by its raw name, so a new macro is
 * never unnamed — it is only less friendly until it is added.
 */
export const MACRO_FRIENDLY_NAMES: Readonly<Record<string, string>> = {
  ciLoop: 'CI loop',
  openPullRequest: 'Open pull request',
  reviewLoop: 'Review loop',
  validatePhase: 'Validate phase',
};

/** The friendly name of a macro ref (`'ciLoop@1'` -> `'CI loop'`). */
export function macroFriendlyName(ref: string | undefined): string {
  if (!ref) {
    return 'Macro';
  }
  const name = ref.split('@')[0] ?? ref;
  return MACRO_FRIENDLY_NAMES[name] ?? (name || 'Macro');
}

/** The macro ref a use declares, or undefined for a tag with no (or a malformed) `uses` entry. */
export function macroRefOfUse(spec: Pick<WorkflowSpec, 'uses'>, useId: string): string | undefined {
  const uses = spec.uses;
  if (!uses || !Object.hasOwn(uses, useId)) {
    return undefined;
  }
  const macro = (uses[useId] as { macro?: unknown }).macro;
  return typeof macro === 'string' ? macro : undefined;
}

/** What a use is called on screen: `CI loop · ci`. */
export function macroUseDisplayName(spec: Pick<WorkflowSpec, 'uses'>, useId: string): string {
  return `${macroFriendlyName(macroRefOfUse(spec, useId))} · ${useId}`;
}
