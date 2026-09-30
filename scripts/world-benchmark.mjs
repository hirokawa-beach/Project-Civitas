import { build } from 'vite';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';

await build({ configFile: false, logLevel: 'error', build: { ssr: 'src/performance/worldBenchmark.ts', outDir: '.world-benchmark-run', minify: false } });
const { runWorldBenchmarks } = await import(pathToFileURL(resolve('.world-benchmark-run/worldBenchmark.js')).href);
const report = { ...runWorldBenchmarks(), environment: { runtime: process.version, platform: process.platform, cpu: os.cpus()[0]?.model, renderer: 'CPU only' } };
await mkdir('benchmarks', { recursive: true });
await writeFile('benchmarks/world-foundation.json', JSON.stringify(report, null, 2) + '\n');
console.table(report.scenarios);
