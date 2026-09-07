---
name: prisma-docker-migrations
description: Run Prisma migrations from inside a Yarn 4 production Docker image. Use when editing packages/*/Dockerfile, when a runtime container calls `prisma migrate deploy`, or when a built image fails at boot with a missing @prisma/config, effect, or .bin/prisma error.
---

# Running the Prisma CLI from a production image

The gateway's entrypoint runs `node_modules/prisma/build/index.js migrate deploy` before starting
Fastify. That makes the Prisma CLI a **runtime** dependency of an image built with
`yarn workspaces focus <pkg> --production`, and the two facts fight each other in ways that only
surface after the image is built.

## The rule

Declare `prisma` in the package's **`dependencies`**, not `devDependencies`.

```jsonc
// packages/gateway/package.json
{
  "dependencies": {
    "prisma": "7.8.0"        // ← runtime entrypoint calls it; NOT devDependencies
  }
}
```

`yarn workspaces focus --production` strips `devDependencies` *and everything reachable only
through them*. The CLI's own transitive deps (`@prisma/config`, `effect`, …) go with it, so the
binary survives but its imports do not — the failure is at container start, not at build.

## What does not work

| Attempted fix | Why it fails |
|---|---|
| `COPY --from=builder /app/node_modules/prisma ./node_modules/prisma` | Copies the CLI without its transitive deps. Same crash, later in the layer. |
| Copying the whole builder `node_modules` | Works, and costs ~2 GB. The point of the prod-deps stage is to not do this. |
| Keeping `prisma` in `devDependencies` and adding a fourth stage | The focus resolution is what prunes the tree; another stage does not change it. |

## Related Dockerfile invariants

These live in the same 3-stage build (builder → prod-deps → runtime) and break the same way:

- **The generated client is at `packages/shared/src/generated/prisma`**, not `node_modules/.prisma`
  — the `prisma-client` provider writes to the schema's `output` path. Copy that directory from
  builder to runtime explicitly.
- **Set ownership with `COPY --chown`, never a trailing `RUN chown -R /app`.** The recursive form
  rewrites every file's metadata into a new layer, storing the whole tree — `node_modules`
  included — twice.
- **Root `package.json` must be in the runtime image** so workspace symlinks resolve.
- **Put a `yarn` on `PATH` in every stage that runs `yarn`, and in no other.** `node:26` has none —
  Corepack left the Node distribution in Node 25, and the image ships `npm` alone — so a builder or
  prod-deps stage without one fails at its first `yarn` line with **exit 127**. The runtime stages
  must NOT have one: they only run `node`.

  Use the vendored release, not Corepack. `.yarn/releases/yarn-*.cjs` is already a complete entry
  point (mode 755, `#!/usr/bin/env node`) and runs offline on a stock `node:26-alpine`; only the
  *name* is missing, so a two-line shim is the whole fix:

  ```dockerfile
  RUN printf '#!/bin/sh\nexec node /app/.yarn/releases/yarn-*.cjs "$@"\n' \
        > /usr/local/bin/yarn && chmod +x /usr/local/bin/yarn
  ```

  Installing Corepack instead works but is strictly more machinery: it fetches from npm, then
  fetches a *second* Yarn from `repo.yarnpkg.com` that `yarnPath` guarantees is never executed —
  two network dependencies and one more version to pin, for the same result. Neither fetch is
  covered by `npmMinimalAgeGate`. The shim resolves its target at invocation, so it can sit before
  the `COPY` and keep that layer cacheable.

  The agent **executor** image (`defaults/Dockerfile.node`) is the opposite case and does install
  Corepack: it is a sandbox where arbitrary target repos get built, so it needs a real `yarn`/`pnpm`
  toolchain, not a launcher for this repo's own vendored Yarn.

## Preferred deployment shape

A one-shot init container that runs `migrate deploy` and exits, with the app container depending on
its completion. It keeps the migration out of the request-serving image's startup path, so a failed
migration is a failed init rather than a crash-looping service.

`prisma migrate deploy` is idempotent; `prisma migrate dev` must never run against production — see
the `prisma-pgvector-hnsw` skill for what it does to the HNSW index.
