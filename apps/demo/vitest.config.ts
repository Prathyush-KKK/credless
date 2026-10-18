// The demo's own tests (test/): the server as a process. A plain object, so the file needs no import to resolve.
// Run: `pnpm --filter ./apps/demo unit` (or `pnpm unit` at the root, which runs the kit's unit tests too).
export default {
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
};
