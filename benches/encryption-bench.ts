/**
 * Encryption primitive benchmarks
 *
 * Measures raw AES-256-GCM and HKDF performance.
 * Run: npx tsx benches/encryption-bench.ts
 */

import { randomBytes, deriveKey, sha256 } from "../src/utils/crypto";

function bench(label: string, fn: () => void, iterations: number) {
  // Warmup
  for (let i = 0; i < 100; i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;

  const opsPerSec = (iterations / elapsed) * 1000;
  console.log(`${label}: ${opsPerSec.toFixed(0)} ops/s (${elapsed.toFixed(1)}ms)`);
}

function main() {
  console.log("VANTA Encryption Benchmarks\n");

  const masterKey = randomBytes(32);

  bench("randomBytes(32)", () => {
    randomBytes(32);
  }, 50_000);

  bench("randomBytes(16) [salt]", () => {
    randomBytes(16);
  }, 50_000);

  bench("deriveKey (HKDF-SHA256)", () => {
    deriveKey(masterKey, randomBytes(16));
  }, 10_000);

  bench("sha256 (32 bytes)", () => {
    sha256(randomBytes(32));
  }, 50_000);

  bench("sha256 (1KB)", () => {
    sha256(randomBytes(1024));
  }, 20_000);

  console.log("\nDone.");
}

main();
