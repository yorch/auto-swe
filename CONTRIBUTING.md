# Contributing to auto-swe

Thanks for contributing! This file is intentionally short — **[`AGENTS.md`](./AGENTS.md) is the single source of truth** for conventions, the tech stack, package layout, critical implementation notes (Temporal V8-isolate rules, Mastra API, DinD workspace cleanup), and forbidden actions. Read it before writing code.

## Getting started

Follow the Local Development Quickstart in [`AGENTS.md` §8](./AGENTS.md#8-local-development-quickstart) (or the shorter version in [`README.md`](./README.md)):

```bash
corepack enable && yarn install   # Node >= 24, Yarn 4 via corepack
cp .env.example .env              # fill in CONFIG_ENCRYPTION_KEY + SEED_ADMIN_PASSWORD
yarn docker:infra:up              # postgres + temporal + minio
yarn db:migrate && yarn db:generate && yarn db:seed
```

## Before you open a PR

```bash
yarn lint        # Biome check (lint + format) — yarn lint:fix to auto-fix
yarn typecheck   # tsc --noEmit across all packages
yarn test        # Vitest
yarn build       # all packages compile
```

CI runs the same four checks; Docker image publishing is gated on them passing.

- Co-locate tests next to source (`workRequests.test.ts` pattern).
- Run `yarn lint:fix` before committing.

## Commits

Use conventional-style prefixes: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`. Commit each logical change separately, and write messages that explain the *why*. Never commit `.env`, credentials, or secrets. Never force-push to `main`.

## Security issues

Please do not open public issues for vulnerabilities — see [`SECURITY.md`](./SECURITY.md).
