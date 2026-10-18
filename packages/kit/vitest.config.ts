// Unit tests of the library (plan §3, test/unit). The Playwright `selftest` project covers fixtures and the runner.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    reporters: ['default'],
  },
});
