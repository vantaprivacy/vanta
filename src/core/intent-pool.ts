/**
 * VANTA Intent Pool (Mempool)
 *
 * Manages pending intents before they are relayed to solvers.
 * Implements priority ordering, deduplication, TTL expiry,
 * and rate limiting per wallet.
 *
 * The pool operates as a bounded priority queue where intents
 * with higher privacy scores and tips are processed first.
 */

import { EventEmitter } from "events";
import { Logger } from "../utils/logger";
import type { EncryptedIntent, IntentParams } from "./intent-engine";

const logger = new Logger("intent-pool");

// --- Types ---

export interface PooledIntent {
  /** Unique intent identifier (vnt_ prefix) */
  id: string;
  /** Encrypted intent payload */
  encrypted: EncryptedIntent;
  /** Original parameters (only available to pool owner) */
  params: IntentParams;
  /** Solver tip in lamports */
  tipLamports: bigint;
  /** Privacy score 0-100 */
  privacyScore: number;
  /** Priority score (computed from tip + privacy + age) */
  priority: number;
  /** Submitter wallet address */
  submitter: string;
  /** When the intent was added to the pool */
  addedAt: number;
  /** Number of relay attempts */
  relayAttempts: number;
  /** Current status */
  status: IntentStatus;
}

export type IntentStatus =
  | "pending"
  | "relaying"
  | "relayed"
  | "executed"
  | "expired"
  | "dropped"
  | "failed";

export interface PoolConfig {
  /** Maximum number of intents in the pool */
  maxSize: number;
  /** Intent TTL in seconds */
  defaultTTL: number;
  /** Max intents per wallet in the pool */
  maxPerWallet: number;
  /** Max relay retry attempts */
  maxRelayAttempts: number;
  /** How often to prune expired intents (ms) */
  pruneIntervalMs: number;
  /** Minimum tip to accept an intent (lamports) */
  minTipLamports: bigint;
  /** Priority weight for tip amount */
  tipWeight: number;
  /** Priority weight for privacy score */
  privacyWeight: number;
  /** Priority weight for age (older = higher priority) */
  ageWeight: number;
}

export interface PoolMetrics {
  totalAdded: number;
  totalRelayed: number;
  totalExpired: number;
  totalDropped: number;
  totalFailed: number;
  currentSize: number;
  uniqueSubmitters: number;
  averageTipLamports: bigint;
  averagePrivacyScore: number;
  averageTimeInPoolMs: number;
}

export interface PoolEvents {
  intentAdded: (intent: PooledIntent) => void;
  intentRelayed: (intentId: string, txSignature: string) => void;
  intentExpired: (intentId: string) => void;
  intentDropped: (intentId: string, reason: string) => void;
  poolFull: (droppedId: string) => void;
  rateLimited: (wallet: string) => void;
}

// --- Default config ---

const DEFAULT_POOL_CONFIG: PoolConfig = {
  maxSize: 10_000,
  defaultTTL: 120,
  maxPerWallet: 50,
  maxRelayAttempts: 3,
  pruneIntervalMs: 10_000,
  minTipLamports: 1_000n,
  tipWeight: 0.5,
  privacyWeight: 0.3,
  ageWeight: 0.2,
};

// --- Pool Implementation ---

export class IntentPool extends EventEmitter {
  private intents: Map<string, PooledIntent> = new Map();
  private walletCounts: Map<string, number> = new Map();
  private config: PoolConfig;
  private pruneTimer?: NodeJS.Timeout;
  private metrics: PoolMetrics = {
    totalAdded: 0,
    totalRelayed: 0,
    totalExpired: 0,
    totalDropped: 0,
    totalFailed: 0,
    currentSize: 0,
    uniqueSubmitters: 0,
    averageTipLamports: 0n,
    averagePrivacyScore: 0,
    averageTimeInPoolMs: 0,
  };

  constructor(config?: Partial<PoolConfig>) {
    super();
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
  }

  /**
   * Start the pool's background prune timer.
   */
  start(): void {
    this.pruneTimer = setInterval(
      () => this.pruneExpired(),
      this.config.pruneIntervalMs
    );
    logger.info(
      `Intent pool started (max: ${this.config.maxSize}, ` +
      `TTL: ${this.config.defaultTTL}s, prune: ${this.config.pruneIntervalMs}ms)`
    );
  }

  /**
   * Stop the pool and clear the prune timer.
   */
  stop(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
    logger.info(`Intent pool stopped (${this.intents.size} intents remaining)`);
  }

  /**
   * Add an intent to the pool.
   *
   * @throws Error if rate limited, pool full (and no lower-priority to evict),
   *         or intent already exists.
   */
  add(
    encrypted: EncryptedIntent,
    params: IntentParams,
    submitter: string,
    tipLamports: bigint = 0n
  ): PooledIntent {
    // Deduplication
    if (this.intents.has(encrypted.id)) {
      throw new PoolError(`Intent ${encrypted.id} already in pool`, "DUPLICATE");
    }

    // Rate limiting per wallet
    const walletCount = this.walletCounts.get(submitter) ?? 0;
    if (walletCount >= this.config.maxPerWallet) {
      this.emit("rateLimited", submitter);
      throw new PoolError(
        `Wallet ${submitter.slice(0, 8)}... rate limited ` +
        `(${walletCount}/${this.config.maxPerWallet})`,
        "RATE_LIMITED"
      );
    }

    // Minimum tip check
    if (tipLamports < this.config.minTipLamports) {
      throw new PoolError(
        `Tip ${tipLamports} below minimum ${this.config.minTipLamports}`,
        "TIP_TOO_LOW"
      );
    }

    // Pool capacity check — evict lowest priority if full
    if (this.intents.size >= this.config.maxSize) {
      const evicted = this.evictLowestPriority();
      if (!evicted) {
        throw new PoolError("Pool is full and no evictable intent found", "POOL_FULL");
      }
    }

    const pooledIntent: PooledIntent = {
      id: encrypted.id,
      encrypted,
      params,
      tipLamports,
      privacyScore: encrypted.privacyScore,
      priority: this.computePriority(tipLamports, encrypted.privacyScore, Date.now()),
      submitter,
      addedAt: Date.now(),
      relayAttempts: 0,
      status: "pending",
    };

    this.intents.set(encrypted.id, pooledIntent);
    this.walletCounts.set(submitter, walletCount + 1);
    this.metrics.totalAdded++;
    this.updateMetrics();

    this.emit("intentAdded", pooledIntent);
    logger.debug(
      `Added intent ${encrypted.id} (priority: ${pooledIntent.priority.toFixed(2)}, ` +
      `tip: ${tipLamports}, pool: ${this.intents.size})`
    );

    return pooledIntent;
  }

  /**
   * Get the next batch of intents to relay, ordered by priority.
   *
   * @param batchSize - Maximum number of intents to return
   * @returns Intents sorted by descending priority
   */
  getNextBatch(batchSize: number): PooledIntent[] {
    const pending = [...this.intents.values()]
      .filter((i) => i.status === "pending")
      .map((i) => ({
        ...i,
        priority: this.computePriority(i.tipLamports, i.privacyScore, i.addedAt),
      }))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, batchSize);

    // Mark as relaying
    for (const intent of pending) {
      const pooled = this.intents.get(intent.id);
      if (pooled) {
        pooled.status = "relaying";
        pooled.relayAttempts++;
      }
    }

    return pending;
  }

  /**
   * Mark an intent as successfully relayed.
   */
  markRelayed(intentId: string, txSignature: string): void {
    const intent = this.intents.get(intentId);
    if (!intent) return;

    intent.status = "relayed";
    this.metrics.totalRelayed++;
    this.decrementWalletCount(intent.submitter);

    this.emit("intentRelayed", intentId, txSignature);
    logger.info(`Intent ${intentId} relayed: ${txSignature}`);
  }

  /**
   * Mark an intent as executed on-chain.
   */
  markExecuted(intentId: string): void {
    const intent = this.intents.get(intentId);
    if (!intent) return;

    intent.status = "executed";
    this.intents.delete(intentId);
    this.updateMetrics();
  }

  /**
   * Mark a relay attempt as failed. Retries if under max attempts.
   */
  markFailed(intentId: string, error: string): void {
    const intent = this.intents.get(intentId);
    if (!intent) return;

    if (intent.relayAttempts < this.config.maxRelayAttempts) {
      intent.status = "pending"; // Back to pending for retry
      logger.warn(
        `Intent ${intentId} relay failed (attempt ${intent.relayAttempts}` +
        `/${this.config.maxRelayAttempts}): ${error}`
      );
    } else {
      intent.status = "failed";
      this.metrics.totalFailed++;
      this.decrementWalletCount(intent.submitter);
      this.intents.delete(intentId);
      logger.error(`Intent ${intentId} permanently failed after ${intent.relayAttempts} attempts`);
    }

    this.updateMetrics();
  }

  /**
   * Get a specific intent by ID.
   */
  get(intentId: string): PooledIntent | undefined {
    return this.intents.get(intentId);
  }

  /**
   * Get all intents for a specific wallet.
   */
  getByWallet(wallet: string): PooledIntent[] {
    return [...this.intents.values()].filter((i) => i.submitter === wallet);
  }

  /**
   * Remove an intent from the pool (user cancellation).
   */
  remove(intentId: string): boolean {
    const intent = this.intents.get(intentId);
    if (!intent) return false;

    this.intents.delete(intentId);
    this.decrementWalletCount(intent.submitter);
    this.metrics.totalDropped++;
    this.updateMetrics();

    this.emit("intentDropped", intentId, "cancelled");
    return true;
  }

  /**
   * Get current pool size.
   */
  get size(): number {
    return this.intents.size;
  }

  /**
   * Get pool metrics.
   */
  getMetrics(): Readonly<PoolMetrics> {
    return { ...this.metrics };
  }

  // --- Private ---

  private pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [id, intent] of this.intents) {
      const age = (now - intent.addedAt) / 1000;
      if (age > this.config.defaultTTL && intent.status === "pending") {
        intent.status = "expired";
        this.intents.delete(id);
        this.decrementWalletCount(intent.submitter);
        this.metrics.totalExpired++;
        pruned++;

        this.emit("intentExpired", id);
      }
    }

    if (pruned > 0) {
      this.updateMetrics();
      logger.info(`Pruned ${pruned} expired intents (pool: ${this.intents.size})`);
    }

    return pruned;
  }

  private evictLowestPriority(): string | null {
    let lowest: PooledIntent | null = null;
    let lowestPriority = Infinity;

    for (const intent of this.intents.values()) {
      if (intent.status !== "pending") continue;

      const priority = this.computePriority(
        intent.tipLamports,
        intent.privacyScore,
        intent.addedAt
      );

      if (priority < lowestPriority) {
        lowestPriority = priority;
        lowest = intent;
      }
    }

    if (!lowest) return null;

    this.intents.delete(lowest.id);
    this.decrementWalletCount(lowest.submitter);
    this.metrics.totalDropped++;
    this.updateMetrics();

    this.emit("poolFull", lowest.id);
    logger.warn(`Evicted low-priority intent ${lowest.id} (priority: ${lowestPriority.toFixed(2)})`);

    return lowest.id;
  }

  private computePriority(
    tipLamports: bigint,
    privacyScore: number,
    addedAt: number
  ): number {
    // Normalize tip to 0-1 range (1 SOL = max reasonable tip)
    const normalizedTip = Math.min(Number(tipLamports) / 1_000_000_000, 1);

    // Normalize privacy to 0-1
    const normalizedPrivacy = privacyScore / 100;

    // Age factor: older intents get slightly higher priority (prevents starvation)
    const ageSeconds = (Date.now() - addedAt) / 1000;
    const normalizedAge = Math.min(ageSeconds / this.config.defaultTTL, 1);

    return (
      this.config.tipWeight * normalizedTip +
      this.config.privacyWeight * normalizedPrivacy +
      this.config.ageWeight * normalizedAge
    );
  }

  private decrementWalletCount(wallet: string): void {
    const count = this.walletCounts.get(wallet) ?? 0;
    if (count <= 1) {
      this.walletCounts.delete(wallet);
    } else {
      this.walletCounts.set(wallet, count - 1);
    }
  }

  private updateMetrics(): void {
    const intents = [...this.intents.values()];
    this.metrics.currentSize = intents.length;
    this.metrics.uniqueSubmitters = this.walletCounts.size;

    if (intents.length > 0) {
      const totalTip = intents.reduce((s, i) => s + i.tipLamports, 0n);
      this.metrics.averageTipLamports = totalTip / BigInt(intents.length);

      this.metrics.averagePrivacyScore =
        intents.reduce((s, i) => s + i.privacyScore, 0) / intents.length;

      const now = Date.now();
      this.metrics.averageTimeInPoolMs =
        intents.reduce((s, i) => s + (now - i.addedAt), 0) / intents.length;
    }
  }
}

// --- Error class ---

export class PoolError extends Error {
  readonly code: string;

  constructor(message: string, code: string = "POOL_ERROR") {
    super(message);
    this.name = "PoolError";
    this.code = code;
  }
}
