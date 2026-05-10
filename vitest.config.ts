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
