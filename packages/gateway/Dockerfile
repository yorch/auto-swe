# ── Stage 1: Build ──
FROM node:24-alpine AS builder
WORKDIR /app

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
RUN corepack enable && yarn install --immutable

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
FROM node:24-alpine AS prod-deps
WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases ./.yarn/releases
COPY packages/cli/package.json packages/cli/
COPY packages/gateway/package.json packages/gateway/
COPY packages/sdk/package.json packages/sdk/
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
COPY packages/worker/package.json packages/worker/
RUN corepack enable && yarn workspaces focus @auto-swe/gateway --production \
 && mkdir -p packages/shared/node_modules packages/gateway/node_modules

# ── Stage 3: Runtime ──
FROM node:24-alpine
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

# Full builder node_modules. Prisma 7's CLI has internal deps (@prisma/config,
# effect, etc.) that the prod-deps focus excludes — a targeted COPY of just
# node_modules/prisma fails with "Cannot find module 'effect'" at runtime. We
# overlay the slimmer prod-deps tree with the full builder tree, trading
# image size for a working `migrate deploy` step. This is the workspace
# canonical pattern (mirrors nextjs-mvp-super-template, cierre-app, etc.).
COPY --from=builder /app/node_modules ./node_modules

# Prisma generated client. The `prisma-client` provider in
# packages/shared/src/prisma/schema.prisma outputs to a CUSTOM path
# (`output = "../generated/prisma"` → resolves to packages/shared/src/generated/prisma)
# — NOT `node_modules/.prisma` (which is where the older `prisma-client-js`
# provider puts it). The shared package's compiled dist imports from
# `./src/generated/prisma`, so that path must exist at runtime.
COPY --from=builder /app/packages/shared/src/generated ./packages/shared/src/generated

# Workspace package.json files (for symlink resolution)
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/gateway/package.json ./packages/gateway/

# Prisma schema + migrations + config (lives in @auto-swe/shared); required at
# runtime for `prisma migrate deploy` from docker-entrypoint.sh. The config
# uses relative paths (`src/prisma/schema.prisma`, `src/prisma/migrations`),
# so the entrypoint cd's into packages/shared before running prisma.
COPY --from=builder /app/packages/shared/prisma.config.ts ./packages/shared/
COPY --from=builder /app/packages/shared/src/prisma ./packages/shared/src/prisma

# Built output
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/gateway/dist ./packages/gateway/dist

# Workspace node_modules (symlinks)
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/packages/gateway/node_modules ./packages/gateway/node_modules

# Root package.json (for workspace symlink resolution)
COPY package.json ./

# Migrate-on-boot entrypoint
COPY packages/gateway/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Treat the image as production: the auth secret guards refuse the in-source
# dev fallbacks unless NODE_ENV is explicitly development/test.
ENV NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const p = process.env.PORT || 8080; require('http').get('http://127.0.0.1:' + p + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]

RUN chown -R node:node /app
USER node

# Runs `prisma migrate deploy` (idempotent), then the command below.
ENTRYPOINT ["/app/docker-entrypoint.sh"]

CMD ["node", "packages/gateway/dist/index.js"]
