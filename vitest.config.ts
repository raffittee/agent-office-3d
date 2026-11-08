import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'client/src/**/*.test.ts', 'hooks/**/*.test.ts', 'test/**/*.test.ts', 'desktop/src/**/*.test.ts'],
    environment: 'node',
    // Windows CI runners are slow when ~70 test files run at once (several start servers or child processes)
    testTimeout: 15_000,
  },
});
