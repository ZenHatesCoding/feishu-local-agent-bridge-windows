import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    server: {
      deps: {
        // Vite's builtin-module list predates experimental Node built-ins such
        // as node:sqlite; keep every node: import external to the transformer.
        external: [/^node:/],
      },
    },
  },
});
