import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Array form: order-sensitive prefix matching. Subpath aliases MUST come
    // before the bare '@auto-swe/shared' alias or they'll be shadowed.
    // Maps subpaths to source .ts so vitest doesn't need a prior build.
    alias: [
      {
        find: '@auto-swe/shared/agentKeys',
        replacement: path.resolve(__dirname, 'packages/shared/src/agentKeys.ts'),
      },
      {
        find: '@auto-swe/shared/db',
        replacement: path.resolve(__dirname, 'packages/shared/src/db.ts'),
      },
      {
        find: '@auto-swe/shared/lib/channelBudget',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/channelBudget.ts'),
      },
      {
        find: '@auto-swe/shared/lib/agentPrompts',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/agentPrompts.ts'),
      },
      {
        find: '@auto-swe/shared/lib/workflowId',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/workflowId.ts'),
      },
      {
        find: '@auto-swe/shared/lib/crypto',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/crypto.ts'),
      },
      {
        find: '@auto-swe/shared/lib/tenantGuard',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/tenantGuard.ts'),
      },
      {
        find: '@auto-swe/shared/lib/keyRotation',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/keyRotation.ts'),
      },
      {
        find: '@auto-swe/shared/lib/credentialScope',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/credentialScope.ts'),
      },
      {
        find: '@auto-swe/shared/lib/canary',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/canary.ts'),
      },
      {
        find: '@auto-swe/shared/lib/systemConfig',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/systemConfig.ts'),
      },
      {
        find: '@auto-swe/shared/lib/billing',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/billing.ts'),
      },
      {
        find: '@auto-swe/shared/lib/channelTask',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/channelTask.ts'),
      },
      {
        find: '@auto-swe/shared/lib/skillScanner',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/skillScanner.ts'),
      },
      {
        find: '@auto-swe/shared/lib/regexSafety',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/regexSafety.ts'),
      },
      {
        find: '@auto-swe/shared/lib/regexExec',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/regexExec.ts'),
      },
      {
        find: '@auto-swe/shared/lib/connectionGuards',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/connectionGuards.ts'),
      },
      {
        find: '@auto-swe/shared/lib/connectionTypes',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/connectionTypes.ts'),
      },
      {
        find: '@auto-swe/shared/lib/outcomePublishers',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/outcomePublishers.ts'),
      },
      {
        find: '@auto-swe/shared/lib/autonomyPolicy',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/autonomyPolicy.ts'),
      },
      {
        find: '@auto-swe/shared/lib/workspaceProviders',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/workspaceProviders.ts'),
      },
      {
        find: '@auto-swe/shared/lib/manifestParsers',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/manifestParsers.ts'),
      },
      // Order matters: 'repoDependency' is a prefix of both 'repoDependencyMatch'
      // and 'repoDependencyResolver', so the longer finds MUST come first.
      {
        find: '@auto-swe/shared/lib/repoDependencyResolver',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/repoDependencyResolver.ts'),
      },
      {
        find: '@auto-swe/shared/lib/repoDependencyMatch',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/repoDependencyMatch.ts'),
      },
      {
        find: '@auto-swe/shared/lib/repoDependency',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/repoDependency.ts'),
      },
      {
        find: '@auto-swe/shared/lib/ssrfGuard',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/ssrfGuard.ts'),
      },
      {
        find: '@auto-swe/shared/lib/scannerCache',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/scannerCache.ts'),
      },
      {
        find: '@auto-swe/shared/lib/inputSchema',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/inputSchema.ts'),
      },
      {
        find: '@auto-swe/shared/lib/triggerMapping',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/triggerMapping.ts'),
      },
      {
        find: '@auto-swe/shared/lib/trackerSync',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/trackerSync.ts'),
      },
      {
        find: '@auto-swe/shared/lib/trackerWrite',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/trackerWrite.ts'),
      },
      {
        find: '@auto-swe/shared/lib/telemetry',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/telemetry.ts'),
      },
      {
        find: '@auto-swe/shared/lib/syncBuiltins',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/syncBuiltins.ts'),
      },
      {
        // Broad alias covers registry, adf, providers/*, and any future subpaths.
        // Must come before the bare @auto-swe/shared catch-all.
        find: '@auto-swe/shared/lib/integrations',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/integrations'),
      },
      {
        // Broad alias covers config/index, cache, registry, permissions,
        // resolveSetting, types, and any future subpaths. Must come before the
        // bare @auto-swe/shared catch-all.
        find: '@auto-swe/shared/config',
        replacement: path.resolve(__dirname, 'packages/shared/src/config'),
      },
      {
        find: '@auto-swe/shared/types/api',
        replacement: path.resolve(__dirname, 'packages/shared/src/types/api.ts'),
      },
      {
        find: '@auto-swe/shared/types/workflow',
        replacement: path.resolve(__dirname, 'packages/shared/src/types/workflow.ts'),
      },
      {
        find: '@auto-swe/shared/bundle',
        replacement: path.resolve(__dirname, 'packages/shared/src/bundle/index.ts'),
      },
      {
        find: '@auto-swe/shared/workflow/spec',
        replacement: path.resolve(__dirname, 'packages/shared/src/workflow/spec.ts'),
      },
      {
        find: '@auto-swe/shared/workflow/expr',
        replacement: path.resolve(__dirname, 'packages/shared/src/workflow/expr.ts'),
      },
      {
        find: '@auto-swe/shared/workflow/registry-types',
        replacement: path.resolve(__dirname, 'packages/shared/src/workflow/registry-types.ts'),
      },
      {
        find: '@auto-swe/shared/workflow/codemod',
        replacement: path.resolve(__dirname, 'packages/shared/src/workflow/codemod.ts'),
      },
      {
        find: '@auto-swe/shared/workflow/defaultEngineeringSpec',
        replacement: path.resolve(
          __dirname,
          'packages/shared/src/workflow/defaultEngineeringSpec.ts'
        ),
      },
      {
        find: '@auto-swe/shared/workflow/interpreter',
        replacement: path.resolve(__dirname, 'packages/shared/src/workflow/interpreter.ts'),
      },
      {
        find: '@auto-swe/shared/workflow/signalSlots',
        replacement: path.resolve(__dirname, 'packages/shared/src/workflow/signalSlots.ts'),
      },
      {
        find: '@auto-swe/shared/workflow/stepRegistry',
        replacement: path.resolve(__dirname, 'packages/shared/src/workflow/stepRegistry.ts'),
      },
      {
        find: '@auto-swe/shared/workflow/costEstimator',
        replacement: path.resolve(__dirname, 'packages/shared/src/workflow/costEstimator.ts'),
      },
      {
        find: '@auto-swe/shared/workflow/testHelpers',
        replacement: path.resolve(__dirname, 'packages/shared/src/workflow/testHelpers.ts'),
      },
      {
        find: '@auto-swe/shared/workflow',
        replacement: path.resolve(__dirname, 'packages/shared/src/workflow/index.ts'),
      },
      {
        find: '@auto-swe/shared',
        replacement: path.resolve(__dirname, 'packages/shared/src/index.ts'),
      },
      // Web package internal alias — Next.js reads this from tsconfig paths,
      // but vitest doesn't, so the React component tests need it spelled out
      // here. Mirrors `packages/web/tsconfig.json` ("@/*" -> "./src/*").
      {
        find: /^@\/(.*)$/,
        replacement: path.resolve(__dirname, 'packages/web/src/$1'),
      },
    ],
  },
  test: {
    coverage: {
      exclude: [
        '**/*.test.ts',
        '**/prisma/migrations/**',
        // Generated Prisma client (~106k lines) — not hand-written, not unit-testable.
        '**/generated/**',
        '**/*.d.ts',
        // Type-only barrels and entrypoints with no branching logic to cover.
        '**/index.ts',
        '**/prisma/seed.ts',
      ],
      include: ['packages/*/src/**/*.ts'],
      provider: 'v8',
      // Floors set a couple points below the measured coverage of hand-written
      // code (lines ~59%, branches ~53%, functions ~49%) so a regression fails
      // CI without the buffer being brittle. Ratchet upward as coverage grows.
      thresholds: { branches: 51, functions: 47, lines: 57, statements: 57 },
    },
    // Some modules (e.g. @auto-swe/shared/db) construct a PrismaClient at import
    // time and require DATABASE_URL to be set. PrismaClient connects lazily, so a
    // dummy DSN is enough for tests that mock prisma or decorate a fake one — it
    // just keeps the import-time guard from throwing. Mirrors the CI env.
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test?schema=public',
    },
    environment: 'node',
    globals: true,
    // Default `.test.ts` is Node; React component tests are `.test.tsx` and
    // opt into jsdom via a `// @vitest-environment jsdom` pragma at the top
    // of each file. (The deprecated `environmentMatchGlobs` got replaced by
    // the `projects` API in vitest 3.x; per-file pragmas keep the config flat.)
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.test.tsx'],
    // Anchor test discovery to the worktree directory (not the CWD from which
    // vitest is invoked) so the correct test files are found when running from
    // the main repo root.
    root: __dirname,
  },
});
