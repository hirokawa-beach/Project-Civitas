import { build } from 'vite';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';

await build({ configFile: false, logLevel: 'error', build: { ssr: 'src/performance/landOwnershipBenchmark.ts', outDir: '.world-benchmark-run/land', minify: false } });
const { runLandOwnershipBenchmarks } = await import(pathToFileURL(resolve('.world-benchmark-run/land/landOwnershipBenchmark.js')).href);
const report = { ...runLandOwnershipBenchmarks(), environment: { runtime: process.version, platform: process.platform, cpu: os.cpus()[0]?.model, renderer: 'CPU only' } };
await mkdir('benchmarks', { recursive: true });
await writeFile('benchmarks/land-ownership.json', JSON.stringify(report, null, 2) + '\n');
console.table(report.scenarios);
