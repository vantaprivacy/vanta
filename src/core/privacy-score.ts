/**
 * VANTA Privacy Scoring Engine
 *
 * Computes a privacy score (0-100) for intents based on multiple
 * factors: encryption strength, relay path diversity, timing
 * obfuscation, amount blinding, and historical correlation risk.
 *
 * Higher scores indicate stronger privacy guarantees.
 */

import { Logger } from "../utils/logger";

const logger = new Logger("privacy-score");

// --- Types ---

export interface PrivacyFactors {
  /** Whether the intent payload is encrypted */
  isEncrypted: boolean;
  /** Encryption algorithm used */
  encryptionAlgo: "aes-256-gcm" | "chacha20-poly1305" | "none";
  /** Number of relay hops */
  relayHops: number;
  /** Whether timing is randomized */
  hasTimingJitter: boolean;
  /** Jitter range in milliseconds */
  timingJitterMs: number;
  /** Whether the amount is split across multiple transactions */
  amountSplit: boolean;
  /** Number of splits (1 = no splitting) */
  splitCount: number;
  /** Transaction amount in lamports */
  amountLamports: bigint;
  /** Token pair (for swap intents) */
  tokenPair?: string;
  /** Whether a decoy transaction is included */
  hasDecoy: boolean;
  /** Whether IP is masked via relay */
  ipMasked: boolean;
  /** Previous transaction count from this wallet (correlation risk) */
  walletTxCount: number;
  /** Time since last transaction from this wallet (seconds) */
  timeSinceLastTx: number;
}

export interface PrivacyBreakdown {
  /** Final composite score (0-100) */
  score: number;
  /** Individual factor scores */
  factors: {
    encryption: number;
    relayPath: number;
    timing: number;
    amountPrivacy: number;
    correlationResistance: number;
    networkPrivacy: number;
  };
  /** Human-readable risk level */
  riskLevel: "minimal" | "low" | "medium" | "high" | "critical";
  /** Specific recommendations to improve privacy */
  recommendations: string[];
  /** Estimated anonymity set size */
  anonymitySetSize: number;
}

export interface ScoreWeights {
  encryption: number;
  relayPath: number;
  timing: number;
  amountPrivacy: number;
  correlationResistance: number;
  networkPrivacy: number;
}

export interface HistoricalPattern {
  wallet: string;
  averageAmount: bigint;
  averageInterval: number;
  commonPairs: string[];
  txCount: number;
  lastSeen: number;
}

// --- Constants ---

const DEFAULT_WEIGHTS: ScoreWeights = {
  encryption: 0.25,
  relayPath: 0.20,
  timing: 0.15,
  amountPrivacy: 0.15,
  correlationResistance: 0.15,
  networkPrivacy: 0.10,
};

/** Amount thresholds for privacy buckets (lamports) */
const AMOUNT_THRESHOLDS = {
  dust: 100_000n, // 0.0001 SOL
  small: 1_000_000_000n, // 1 SOL
  medium: 10_000_000_000n, // 10 SOL
  large: 100_000_000_000n, // 100 SOL
  whale: 1_000_000_000_000n, // 1000 SOL
};

/** Popular pairs that have larger anonymity sets */
const HIGH_VOLUME_PAIRS = [
  "SOL/USDC",
  "SOL/USDT",
  "SOL/mSOL",
  "SOL/jitoSOL",
  "SOL/bSOL",
  "USDC/USDT",
];

// --- Scoring Engine ---

export class PrivacyScorer {
  private weights: ScoreWeights;
  private walletHistory: Map<string, HistoricalPattern> = new Map();
  private scoringHistory: Array<{ score: number; timestamp: number }> = [];

  constructor(weights?: Partial<ScoreWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
    this.validateWeights();
  }

  /**
   * Compute a comprehensive privacy score for the given factors.
   */
  score(factors: PrivacyFactors): PrivacyBreakdown {
    const encryption = this.scoreEncryption(factors);
    const relayPath = this.scoreRelayPath(factors);
    const timing = this.scoreTiming(factors);
    const amountPrivacy = this.scoreAmountPrivacy(factors);
    const correlationResistance = this.scoreCorrelationResistance(factors);
    const networkPrivacy = this.scoreNetworkPrivacy(factors);

    const composite = Math.round(
      encryption * this.weights.encryption +
      relayPath * this.weights.relayPath +
      timing * this.weights.timing +
      amountPrivacy * this.weights.amountPrivacy +
      correlationResistance * this.weights.correlationResistance +
      networkPrivacy * this.weights.networkPrivacy
    );

    const finalScore = Math.min(100, Math.max(0, composite));
    const riskLevel = this.computeRiskLevel(finalScore);
    const recommendations = this.generateRecommendations(factors, {
      encryption,
      relayPath,
      timing,
      amountPrivacy,
      correlationResistance,
      networkPrivacy,
    });

    const anonymitySetSize = this.estimateAnonymitySet(factors);

    // Track history
    this.scoringHistory.push({ score: finalScore, timestamp: Date.now() });
    if (this.scoringHistory.length > 10_000) {
      this.scoringHistory = this.scoringHistory.slice(-5_000);
    }

    logger.debug(
      `Privacy score: ${finalScore}/100 (${riskLevel}) — ` +
      `enc=${encryption} relay=${relayPath} time=${timing} ` +
      `amt=${amountPrivacy} corr=${correlationResistance} net=${networkPrivacy}`
    );

    return {
      score: finalScore,
      factors: {
        encryption,
        relayPath,
        timing,
        amountPrivacy,
        correlationResistance,
        networkPrivacy,
      },
      riskLevel,
      recommendations,
      anonymitySetSize,
    };
  }

  /**
   * Record a wallet's transaction for correlation analysis.
   */
  recordWalletActivity(
    wallet: string,
    amount: bigint,
    pair?: string
  ): void {
    const existing = this.walletHistory.get(wallet);

    if (existing) {
      const newCount = existing.txCount + 1;
      existing.averageAmount =
        (existing.averageAmount * BigInt(existing.txCount) + amount) / BigInt(newCount);
      existing.averageInterval =
        (Date.now() - existing.lastSeen + existing.averageInterval * existing.txCount) /
        newCount;
      existing.txCount = newCount;
      existing.lastSeen = Date.now();
      if (pair && !existing.commonPairs.includes(pair)) {
        existing.commonPairs.push(pair);
        if (existing.commonPairs.length > 20) {
          existing.commonPairs = existing.commonPairs.slice(-10);
        }
      }
    } else {
      this.walletHistory.set(wallet, {
        wallet,
        averageAmount: amount,
        averageInterval: 0,
        commonPairs: pair ? [pair] : [],
        txCount: 1,
        lastSeen: Date.now(),
      });
    }
  }

  /**
   * Get the average privacy score across all scored intents.
   */
  getAverageScore(): number {
    if (this.scoringHistory.length === 0) return 0;
    const sum = this.scoringHistory.reduce((s, h) => s + h.score, 0);
    return Math.round(sum / this.scoringHistory.length);
  }

  /**
   * Get wallet pattern data for correlation risk assessment.
   */
  getWalletPattern(wallet: string): HistoricalPattern | undefined {
    return this.walletHistory.get(wallet);
  }

  // --- Factor Scoring ---

  private scoreEncryption(factors: PrivacyFactors): number {
    if (!factors.isEncrypted) return 0;

    switch (factors.encryptionAlgo) {
      case "aes-256-gcm":
        return 100; // Gold standard for authenticated encryption
      case "chacha20-poly1305":
        return 95; // Also excellent, slightly less hardware support
      case "none":
        return 0;
      default:
        return 0;
    }
  }

  private scoreRelayPath(factors: PrivacyFactors): number {
    // More relay hops = better privacy (diminishing returns past 3)
    if (factors.relayHops === 0) return 10; // Direct submission, minimal privacy
    if (factors.relayHops === 1) return 50;
    if (factors.relayHops === 2) return 75;
    if (factors.relayHops >= 3) return 95;
    return 30;
  }

  private scoreTiming(factors: PrivacyFactors): number {
    if (!factors.hasTimingJitter) return 20; // No jitter = timing correlation possible

    // Score based on jitter range
    if (factors.timingJitterMs < 100) return 30; // Too little jitter
    if (factors.timingJitterMs < 500) return 50;
    if (factors.timingJitterMs < 2000) return 70;
    if (factors.timingJitterMs < 10_000) return 85;
    return 95; // 10s+ jitter is excellent
  }

  private scoreAmountPrivacy(factors: PrivacyFactors): number {
    let score = 50; // Base score

    // Amount size affects anonymity set
    const amount = factors.amountLamports;
    if (amount <= AMOUNT_THRESHOLDS.dust) {
      score += 20; // Dust transactions are harder to trace
    } else if (amount <= AMOUNT_THRESHOLDS.small) {
      score += 15;
    } else if (amount <= AMOUNT_THRESHOLDS.medium) {
      score += 5;
    } else if (amount <= AMOUNT_THRESHOLDS.large) {
      score -= 10; // Large amounts are more conspicuous
    } else {
      score -= 25; // Whale transactions are very visible
    }

    // Splitting improves privacy
    if (factors.amountSplit && factors.splitCount > 1) {
      const splitBonus = Math.min(20, factors.splitCount * 5);
      score += splitBonus;
    }

    // Popular pairs have larger anonymity sets
    if (factors.tokenPair && HIGH_VOLUME_PAIRS.includes(factors.tokenPair)) {
      score += 10;
    }

    // Decoys improve privacy
    if (factors.hasDecoy) {
      score += 10;
    }

    return Math.min(100, Math.max(0, score));
  }

  private scoreCorrelationResistance(factors: PrivacyFactors): number {
    let score = 70; // Base — encrypted intents have decent correlation resistance

    // More historical transactions = higher correlation risk
    if (factors.walletTxCount > 100) {
      score -= 25;
    } else if (factors.walletTxCount > 50) {
      score -= 15;
    } else if (factors.walletTxCount > 10) {
      score -= 5;
    } else {
      score += 10; // New wallets are harder to correlate
    }

    // Regular timing patterns are bad
    if (factors.timeSinceLastTx > 0 && factors.timeSinceLastTx < 60) {
      score -= 15; // Very frequent = easily correlatable
    } else if (factors.timeSinceLastTx > 3600) {
      score += 5; // Infrequent = harder to correlate
    }

    return Math.min(100, Math.max(0, score));
  }

  private scoreNetworkPrivacy(factors: PrivacyFactors): number {
    let score = 30; // Base

    if (factors.ipMasked) {
      score += 50; // IP masking is critical
    }

    if (factors.relayHops >= 2) {
      score += 15; // Multiple hops make network-level correlation harder
    }

    return Math.min(100, Math.max(0, score));
  }

  // --- Helpers ---

  private computeRiskLevel(
    score: number
  ): "minimal" | "low" | "medium" | "high" | "critical" {
    if (score >= 85) return "minimal";
    if (score >= 65) return "low";
    if (score >= 45) return "medium";
    if (score >= 25) return "high";
    return "critical";
  }

  private generateRecommendations(
    factors: PrivacyFactors,
    scores: Record<string, number>
  ): string[] {
    const recs: string[] = [];

    if (scores.encryption < 50) {
      recs.push("Enable AES-256-GCM encryption for intent payloads");
    }
    if (scores.relayPath < 50) {
      recs.push("Route through at least 2 relay hops for better privacy");
    }
    if (scores.timing < 50) {
      recs.push("Enable timing jitter (recommended: 1-5 seconds)");
    }
    if (scores.amountPrivacy < 50) {
      if (factors.amountLamports > AMOUNT_THRESHOLDS.large) {
        recs.push("Split large amounts across multiple intents");
      }
      if (!factors.hasDecoy) {
        recs.push("Add decoy transactions to increase anonymity set");
      }
    }
    if (scores.correlationResistance < 50) {
      recs.push("Vary transaction timing to reduce pattern correlation");
    }
    if (scores.networkPrivacy < 50) {
      if (!factors.ipMasked) {
        recs.push("Enable IP masking through the relay network");
      }
    }

    return recs;
  }

  private estimateAnonymitySet(factors: PrivacyFactors): number {
    let baseSize = 100; // Minimum anonymity set on Solana mainnet

    // Popular pairs have more concurrent transactions
    if (factors.tokenPair && HIGH_VOLUME_PAIRS.includes(factors.tokenPair)) {
      baseSize *= 10;
    }

    // Small amounts blend better
    if (factors.amountLamports <= AMOUNT_THRESHOLDS.small) {
      baseSize *= 5;
    } else if (factors.amountLamports >= AMOUNT_THRESHOLDS.whale) {
      baseSize = Math.max(5, baseSize / 10);
    }

    // Encryption increases effective anonymity set
    if (factors.isEncrypted) {
      baseSize *= 3;
    }

    // Multiple relay hops increase set
    baseSize *= Math.max(1, factors.relayHops);

    return Math.round(baseSize);
  }

  private validateWeights(): void {
    const total = Object.values(this.weights).reduce((s, w) => s + w, 0);
    if (Math.abs(total - 1.0) > 0.001) {
      logger.warn(`Score weights sum to ${total.toFixed(3)}, expected 1.0`);
    }
  }
}
