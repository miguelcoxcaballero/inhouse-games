// Converts actual browser-exported WebRTC measurements into a repeatable report.
// These measurements are network/decoder statistics, not glass-to-glass latency.
import { readFile } from 'node:fs/promises';
const filename = process.argv[2];
if (!filename) {
  console.error('Uso: node scripts/benchmark.mjs captura.json');
  process.exitCode = 1;
} else {
  const value = JSON.parse(await readFile(filename, 'utf8'));
  const rows = Array.isArray(value) ? value : value.samples;
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('Se necesitan al menos dos muestras reales de WebRTC.');
  const result = { samples: rows.length, metrics: {} };
  for (const key of ['rttMs', 'decodeMs', 'bitrateMbps', 'fps', 'packetLoss']) {
    const numbers = rows.map(row => row[key]).filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
    result.metrics[key] = numbers.length ? {
      n: numbers.length,
      median: numbers[Math.floor((numbers.length - 1) * .5)],
      p95: numbers[Math.floor((numbers.length - 1) * .95)],
      min: numbers[0], max: numbers.at(-1),
    } : { n: 0 };
  }
  console.log(JSON.stringify(result, null, 2));
}
