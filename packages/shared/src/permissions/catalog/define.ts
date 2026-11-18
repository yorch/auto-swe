import type { CapabilityDef } from '../types.js';

/**
 * Declares a group of capabilities. The identity function exists for its type: `const T` keeps each
 * key a string literal, so the aggregate catalog's `CapabilityKey` union names every capability and
 * a misspelt key is a compile error at every call site.
 */
export function defineCapabilities<const T extends Record<string, CapabilityDef>>(defs: T): T {
  return defs;
}
