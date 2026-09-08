# ── Stage 1: Build ──
FROM node:26-alpine AS builder
WORKDIR /app

# node:26 ships no Corepack — it left the Node distribution in Node 25 — so the
# image has no `yarn` on PATH and every `yarn` call below exits 127.
#
# The missing piece is only the NAME. .yarn/releases/yarn-4.18.0.cjs is already
# a complete entry point: mode 755, `#!/usr/bin/env node` shebang, and it runs
# offline on a stock node:26-alpine with no Corepack present. So this shim is
# the whole fix, and it keeps the build hermetic — installing Corepack instead
# would fetch it from npm and then fetch a second Yarn from repo.yarnpkg.com
# that `yarnPath` guarantees is never executed. Neither of those fetches is
# covered by `npmMinimalAgeGate`, which is a Yarn-side resolution setting.
#
# The release is resolved through `yarnPath`, which is the one place the version
# is pinned, so it is not restated here. A glob over .yarn/releases also avoids
# restating it but breaks the day that directory holds two files — `yarn set
# version` leaves the old release behind — because the extra path is then passed
# as argv[1]: `yarn --version` still answers correctly while real subcommands
# fail with "No project found in .../yarn-<old>.cjs". Reading yarnPath cannot
# land in that state.
#
# Resolution happens at invocation, not at build, so this may sit before the
# COPY and keep the layer cacheable.
RUN printf '%s\n' '#!/bin/sh' 'exec node "/app/$(sed -n "s/^yarnPath: *//p" /app/.yarnrc.yml)" "$@"' \
      > /usr/local/bin/yarn && chmod +x /usr/local/bin/yarn

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases ./.yarn/releases
COPY packages/cli/package.json packages/cli/
COPY packages/gateway/package.json packages/gateway/
COPY packages/sdk/package.json packages/sdk/
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
COPY packages/worker/package.json packages/worker/
# The root `postinstall` runs `prisma generate`, so the schema must be present
# before install. Copying it here (rather than skipping build scripts) keeps
# native dependency builds working.
COPY packages/shared/prisma.config.ts packages/shared/
COPY packages/shared/src/prisma packages/shared/src/prisma
RUN yarn workspaces focus auto-swe @auto-swe/shared @auto-swe/gateway

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/gateway/ packages/gateway/

# prisma.config.ts eagerly resolves DATABASE_URL even for generate-only calls,
# so a placeholder is required (prisma-7-ci-generate-database-url pattern).
ENV DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
RUN yarn workspace @auto-swe/shared db:generate \
  && yarn workspace @auto-swe/shared build \
  && yarn workspace @auto-swe/gateway build

# ── Stage 2: Production dependencies only ──
FROM node:26-alpine AS prod-deps
WORKDIR /app

# No `yarn` in node:26 — same vendored-release shim as the builder stage above.
RUN printf '%s\n' '#!/bin/sh' 'exec node "/app/$(sed -n "s/^yarnPath: *//p" /app/.yarnrc.yml)" "$@"' \
      > /usr/local/bin/yarn && chmod +x /usr/local/bin/yarn

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases ./.yarn/releases
COPY packages/cli/package.json packages/cli/
COPY packages/gateway/package.json packages/gateway/
COPY packages/sdk/package.json packages/sdk/
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
COPY packages/worker/package.json packages/worker/
RUN yarn workspaces focus @auto-swe/gateway --production \
  && mkdir -p packages/shared/node_modules packages/gateway/node_modules

# ── Stage 3: Runtime ──
FROM node:26-alpine
WORKDIR /app

ARG APP_VERSION=unknown
ARG COMMIT_HASH=unknown
ARG BUILD_TIME=unknown
ARG GIT_BRANCH=unknown
ARG GIT_TAG=unknown
ARG GIT_TIMESTAMP=unknown
ARG BUILD_NUMBER=unknown

ENV APP_VERSION=${APP_VERSION} \
  COMMIT_HASH=${COMMIT_HASH} \
  BUILD_TIME=${BUILD_TIME} \
  GIT_BRANCH=${GIT_BRANCH} \
  GIT_TAG=${GIT_TAG} \
  GIT_TIMESTAMP=${GIT_TIMESTAMP} \
  BUILD_NUMBER=${BUILD_NUMBER}

# Production dependency tree only. The entrypoint runs the Prisma 7 CLI
# (`node_modules/prisma/build/index.js migrate deploy`), and that CLI has
# internal deps (@prisma/config, effect, …) — so `prisma` is declared as a
# runtime dependency of this package and `yarn workspaces focus --production`
# resolves its full transitive closure here. That is what a targeted
# `COPY node_modules/prisma` could never do, and why this used to overlay the
# entire builder tree instead.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules

# Prisma generated client. The `prisma-client` provider in
# packages/shared/src/prisma/schema.prisma outputs to a CUSTOM path
# (`output = "../generated/prisma"` → resolves to packages/shared/src/generated/prisma)
# — NOT `node_modules/.prisma` (which is where the older `prisma-client-js`
# provider puts it). The shared package's compiled dist imports from
# `./src/generated/prisma`, so that path must exist at runtime.
COPY --from=builder --chown=node:node /app/packages/shared/src/generated ./packages/shared/src/generated

# Workspace package.json files (for symlink resolution)
COPY --from=builder --chown=node:node /app/packages/shared/package.json ./packages/shared/
COPY --from=builder --chown=node:node /app/packages/gateway/package.json ./packages/gateway/

# Prisma schema + migrations + config (lives in @auto-swe/shared); required at
# runtime for `prisma migrate deploy` from docker-entrypoint.sh. The config
# uses relative paths (`src/prisma/schema.prisma`, `src/prisma/migrations`),
# so the entrypoint cd's into packages/shared before running prisma.
COPY --from=builder --chown=node:node /app/packages/shared/prisma.config.ts ./packages/shared/
COPY --from=builder --chown=node:node /app/packages/shared/src/prisma ./packages/shared/src/prisma

# Built output
COPY --from=builder --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=node:node /app/packages/gateway/dist ./packages/gateway/dist

# Workspace node_modules (symlinks)
COPY --from=prod-deps --chown=node:node /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/gateway/node_modules ./packages/gateway/node_modules

# Root package.json (for workspace symlink resolution)
COPY --chown=node:node package.json ./

# Migrate-on-boot entrypoint
COPY --chown=node:node --chmod=755 packages/gateway/docker-entrypoint.sh /app/docker-entrypoint.sh

# Treat the image as production: the auth secret guards refuse the in-source
# dev fallbacks unless NODE_ENV is explicitly development/test.
ENV NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const p = process.env.PORT || 8080; require('http').get('http://127.0.0.1:' + p + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]

# Ownership is set on each COPY above rather than with a trailing
# `RUN chown -R node:node /app`. That RUN rewrote every file's metadata in a new
# layer, so the whole tree — node_modules included — was stored twice: it cost
# another ~450MB on top of the ~430MB it was duplicating.
#
# The WORKDIR itself is still created by root, so chown just that one directory
# (metadata on a single inode — it does not copy the contents up into a new
# layer the way the recursive form did).
RUN chown node:node /app
USER node

# Runs `prisma migrate deploy` (idempotent), then the command below.
ENTRYPOINT ["/app/docker-entrypoint.sh"]

CMD ["node", "packages/gateway/dist/index.js"]
