FROM node:24-alpine AS builder

WORKDIR /app

# Copy root package files
COPY package.json yarn.lock ./

# Copy package sources
COPY packages/web/package.json packages/web/
COPY packages/shared/package.json packages/shared/

RUN yarn install --frozen-lockfile

COPY packages/web packages/web

RUN yarn workspace @auto-swe/web build

# ── Runtime ──
FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Next.js standalone output includes everything needed
COPY --from=builder /app/packages/web/.next/standalone ./
COPY --from=builder /app/packages/web/.next/static ./packages/web/.next/static
COPY --from=builder /app/packages/web/public ./packages/web/public

EXPOSE 3000

CMD ["node", "packages/web/server.js"]
