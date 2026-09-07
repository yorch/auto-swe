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
# The glob avoids restating the version here; .yarn/releases holds exactly one
# release, and `yarnPath` in .yarnrc.yml is the thing that pins it. The shim
# resolves its target at invocation, not at build, so it may sit before the COPY
# and keep this layer cacheable.
RUN printf '#!/bin/sh\nexec node /app/.yarn/releases/yarn-*.cjs "$@"\n' \
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
RUN yarn workspaces focus auto-swe @auto-swe/shared @auto-swe/worker

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/worker/ packages/worker/

# prisma.config.ts eagerly resolves DATABASE_URL even for generate-only calls,
# so a placeholder is required (prisma-7-ci-generate-database-url pattern).
ENV DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
RUN yarn workspace @auto-swe/shared db:generate \
    && yarn workspace @auto-swe/shared build \
    && yarn workspace @auto-swe/worker build

# ── Stage 2: Production dependencies only ──
FROM node:26-alpine AS prod-deps
WORKDIR /app

# No `yarn` in node:26 — same vendored-release shim as the builder stage above.
RUN printf '#!/bin/sh\nexec node /app/.yarn/releases/yarn-*.cjs "$@"\n' \
      > /usr/local/bin/yarn && chmod +x /usr/local/bin/yarn

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases ./.yarn/releases
COPY packages/cli/package.json packages/cli/
COPY packages/gateway/package.json packages/gateway/
COPY packages/sdk/package.json packages/sdk/
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
COPY packages/worker/package.json packages/worker/
RUN yarn workspaces focus @auto-swe/worker --production \
    && mkdir -p packages/shared/node_modules packages/worker/node_modules

# ── Stage 3: Runtime ──
# glibc base, NOT alpine. @temporalio/core-bridge ships only `-gnu` prebuilds
# (x86_64/aarch64-unknown-linux-gnu) — there is no musl build — so on alpine the
# worker died at startup with:
#   Error loading shared library ld-linux-x86-64.so.2 ... core-bridge/.../index.node
# `gcompat` is not enough: the shim loads but then fails symbol relocation.
#
# Moving this tag from 24 to 26 also crossed a Debian major — bookworm (glibc
# 2.36) to trixie (glibc 2.41) — which the diff does not show. Nothing here
# apt-installs, so there is no pinned package to break, and glibc is backward
# compatible so the `-gnu` core-bridge prebuild still loads; recorded because a
# future OS-level surprise in this stage will not look Node-related.
FROM node:26-slim

# Worker needs Docker CLI to manage workspace containers (DinD). Compose adds
# the host Docker socket group at runtime with DOCKER_GID. Taken from the
# official CLI image rather than apt, which keeps it pinned and avoids pulling
# the whole docker.io package (daemon included) into the runtime.
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker
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

# Production node_modules (hoisted root deps). Includes the @prisma/client +
# @prisma/adapter-pg runtime (both are prod deps of @auto-swe/shared); the
# `prisma` CLI is dev-only and not needed here (the worker doesn't migrate).
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules

# Prisma generated client. The `prisma-client` provider in
# packages/shared/src/prisma/schema.prisma outputs to a CUSTOM path
# (`output = "../generated/prisma"` → resolves to packages/shared/src/generated/prisma)
# — NOT `node_modules/.prisma` (the older `prisma-client-js` location). The
# shared package's compiled dist imports from `./src/generated/prisma`, so that
# path must exist at runtime.
COPY --from=builder --chown=node:node /app/packages/shared/src/generated ./packages/shared/src/generated

# Workspace package.json files (for symlink resolution)
COPY --from=builder --chown=node:node /app/packages/shared/package.json ./packages/shared/
COPY --from=builder --chown=node:node /app/packages/worker/package.json ./packages/worker/

# Built output
COPY --from=builder --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=node:node /app/packages/worker/dist ./packages/worker/dist

# Workspace node_modules (symlinks)
COPY --from=prod-deps --chown=node:node /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/worker/node_modules ./packages/worker/node_modules

# Root package.json (for workspace symlink resolution)
COPY --chown=node:node package.json ./

ENV NODE_ENV=production

# Ownership is set on each COPY above. The recursive form rewrites every
# file's metadata into a new layer, storing the whole tree — node_modules
# included — a second time; it cost 608MB in this image. The WORKDIR itself
# is still created by root, so chown that one directory (single inode).
RUN chown node:node /app
USER node
CMD ["node", "packages/worker/dist/index.js"]
