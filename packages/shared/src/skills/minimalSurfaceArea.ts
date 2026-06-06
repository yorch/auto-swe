import type { BuiltinSkillDef } from './index.js';

export const MINIMAL_SURFACE_AREA_SKILL: BuiltinSkillDef = {
  assignments: [
    { role: 'IMPLEMENTER', sortOrder: 130 },
    { role: 'REVIEWER', sortOrder: 60 },
  ],
  description:
    'Requires that only the minimum necessary surface area is exported or made public, keeping internals private to reduce coupling and future refactor cost.',
  name: 'minimal-surface-area',
  promptText: `## Minimal Surface Area

Every exported symbol, public method, and accessible field is a commitment to every caller. Minimise what you expose.

**Default to private / unexported:**
- Functions, classes, constants, and types that are only used within the same module should not be exported.
- In TypeScript: prefer unexported module-level functions over exported helpers. Export only from the barrel (\`index.ts\`) what consumers genuinely need.
- In object design: prefer private fields and methods; expose only what callers must interact with.

**Avoid wide return types:**
- Return only the fields the caller needs, not the full DB row or the full internal object.
- In API responses: use an explicit response schema rather than spreading an ORM model; this prevents accidentally exposing internal fields (hashed passwords, audit columns, internal IDs).

**Avoid wide parameter types:**
- Accept the narrowest interface that satisfies the function's needs, not a broad supertype.
- Prefer positional or named parameters over passing entire objects when only one or two fields are used.

**Review checklist** — flag any diff that:
- Exports a symbol that is only used within the same file or package
- Returns a full ORM/DB row from an API endpoint without an explicit response schema
- Adds a new public method or export that duplicates something already exported elsewhere`,
};
