import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `loops/` is Part 2 — its own npm package, with its own dependencies and
    // its own `npm test`. Without this exclude, running `npm test` here also
    // collects loops/tests/** and runs Part 2's suite against Part 1's
    // toolchain: two packages' tests in one report, resolved from the wrong
    // node_modules. Each part runs its own tests from its own directory.
    exclude: [...configDefaults.exclude, "loops/**"],
  },
});
