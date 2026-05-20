import { IntentEngine } from "../src/core/intent-engine";
import { PrivacyLayer } from "../src/core/privacy-layer";
import { randomBytes } from "../src/utils/crypto";

describe("IntentEngine", () => {
  let engine: IntentEngine;

  beforeEach(() => {
    const key = randomBytes(32);
    const privacy = new PrivacyLayer(key, ["https://relay-1.test"]);
    engine = new IntentEngine(privacy, 60);
  });

  test("creates encrypted intent", async () => {
    const intent = await engine.createIntent({
      type: "swap",
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: 1_000_000_000,
      slippage: 0.5,
    });
    expect(intent.id).toMatch(/^vnt_/);
    expect(intent.encryptedPayload.length).toBeGreaterThan(0);
    expect(intent.privacyScore).toBeGreaterThan(0);
  });

  test("rejects swap without mints", async () => {
    await expect(
      engine.createIntent({ type: "swap", amount: 100 })
    ).rejects.toThrow(/inputMint/);
  });

  test("rejects zero amount", async () => {
    await expect(
      engine.createIntent({ type: "transfer", amount: 0, recipient: "abc" })
    ).rejects.toThrow(/positive/);
  });

  test("prunes expired intents", async () => {
    await engine.createIntent({
      type: "transfer", amount: 100, recipient: "abc",
    });
    // Intents with 60s TTL won't be pruned immediately
    expect(engine.pruneExpired()).toBe(0);
  });
});
// coverage edge cases
