import type { BuiltinSkillDef } from './index.js';

export const ASYNC_SAFETY_SKILL: BuiltinSkillDef = {
  assignments: [
    { role: 'implementer', sortOrder: 100 },
    { role: 'reviewer', sortOrder: 40 },
  ],
  description:
    'Prevents async bugs: missing awaits, unhandled rejections, concurrent mutation of shared state, and incorrect Promise.all vs sequential patterns.',
  name: 'async-safety',
  promptText: `## Async Safety

Async bugs are silent — they do not always throw at the call site. Apply these checks to every async code path:

**Missing awaits**
- Every \`async\` function call must be \`await\`ed unless the fire-and-forget is intentional and documented with \`void\`.
- Do not \`return someAsyncFn()\` from an \`async\` function when you need the error to be caught by the caller's try/catch — \`await\` it first.

**Unhandled promise rejections**
- Never discard a Promise without a \`.catch()\` or \`await\` in a try/catch.
- \`void fn()\` is acceptable for intentional fire-and-forget, but the function itself must handle its own errors internally.

**Concurrent mutation**
- Do not mutate shared state (object properties, array elements, module-level variables) from multiple concurrent async paths without a lock or atomic operation.
- Prefer immutable updates and pass results through return values rather than mutating a shared reference.

**Promise.all vs sequential**
- Use \`Promise.all\` when operations are independent and can run concurrently.
- Use sequential \`await\` when each step depends on the result of the previous, or when concurrent execution would exceed rate limits or cause contention.
- Use \`Promise.allSettled\` when you want all results regardless of individual failures.

**Review checklist** — flag any of:
- An \`async\` function call not preceded by \`await\` or \`void\`
- A \`.then()\` chain that omits a \`.catch()\`
- \`Promise.all\` over operations that write to the same resource
- Sequential \`await\` inside a loop where \`Promise.all\` would be correct`,
};
