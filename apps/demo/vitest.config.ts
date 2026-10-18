// The demo's own tests (test/): the server as a process. A plain object, so the file needs no import to resolve.
// Run: `vitest run --root apps/demo` (vitest is requested in .needs-deps.md for apps/demo).
export default {
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
};
