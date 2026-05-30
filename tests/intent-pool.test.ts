import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IntentPool, PoolError, type PooledIntent } from "../src/core/intent-pool";
import type { EncryptedIntent, IntentParams } from "../src/core/intent-engine";

function createMockEncryptedIntent(id?: string): EncryptedIntent {
  return {
    id: id ?? `vnt_${Math.random().toString(36).slice(2)}`,
    encryptedPayload: new Uint8Array(64),
    nonce: new Uint8Array(12),
    timestamp: Date.now(),
    ttl: 120,
    privacyScore: 75,
  };
}

function createMockIntentParams(type: "swap" | "transfer" = "swap"): IntentParams {
  if (type === "swap") {
    return {
      type: "swap",
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: 1_000_000_000,
      slippage: 0.5,
    };
  }
  return {
    type: "transfer",
    amount: 500_000_000,
    recipient: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  };
}

const WALLET_A = "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH";
const WALLET_B = "5SSkXsEKQepHHAewytPVwdej4epN1nxgLVM84L4KXgy7";

describe("IntentPool", () => {
  let pool: IntentPool;

  beforeEach(() => {
    pool = new IntentPool({
      maxSize: 100,
      defaultTTL: 120,
      maxPerWallet: 10,
      minTipLamports: 1_000n,
      pruneIntervalMs: 60_000,
    });
  });

  afterEach(() => {
    pool.stop();
  });

  describe("add()", () => {
    it("should add an intent to the pool", () => {
      const encrypted = createMockEncryptedIntent();
      const params = createMockIntentParams();

      const pooled = pool.add(encrypted, params, WALLET_A, 5_000n);

      expect(pooled.id).toBe(encrypted.id);
      expect(pooled.status).toBe("pending");
      expect(pooled.submitter).toBe(WALLET_A);
      expect(pooled.tipLamports).toBe(5_000n);
      expect(pool.size).toBe(1);
    });

    it("should reject duplicate intent IDs", () => {
      const encrypted = createMockEncryptedIntent("vnt_duplicate");
      const params = createMockIntentParams();

      pool.add(encrypted, params, WALLET_A, 5_000n);

      expect(() => pool.add(encrypted, params, WALLET_A, 5_000n)).toThrow(
        PoolError
      );
    });

    it("should enforce per-wallet rate limit", () => {
      const params = createMockIntentParams();

      for (let i = 0; i < 10; i++) {
        pool.add(createMockEncryptedIntent(), params, WALLET_A, 5_000n);
      }

      expect(() =>
        pool.add(createMockEncryptedIntent(), params, WALLET_A, 5_000n)
      ).toThrow("rate limited");
    });

    it("should reject tips below minimum", () => {
      const encrypted = createMockEncryptedIntent();
      const params = createMockIntentParams();

      expect(() => pool.add(encrypted, params, WALLET_A, 500n)).toThrow(
        "below minimum"
      );
    });

    it("should track wallet counts correctly", () => {
      pool.add(createMockEncryptedIntent(), createMockIntentParams(), WALLET_A, 5_000n);
      pool.add(createMockEncryptedIntent(), createMockIntentParams(), WALLET_A, 5_000n);
      pool.add(createMockEncryptedIntent(), createMockIntentParams(), WALLET_B, 5_000n);

      const walletAIntents = pool.getByWallet(WALLET_A);
      const walletBIntents = pool.getByWallet(WALLET_B);

      expect(walletAIntents.length).toBe(2);
      expect(walletBIntents.length).toBe(1);
    });
  });

  describe("getNextBatch()", () => {
    it("should return intents sorted by priority", () => {
      pool.add(
        createMockEncryptedIntent("vnt_low"),
        createMockIntentParams(),
        WALLET_A,
        1_000n
      );
      pool.add(
        createMockEncryptedIntent("vnt_high"),
        createMockIntentParams(),
        WALLET_B,
        1_000_000n
      );

      const batch = pool.getNextBatch(2);

      expect(batch.length).toBe(2);
      // Higher tip should come first
      expect(batch[0].tipLamports).toBeGreaterThanOrEqual(batch[1].tipLamports);
    });

    it("should mark returned intents as relaying", () => {
      const encrypted = createMockEncryptedIntent();
      pool.add(encrypted, createMockIntentParams(), WALLET_A, 5_000n);

      pool.getNextBatch(1);

      const intent = pool.get(encrypted.id);
      expect(intent?.status).toBe("relaying");
    });

    it("should respect batch size limit", () => {
      for (let i = 0; i < 5; i++) {
        pool.add(createMockEncryptedIntent(), createMockIntentParams(), WALLET_A, 5_000n);
      }

      const batch = pool.getNextBatch(3);
      expect(batch.length).toBe(3);
    });

    it("should only return pending intents", () => {
      const e1 = createMockEncryptedIntent();
      const e2 = createMockEncryptedIntent();

      pool.add(e1, createMockIntentParams(), WALLET_A, 5_000n);
      pool.add(e2, createMockIntentParams(), WALLET_A, 5_000n);

      // Get first batch (marks as relaying)
      pool.getNextBatch(1);

      // Second batch should only get the remaining pending one
      const batch2 = pool.getNextBatch(2);
      expect(batch2.length).toBe(1);
    });
  });

  describe("markRelayed()", () => {
    it("should update intent status to relayed", () => {
      const encrypted = createMockEncryptedIntent();
      pool.add(encrypted, createMockIntentParams(), WALLET_A, 5_000n);

      pool.markRelayed(encrypted.id, "tx_sig_123");

      const intent = pool.get(encrypted.id);
      expect(intent?.status).toBe("relayed");
    });

    it("should update metrics", () => {
      const encrypted = createMockEncryptedIntent();
      pool.add(encrypted, createMockIntentParams(), WALLET_A, 5_000n);
      pool.markRelayed(encrypted.id, "tx_sig_123");

      const metrics = pool.getMetrics();
      expect(metrics.totalRelayed).toBe(1);
    });
  });

  describe("markFailed()", () => {
    it("should return to pending if under retry limit", () => {
      const encrypted = createMockEncryptedIntent();
      pool.add(encrypted, createMockIntentParams(), WALLET_A, 5_000n);

      pool.markFailed(encrypted.id, "relay timeout");

      const intent = pool.get(encrypted.id);
      expect(intent?.status).toBe("pending");
    });

    it("should remove intent after max retries", () => {
      const pool3 = new IntentPool({ maxRelayAttempts: 2, minTipLamports: 1_000n });
      const encrypted = createMockEncryptedIntent();
      pool3.add(encrypted, createMockIntentParams(), WALLET_A, 5_000n);

      // Simulate relay attempts
      const intent = pool3.get(encrypted.id)!;
      intent.relayAttempts = 2;

      pool3.markFailed(encrypted.id, "final failure");

      expect(pool3.get(encrypted.id)).toBeUndefined();
      expect(pool3.getMetrics().totalFailed).toBe(1);
      pool3.stop();
    });
  });

  describe("remove()", () => {
    it("should remove an intent from the pool", () => {
      const encrypted = createMockEncryptedIntent();
      pool.add(encrypted, createMockIntentParams(), WALLET_A, 5_000n);

      const removed = pool.remove(encrypted.id);

      expect(removed).toBe(true);
      expect(pool.size).toBe(0);
      expect(pool.get(encrypted.id)).toBeUndefined();
    });

    it("should return false for unknown intent", () => {
      expect(pool.remove("vnt_nonexistent")).toBe(false);
    });
  });

  describe("metrics", () => {
    it("should track current size", () => {
      pool.add(createMockEncryptedIntent(), createMockIntentParams(), WALLET_A, 5_000n);
      pool.add(createMockEncryptedIntent(), createMockIntentParams(), WALLET_A, 5_000n);

      expect(pool.getMetrics().currentSize).toBe(2);
    });

    it("should track unique submitters", () => {
      pool.add(createMockEncryptedIntent(), createMockIntentParams(), WALLET_A, 5_000n);
      pool.add(createMockEncryptedIntent(), createMockIntentParams(), WALLET_B, 5_000n);

      expect(pool.getMetrics().uniqueSubmitters).toBe(2);
    });

    it("should compute average tip", () => {
      pool.add(createMockEncryptedIntent(), createMockIntentParams(), WALLET_A, 10_000n);
      pool.add(createMockEncryptedIntent(), createMockIntentParams(), WALLET_A, 20_000n);

      expect(pool.getMetrics().averageTipLamports).toBe(15_000n);
    });
  });

  describe("events", () => {
    it("should emit intentAdded event", () => {
      const events: PooledIntent[] = [];
      pool.on("intentAdded", (intent: PooledIntent) => events.push(intent));

      pool.add(createMockEncryptedIntent(), createMockIntentParams(), WALLET_A, 5_000n);

      expect(events.length).toBe(1);
      expect(events[0].status).toBe("pending");
    });

    it("should emit intentRelayed event", () => {
      const events: string[] = [];
      pool.on("intentRelayed", (id: string) => events.push(id));

      const encrypted = createMockEncryptedIntent();
      pool.add(encrypted, createMockIntentParams(), WALLET_A, 5_000n);
      pool.markRelayed(encrypted.id, "tx_123");

      expect(events).toContain(encrypted.id);
    });

    it("should emit rateLimited event", () => {
      const limited: string[] = [];
      pool.on("rateLimited", (wallet: string) => limited.push(wallet));

      for (let i = 0; i < 10; i++) {
        pool.add(createMockEncryptedIntent(), createMockIntentParams(), WALLET_A, 5_000n);
      }

      try {
        pool.add(createMockEncryptedIntent(), createMockIntentParams(), WALLET_A, 5_000n);
      } catch {
        // Expected
      }

      expect(limited).toContain(WALLET_A);
    });
  });

  describe("pool capacity", () => {
    it("should evict lowest priority when full", () => {
      const smallPool = new IntentPool({ maxSize: 3, minTipLamports: 1_000n });

      smallPool.add(createMockEncryptedIntent("vnt_1"), createMockIntentParams(), WALLET_A, 1_000n);
      smallPool.add(createMockEncryptedIntent("vnt_2"), createMockIntentParams(), WALLET_A, 5_000n);
      smallPool.add(createMockEncryptedIntent("vnt_3"), createMockIntentParams(), WALLET_A, 10_000n);

      // Should evict vnt_1 (lowest tip)
      smallPool.add(createMockEncryptedIntent("vnt_4"), createMockIntentParams(), WALLET_A, 50_000n);

      expect(smallPool.size).toBe(3);
      expect(smallPool.get("vnt_1")).toBeUndefined();
      expect(smallPool.get("vnt_4")).toBeDefined();

      smallPool.stop();
    });
  });
});
