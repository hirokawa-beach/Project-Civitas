import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  // Babylon materials load their renderer-specific shaders with dynamic imports.
  // Keeping Core out of dependency pre-bundling preserves those imports in dev.
  optimizeDeps: { exclude: ['@babylonjs/core'] },
  worker: { format: 'es' },
  test: { environment: 'node' },
});
