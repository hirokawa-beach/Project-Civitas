import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  // Babylon materials load their renderer-specific shaders with dynamic imports.
  // Keeping Core out of dependency pre-bundling preserves those imports in dev.
  optimizeDeps: { exclude: ['@babylonjs/core'] },
  worker: { format: 'es' },
  build: { rollupOptions: { input: { app: 'index.html', benchmark: 'benchmark.html' } } },
  // Large-world and 100k-citizen fixtures otherwise compete for CPU/memory on
  // high-core laptops and trip unrelated 5s regression deadlines.
  test: { environment: 'node', maxWorkers: 2 },
});
