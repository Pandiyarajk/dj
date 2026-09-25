/**
 * Vite + Vitest configuration.
 *
 * Author: Pandiyaraj Karuppasamy
 * Date: Sep-25-2026
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the build works from any sub-path (GitHub Pages serves /dj/).
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
