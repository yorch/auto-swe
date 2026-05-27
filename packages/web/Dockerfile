FROM node:24-alpine AS builder

WORKDIR /app

# Copy root package files
COPY package.json yarn.lock .yarnrc.yml ./
# Vendored yarn binary referenced by .yarnrc.yml's `yarnPath`
COPY .yarn/releases ./.yarn/releases

# Workspace package.json files — all 5 needed for `yarn install --immutable`
# to satisfy the `workspaces: ["packages/*"]` topology check.
COPY packages/cli/package.json packages/cli/
COPY packages/gateway/package.json packages/gateway/
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
COPY packages/worker/package.json packages/worker/

RUN corepack enable && yarn install --immutable

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/web packages/web
COPY docs docs

# `tsc` on @auto-swe/shared imports from its generated Prisma client, so
# generate must precede shared/build. prisma.config.ts eagerly resolves
# `DATABASE_URL` even for generate-only calls, so a placeholder is required
# (see the prisma-7-ci-generate-database-url pattern).
ENV DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
RUN yarn workspace @auto-swe/shared prisma generate \
 && yarn workspace @auto-swe/shared build \
 && yarn workspace @auto-swe/web build \
 && mkdir -p packages/web/public

# ── Runtime ──
FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

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

# Next.js standalone output includes everything needed
COPY --from=builder /app/packages/web/.next/standalone ./
COPY --from=builder /app/packages/web/.next/static ./packages/web/.next/static
COPY --from=builder /app/packages/web/public ./packages/web/public

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]

RUN chown -R node:node /app
USER node
CMD ["node", "packages/web/server.js"]
