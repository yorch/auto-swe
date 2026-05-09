import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Map @auto-swe/shared subpath imports to source .ts files so vitest
      // can resolve them without building the shared package first.
      '@auto-swe/shared/lib/workflowId': path.resolve(
        __dirname,
        'packages/shared/src/lib/workflowId.ts'
      ),
      '@auto-swe/shared/db': path.resolve(__dirname, 'packages/shared/src/db.ts'),
      '@auto-swe/shared/types/workflow': path.resolve(
        __dirname,
        'packages/shared/src/types/workflow.ts'
      ),
      '@auto-swe/shared/types/api': path.resolve(__dirname, 'packages/shared/src/types/api.ts'),
      '@auto-swe/shared': path.resolve(__dirname, 'packages/shared/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/prisma/migrations/**'],
    },
  },
});
