import { MEVShield } from "../src/mev/shield";
import { MEVDetector } from "../src/mev/detector";

describe("MEVShield", () => {
  let shield: MEVShield;

  beforeEach(() => { shield = new MEVShield(); });

  test("high risk for large SOL/USDC swap", () => {
    const analysis = shield.analyzeMEVRisk(1, "SOL/USDC", 10_000_000_000n);
    expect(analysis.sandwichRisk).toBeGreaterThan(0.5);
    expect(analysis.recommendedRoute).toBe("jito");
  });

  test("low risk for small unknown pair", () => {
    const analysis = shield.analyzeMEVRisk(1, "ABC/XYZ", 1_000n);
    expect(analysis.sandwichRisk).toBeLessThan(0.3);
  });

  test("rejects oversized bundles", async () => {
    const txs = Array(10).fill(new Uint8Array([1, 2, 3]));
    await expect(shield.submitViaJito(txs)).rejects.toThrow(/exceeds max/);
  });
});

describe("MEVDetector", () => {
  test("detects sandwich pattern in same slot", () => {
    const detector = new MEVDetector();
    const attacks = detector.detectSandwich([
      { sig: "tx1", slot: 100, accounts: ["poolA"], type: "swap" },
      { sig: "tx2", slot: 100, accounts: ["poolA"], type: "swap" },
      { sig: "tx3", slot: 100, accounts: ["poolA"], type: "swap" },
    ]);
    expect(attacks.length).toBe(1);
    expect(attacks[0].victimTx).toBe("tx2");
  });
});
// coverage relay failover
