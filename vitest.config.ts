import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Array form: order-sensitive prefix matching. Subpath aliases MUST come
    // before the bare '@auto-swe/shared' alias or they'll be shadowed.
    // Maps subpaths to source .ts so vitest doesn't need a prior build.
    alias: [
      {
        find: '@auto-swe/shared/db',
        replacement: path.resolve(__dirname, 'packages/shared/src/db.ts'),
      },
      {
        find: '@auto-swe/shared/lib/workflowId',
        replacement: path.resolve(__dirname, 'packages/shared/src/lib/workflowId.ts'),
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
        find: '@auto-swe/shared/workflow',
        replacement: path.resolve(__dirname, 'packages/shared/src/workflow/index.ts'),
      },
      {
        find: '@auto-swe/shared',
        replacement: path.resolve(__dirname, 'packages/shared/src/index.ts'),
      },
    ],
  },
  test: {
    coverage: {
      exclude: ['**/*.test.ts', '**/prisma/migrations/**'],
      include: ['packages/*/src/**/*.ts'],
      provider: 'v8',
    },
    environment: 'node',
    globals: true,
    include: ['packages/*/src/**/*.test.ts'],
  },
});
