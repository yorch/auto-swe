import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@auto-swe/shared/lib/workflowId': path.resolve(
        __dirname,
        'packages/shared/src/lib/workflowId.ts',
      ),
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
