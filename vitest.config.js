import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default: run all tests
    include: ['packages/*/tests/**/*.test.js', 'apps/*/tests/**/*.test.js'],
    testTimeout: 30000,
    hookTimeout: 15000,

    // Named projects for `pnpm test core`, `pnpm test calc`, etc.
    projects: [
      {
        test: {
          name: 'core',
          include: ['packages/core/tests/**/*.test.js']
        }
      },
      {
        test: {
          name: 'pipeline',
          include: ['packages/pipeline/tests/**/*.test.js']
        }
      },
      {
        test: {
          name: 'calc',
          include: ['apps/calc/tests/**/*.test.js']
        }
      },
      {
        test: {
          name: 'web',
          include: ['apps/web/tests/**/*.test.js']
        }
      }
    ]
  }
});
