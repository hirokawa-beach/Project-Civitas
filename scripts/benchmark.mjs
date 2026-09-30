import { build } from 'vite';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : 'benchmarks/latest.json';
await build({ configFile: false, logLevel: 'error', build: { ssr: 'src/performance/runBenchmark.ts', outDir: '.benchmark-run', minify: false } });
const { runSimulationBenchmarks } = await import(pathToFileURL(resolve('.benchmark-run/runBenchmark.js')).href);
const before = process.memoryUsage().heapUsed;
const results = runSimulationBenchmarks();
results.environment = { runtime: process.version, platform: process.platform, cpu: os.cpus()[0]?.model,
  logicalCpus: os.cpus().length, ramBytes: os.totalmem(), renderer: 'none (CPU only)', heapBeforeBytes: before, heapAfterBytes: process.memoryUsage().heapUsed };
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(output, JSON.stringify(results, null, 2) + '\n');
console.table(results.scenarios.map((s) => ({ scenario: s.id, citizens: s.totalIndividualCitizens, candidates: s.cameraCitizens,
  selected: s.selectedCitizens, tickMeanMs: s.timings.simulationTickMs?.mean.toFixed(3), queryMeanMs: s.timings.citizenQueryMs?.mean.toFixed(3), snapshotKB: (s.snapshotBytes / 1024).toFixed(1) })));
console.log(`Saved ${output}`);
