# ── Stage 1: Build ──
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
COPY packages/shared/package.json packages/shared/
COPY packages/worker/package.json packages/worker/
RUN corepack enable && yarn install --immutable

COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/worker/ packages/worker/
RUN yarn workspace @auto-swe/shared prisma generate \
 && yarn workspace @auto-swe/shared build \
 && yarn workspace @auto-swe/worker build

# ── Stage 2: Production dependencies only ──
FROM node:24-alpine AS prod-deps
WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
COPY packages/shared/package.json packages/shared/
COPY packages/worker/package.json packages/worker/
RUN corepack enable && yarn workspaces focus @auto-swe/worker --production

# ── Stage 3: Runtime ──
FROM node:24-alpine
# Worker needs Docker CLI to manage workspace containers (DinD)
RUN apk add --no-cache docker-cli
WORKDIR /app

# Production node_modules (hoisted root deps)
COPY --from=prod-deps /app/node_modules ./node_modules

# Prisma generated client (lives inside node_modules)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Workspace package.json files (for symlink resolution)
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/worker/package.json ./packages/worker/

# Built output
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/worker/dist ./packages/worker/dist

# Workspace node_modules (symlinks)
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/packages/worker/node_modules ./packages/worker/node_modules

# Root package.json (for workspace symlink resolution)
COPY package.json ./

CMD ["node", "packages/worker/dist/index.js"]
