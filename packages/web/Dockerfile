FROM node:24-alpine AS builder

WORKDIR /app

# Copy root package files
COPY package.json yarn.lock .yarnrc.yml ./
# Vendored yarn binary referenced by .yarnrc.yml's `yarnPath`
COPY .yarn/releases ./.yarn/releases

# The root `postinstall` runs `prisma generate`, so the schema must be present
# before install. Copying it here (rather than skipping build scripts) keeps
# native dependency builds working.
COPY packages/shared/prisma.config.ts packages/shared/
COPY packages/shared/src/prisma packages/shared/src/prisma
# Workspace package.json files — all 6 needed for Yarn to satisfy the
# `workspaces: ["packages/*"]` topology check.
COPY packages/cli/package.json packages/cli/
COPY packages/gateway/package.json packages/gateway/
COPY packages/sdk/package.json packages/sdk/
COPY packages/shared/package.json packages/shared/
COPY packages/web/package.json packages/web/
COPY packages/worker/package.json packages/worker/

RUN yarn workspaces focus auto-swe @auto-swe/shared @auto-swe/web

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/web packages/web
# Only the top level of `docs/` is served — `lib/docs.ts` reads that one
# directory and filters to `.md`, and `docLinks.ts` classifies everything else
# (`history/`, `redesign/`, `slack-app-manifest.json`) as unserved. Copying the
# whole tree put ~1.4 MB of frozen history and design reference into the traced
# standalone bundle for nothing.
COPY docs/*.md docs/

# `tsc` on @auto-swe/shared imports from its generated Prisma client, so
# generate must precede shared/build. prisma.config.ts eagerly resolves
# `DATABASE_URL` even for generate-only calls, so a placeholder is required
# (see the prisma-7-ci-generate-database-url pattern).
ENV DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
RUN yarn workspace @auto-swe/shared db:generate \
  && yarn workspace @auto-swe/shared build \
  && yarn workspace @auto-swe/web build \
  && mkdir -p packages/web/public

# ── Runtime ──
FROM node:24-alpine AS runtime

WORKDIR /app

ARG APP_VERSION=unknown
ARG COMMIT_HASH=unknown
ARG BUILD_TIME=unknown
ARG GIT_BRANCH=unknown
ARG GIT_TAG=unknown
ARG GIT_TIMESTAMP=unknown
ARG BUILD_NUMBER=unknown

ENV APP_VERSION=${APP_VERSION}
ENV COMMIT_HASH=${COMMIT_HASH}
ENV BUILD_TIME=${BUILD_TIME}
ENV GIT_BRANCH=${GIT_BRANCH}
ENV GIT_TAG=${GIT_TAG}
ENV GIT_TIMESTAMP=${GIT_TIMESTAMP}
ENV BUILD_NUMBER=${BUILD_NUMBER}

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Next.js standalone output includes everything needed
COPY --from=builder --chown=node:node /app/packages/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/packages/web/.next/static ./packages/web/.next/static
COPY --from=builder /app/packages/web/public ./packages/web/public

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]

USER node
CMD ["node", "packages/web/server.js"]
