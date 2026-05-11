/**
 * Intent creation throughput benchmark
 *
 * Measures how many intents per second can be created and encrypted.
 * Run: npx tsx benches/intent-throughput.ts
 */

import { IntentEngine } from "../src/core/intent-engine";
import { PrivacyLayer } from "../src/core/privacy-layer";
import { randomBytes } from "../src/utils/crypto";

async function bench(label: string, fn: () => Promise<void>, iterations: number) {
  // Warmup
  for (let i = 0; i < 10; i++) await fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) await fn();
  const elapsed = performance.now() - start;

  const opsPerSec = (iterations / elapsed) * 1000;
  console.log(`${label}: ${opsPerSec.toFixed(0)} ops/s (${iterations} iterations in ${elapsed.toFixed(0)}ms)`);
}

async function main() {
  const key = randomBytes(32);
  const privacy = new PrivacyLayer(key, ["https://relay-1.test"]);
  const engine = new IntentEngine(privacy, 300);

  console.log("VANTA Intent Throughput Benchmark\n");

  await bench("createIntent (swap)", async () => {
    await engine.createIntent({
      type: "swap",
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: 1_000_000_000,
      slippage: 0.5,
    });
  }, 1000);

  await bench("createIntent (transfer)", async () => {
    await engine.createIntent({
      type: "transfer",
      amount: 500_000,
      recipient: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    });
  }, 1000);

  await bench("encrypt raw (1KB)", async () => {
    privacy.encrypt(randomBytes(1024));
  }, 5000);

  await bench("encrypt raw (10KB)", async () => {
    privacy.encrypt(randomBytes(10240));
  }, 2000);

  console.log("\nDone.");
}

main().catch(console.error);
