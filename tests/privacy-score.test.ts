import { describe, it, expect, beforeEach } from "vitest";
import { PrivacyScorer, type PrivacyFactors } from "../src/core/privacy-score";

function createDefaultFactors(overrides?: Partial<PrivacyFactors>): PrivacyFactors {
  return {
    isEncrypted: true,
    encryptionAlgo: "aes-256-gcm",
    relayHops: 2,
    hasTimingJitter: true,
    timingJitterMs: 2000,
    amountSplit: false,
    splitCount: 1,
    amountLamports: 1_000_000_000n, // 1 SOL
    tokenPair: "SOL/USDC",
    hasDecoy: false,
    ipMasked: true,
    walletTxCount: 5,
    timeSinceLastTx: 600,
    ...overrides,
  };
}

describe("PrivacyScorer", () => {
  let scorer: PrivacyScorer;

  beforeEach(() => {
    scorer = new PrivacyScorer();
  });

  describe("score()", () => {
    it("should return a score between 0 and 100", () => {
      const factors = createDefaultFactors();
      const result = scorer.score(factors);

      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it("should give high score for maximum privacy settings", () => {
      const factors = createDefaultFactors({
        isEncrypted: true,
        encryptionAlgo: "aes-256-gcm",
        relayHops: 3,
        hasTimingJitter: true,
        timingJitterMs: 15000,
        amountSplit: true,
        splitCount: 4,
        amountLamports: 100_000n, // dust
        hasDecoy: true,
        ipMasked: true,
        walletTxCount: 1,
        timeSinceLastTx: 7200,
      });

      const result = scorer.score(factors);
      expect(result.score).toBeGreaterThanOrEqual(80);
      expect(result.riskLevel).toBe("minimal");
    });

    it("should give low score for no privacy measures", () => {
      const factors = createDefaultFactors({
        isEncrypted: false,
        encryptionAlgo: "none",
        relayHops: 0,
        hasTimingJitter: false,
        timingJitterMs: 0,
        amountSplit: false,
        amountLamports: 500_000_000_000n, // 500 SOL whale
        hasDecoy: false,
        ipMasked: false,
        walletTxCount: 200,
        timeSinceLastTx: 30,
      });

      const result = scorer.score(factors);
      expect(result.score).toBeLessThan(40);
      expect(["high", "critical"]).toContain(result.riskLevel);
    });

    it("should include factor breakdown", () => {
      const factors = createDefaultFactors();
      const result = scorer.score(factors);

      expect(result.factors).toBeDefined();
      expect(result.factors.encryption).toBeGreaterThanOrEqual(0);
      expect(result.factors.relayPath).toBeGreaterThanOrEqual(0);
      expect(result.factors.timing).toBeGreaterThanOrEqual(0);
      expect(result.factors.amountPrivacy).toBeGreaterThanOrEqual(0);
      expect(result.factors.correlationResistance).toBeGreaterThanOrEqual(0);
      expect(result.factors.networkPrivacy).toBeGreaterThanOrEqual(0);
    });
  });

  describe("encryption factor", () => {
    it("should give 100 for AES-256-GCM", () => {
      const result = scorer.score(createDefaultFactors({ encryptionAlgo: "aes-256-gcm" }));
      expect(result.factors.encryption).toBe(100);
    });

    it("should give 95 for ChaCha20-Poly1305", () => {
      const result = scorer.score(createDefaultFactors({ encryptionAlgo: "chacha20-poly1305" }));
      expect(result.factors.encryption).toBe(95);
    });

    it("should give 0 for no encryption", () => {
      const result = scorer.score(
        createDefaultFactors({ isEncrypted: false, encryptionAlgo: "none" })
      );
      expect(result.factors.encryption).toBe(0);
    });
  });

  describe("relay path factor", () => {
    it("should increase with more relay hops", () => {
      const score0 = scorer.score(createDefaultFactors({ relayHops: 0 })).factors.relayPath;
      const score1 = scorer.score(createDefaultFactors({ relayHops: 1 })).factors.relayPath;
      const score2 = scorer.score(createDefaultFactors({ relayHops: 2 })).factors.relayPath;
      const score3 = scorer.score(createDefaultFactors({ relayHops: 3 })).factors.relayPath;

      expect(score1).toBeGreaterThan(score0);
      expect(score2).toBeGreaterThan(score1);
      expect(score3).toBeGreaterThan(score2);
    });
  });

  describe("timing factor", () => {
    it("should penalize no jitter", () => {
      const result = scorer.score(
        createDefaultFactors({ hasTimingJitter: false, timingJitterMs: 0 })
      );
      expect(result.factors.timing).toBeLessThan(30);
    });

    it("should reward large jitter", () => {
      const result = scorer.score(
        createDefaultFactors({ hasTimingJitter: true, timingJitterMs: 15000 })
      );
      expect(result.factors.timing).toBeGreaterThanOrEqual(85);
    });
  });

  describe("amount privacy factor", () => {
    it("should penalize whale amounts", () => {
      const smallResult = scorer.score(
        createDefaultFactors({ amountLamports: 100_000n })
      );
      const whaleResult = scorer.score(
        createDefaultFactors({ amountLamports: 2_000_000_000_000n })
      );

      expect(smallResult.factors.amountPrivacy).toBeGreaterThan(
        whaleResult.factors.amountPrivacy
      );
    });

    it("should reward amount splitting", () => {
      const noSplit = scorer.score(
        createDefaultFactors({ amountSplit: false, splitCount: 1 })
      );
      const split = scorer.score(
        createDefaultFactors({ amountSplit: true, splitCount: 4 })
      );

      expect(split.factors.amountPrivacy).toBeGreaterThan(
        noSplit.factors.amountPrivacy
      );
    });

    it("should reward decoy transactions", () => {
      const noDecoy = scorer.score(createDefaultFactors({ hasDecoy: false }));
      const withDecoy = scorer.score(createDefaultFactors({ hasDecoy: true }));

      expect(withDecoy.factors.amountPrivacy).toBeGreaterThan(
        noDecoy.factors.amountPrivacy
      );
    });
  });

  describe("recommendations", () => {
    it("should suggest encryption when not encrypted", () => {
      const result = scorer.score(
        createDefaultFactors({ isEncrypted: false, encryptionAlgo: "none" })
      );
      expect(result.recommendations.some((r) => r.includes("encryption"))).toBe(true);
    });

    it("should suggest IP masking when not masked", () => {
      const result = scorer.score(createDefaultFactors({ ipMasked: false }));
      expect(result.recommendations.some((r) => r.includes("IP masking"))).toBe(true);
    });

    it("should return no recommendations for maximum privacy", () => {
      const result = scorer.score(
        createDefaultFactors({
          relayHops: 3,
          timingJitterMs: 15000,
          amountSplit: true,
          splitCount: 4,
          amountLamports: 50_000n,
          hasDecoy: true,
          ipMasked: true,
          walletTxCount: 1,
          timeSinceLastTx: 7200,
        })
      );
      expect(result.recommendations.length).toBe(0);
    });
  });

  describe("anonymity set estimation", () => {
    it("should return a positive number", () => {
      const result = scorer.score(createDefaultFactors());
      expect(result.anonymitySetSize).toBeGreaterThan(0);
    });

    it("should be larger for popular pairs", () => {
      const popular = scorer.score(
        createDefaultFactors({ tokenPair: "SOL/USDC" })
      );
      const obscure = scorer.score(
        createDefaultFactors({ tokenPair: "UNKNOWN/RARE" })
      );

      expect(popular.anonymitySetSize).toBeGreaterThan(
        obscure.anonymitySetSize
      );
    });
  });

  describe("wallet activity tracking", () => {
    it("should record and retrieve wallet patterns", () => {
      const wallet = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

      scorer.recordWalletActivity(wallet, 1_000_000_000n, "SOL/USDC");
      scorer.recordWalletActivity(wallet, 2_000_000_000n, "SOL/USDT");

      const pattern = scorer.getWalletPattern(wallet);
      expect(pattern).toBeDefined();
      expect(pattern!.txCount).toBe(2);
      expect(pattern!.commonPairs).toContain("SOL/USDC");
      expect(pattern!.commonPairs).toContain("SOL/USDT");
    });

    it("should return undefined for unknown wallet", () => {
      expect(scorer.getWalletPattern("unknown")).toBeUndefined();
    });
  });

  describe("average score tracking", () => {
    it("should compute average score", () => {
      scorer.score(createDefaultFactors());
      scorer.score(createDefaultFactors());
      scorer.score(createDefaultFactors());

      const avg = scorer.getAverageScore();
      expect(avg).toBeGreaterThan(0);
      expect(avg).toBeLessThanOrEqual(100);
    });

    it("should return 0 when no scores recorded", () => {
      expect(scorer.getAverageScore()).toBe(0);
    });
  });
});
