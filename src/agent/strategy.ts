/**
 * VANTA Strategy Framework
 *
 * Defines the interface and built-in strategies for AI agent execution.
 * Strategies encapsulate trading/DeFi logic and produce intents
 * that are submitted through the privacy layer.
 *
 * Built-in strategies:
 *   - DCA (Dollar-Cost Averaging)
 *   - TWAP (Time-Weighted Average Price)
 *   - Limit Order (privacy-preserving)
 *   - Rebalance (portfolio rebalancing)
 */

import { Logger } from "../utils/logger";
import type { IntentParams } from "../core/intent-engine";

const logger = new Logger("strategy");

// --- Core Types ---

export interface Strategy {
  /** Strategy name */
  name: string;
  /** Strategy description */
  description: string;
  /** Strategy version */
  version: string;
  /** Execute the strategy and produce intents */
  execute(context: StrategyContext): Promise<StrategyResult>;
  /** Validate strategy configuration */
  validate(): boolean;
}

export interface StrategyConfig {
  /** Strategy name */
  name: string;
  /** Strategy-specific parameters */
  params: Record<string, unknown>;
}

export interface StrategyContext {
  /** Agent ID running this strategy */
  agentId: string;
  /** Wallet address */
  walletAddress: string;
  /** Maximum position size (lamports) */
  maxPositionLamports: bigint;
  /** Privacy level */
  privacyLevel: "standard" | "enhanced" | "maximum";
  /** Whether this is a dry run */
  dryRun: boolean;
  /** Execution number (increments each run) */
  executionNumber: number;
  /** Current timestamp */
  timestamp: number;
}

export interface StrategyResult {
  /** Intents to submit */
  intents: IntentParams[];
  /** Estimated PnL (lamports) */
  estimatedPnL: bigint;
  /** Strategy-specific metadata */
  metadata: Record<string, unknown>;
}

// --- DCA Strategy ---

export interface DCAConfig {
  /** Input token mint address */
  inputMint: string;
  /** Output token mint address */
  outputMint: string;
  /** Amount per interval (in input token smallest unit) */
  amountPerInterval: bigint;
  /** Total number of intervals */
  totalIntervals: number;
  /** Maximum slippage tolerance (percent) */
  maxSlippage: number;
}

export class DCAStrategy implements Strategy {
  readonly name = "DCA";
  readonly description = "Dollar-Cost Averaging — buys a fixed amount at regular intervals";
  readonly version = "1.0.0";

  private config: DCAConfig;
  private executedIntervals: number = 0;
  private totalSpent: bigint = 0n;
  private totalReceived: bigint = 0n;

  constructor(config: DCAConfig) {
    this.config = config;
    if (!this.validate()) {
      throw new StrategyError("Invalid DCA configuration");
    }
  }

  validate(): boolean {
    if (!this.config.inputMint || !this.config.outputMint) return false;
    if (this.config.amountPerInterval <= 0n) return false;
    if (this.config.totalIntervals <= 0) return false;
    if (this.config.maxSlippage <= 0 || this.config.maxSlippage > 50) return false;
    return true;
  }

  async execute(context: StrategyContext): Promise<StrategyResult> {
    if (this.executedIntervals >= this.config.totalIntervals) {
      logger.info(`DCA complete: ${this.executedIntervals}/${this.config.totalIntervals} intervals`);
      return { intents: [], estimatedPnL: 0n, metadata: { complete: true } };
    }

    // Check position limit
    const amountNumber = Number(this.config.amountPerInterval);
    if (BigInt(amountNumber) > context.maxPositionLamports) {
      logger.warn("DCA amount exceeds position limit");
      return { intents: [], estimatedPnL: 0n, metadata: { skipped: "position_limit" } };
    }

    const intent: IntentParams = {
      type: "swap",
      inputMint: this.config.inputMint,
      outputMint: this.config.outputMint,
      amount: amountNumber,
      slippage: this.config.maxSlippage,
    };

    this.executedIntervals++;
    this.totalSpent += this.config.amountPerInterval;

    logger.info(
      `DCA interval ${this.executedIntervals}/${this.config.totalIntervals}: ` +
      `${amountNumber} ${this.config.inputMint.slice(0, 8)} -> ${this.config.outputMint.slice(0, 8)}`
    );

    return {
      intents: [intent],
      estimatedPnL: 0n, // DCA doesn't predict PnL per interval
      metadata: {
        interval: this.executedIntervals,
        totalIntervals: this.config.totalIntervals,
        totalSpent: this.totalSpent.toString(),
        progress: `${((this.executedIntervals / this.config.totalIntervals) * 100).toFixed(1)}%`,
      },
    };
  }

  getProgress(): {
    executed: number;
    total: number;
    totalSpent: bigint;
    percentComplete: number;
  } {
    return {
      executed: this.executedIntervals,
      total: this.config.totalIntervals,
      totalSpent: this.totalSpent,
      percentComplete: (this.executedIntervals / this.config.totalIntervals) * 100,
    };
  }
}

// --- TWAP Strategy ---

export interface TWAPConfig {
  /** Input token mint */
  inputMint: string;
  /** Output token mint */
  outputMint: string;
  /** Total amount to execute */
  totalAmount: bigint;
  /** Number of slices to split into */
  slices: number;
  /** Maximum slippage per slice */
  maxSlippage: number;
  /** Minimum time between slices (seconds) */
  minIntervalSeconds: number;
  /** Price deviation threshold to skip a slice */
  priceDeviationThreshold: number;
}

export class TWAPStrategy implements Strategy {
  readonly name = "TWAP";
  readonly description = "Time-Weighted Average Price — splits order across time to minimize impact";
  readonly version = "1.0.0";

  private config: TWAPConfig;
  private executedSlices: number = 0;
  private lastExecutionTime: number = 0;
  private amountPerSlice: bigint;

  constructor(config: TWAPConfig) {
    this.config = config;
    this.amountPerSlice = config.totalAmount / BigInt(config.slices);
    if (!this.validate()) {
      throw new StrategyError("Invalid TWAP configuration");
    }
  }

  validate(): boolean {
    if (!this.config.inputMint || !this.config.outputMint) return false;
    if (this.config.totalAmount <= 0n) return false;
    if (this.config.slices <= 0 || this.config.slices > 100) return false;
    if (this.config.maxSlippage <= 0) return false;
    return true;
  }

  async execute(context: StrategyContext): Promise<StrategyResult> {
    if (this.executedSlices >= this.config.slices) {
      return { intents: [], estimatedPnL: 0n, metadata: { complete: true } };
    }

    // Enforce minimum interval
    const elapsed = (context.timestamp - this.lastExecutionTime) / 1000;
    if (this.lastExecutionTime > 0 && elapsed < this.config.minIntervalSeconds) {
      logger.debug(
        `TWAP: waiting for interval (${elapsed.toFixed(0)}s / ${this.config.minIntervalSeconds}s)`
      );
      return { intents: [], estimatedPnL: 0n, metadata: { waiting: true } };
    }

    // Handle remainder on last slice
    const isLastSlice = this.executedSlices === this.config.slices - 1;
    const sliceAmount = isLastSlice
      ? this.config.totalAmount - this.amountPerSlice * BigInt(this.executedSlices)
      : this.amountPerSlice;

    const intent: IntentParams = {
      type: "swap",
      inputMint: this.config.inputMint,
      outputMint: this.config.outputMint,
      amount: Number(sliceAmount),
      slippage: this.config.maxSlippage,
    };

    this.executedSlices++;
    this.lastExecutionTime = context.timestamp;

    logger.info(
      `TWAP slice ${this.executedSlices}/${this.config.slices}: ` +
      `${sliceAmount} (${((this.executedSlices / this.config.slices) * 100).toFixed(0)}%)`
    );

    return {
      intents: [intent],
      estimatedPnL: 0n,
      metadata: {
        slice: this.executedSlices,
        totalSlices: this.config.slices,
        sliceAmount: sliceAmount.toString(),
        remainingAmount: (
          this.config.totalAmount - this.amountPerSlice * BigInt(this.executedSlices)
        ).toString(),
      },
    };
  }
}

// --- Limit Order Strategy ---

export interface LimitOrderConfig {
  /** Input token mint */
  inputMint: string;
  /** Output token mint */
  outputMint: string;
  /** Amount to sell */
  amount: bigint;
  /** Target price (output per input, scaled by 1e9) */
  targetPrice: bigint;
  /** Price tolerance (basis points) */
  toleranceBps: number;
  /** Order expiry (unix timestamp ms) */
  expiresAt: number;
}

export class LimitOrderStrategy implements Strategy {
  readonly name = "LimitOrder";
  readonly description = "Privacy-preserving limit order — executes when price reaches target";
  readonly version = "1.0.0";

  private config: LimitOrderConfig;
  private executed: boolean = false;

  constructor(config: LimitOrderConfig) {
    this.config = config;
    if (!this.validate()) {
      throw new StrategyError("Invalid LimitOrder configuration");
    }
  }

  validate(): boolean {
    if (!this.config.inputMint || !this.config.outputMint) return false;
    if (this.config.amount <= 0n) return false;
    if (this.config.targetPrice <= 0n) return false;
    if (this.config.expiresAt <= Date.now()) return false;
    return true;
  }

  async execute(context: StrategyContext): Promise<StrategyResult> {
    if (this.executed) {
      return { intents: [], estimatedPnL: 0n, metadata: { filled: true } };
    }

    if (context.timestamp > this.config.expiresAt) {
      logger.info("Limit order expired");
      return { intents: [], estimatedPnL: 0n, metadata: { expired: true } };
    }

    // In production: fetch current price from oracle/DEX
    // const currentPrice = await fetchPrice(this.config.inputMint, this.config.outputMint);
    // For now, simulate price check
    const currentPrice = this.config.targetPrice; // Placeholder

    const priceDiff = Number(
      ((currentPrice - this.config.targetPrice) * 10000n) / this.config.targetPrice
    );

    if (Math.abs(priceDiff) <= this.config.toleranceBps) {
      const intent: IntentParams = {
        type: "swap",
        inputMint: this.config.inputMint,
        outputMint: this.config.outputMint,
        amount: Number(this.config.amount),
        slippage: this.config.toleranceBps / 100,
      };

      this.executed = true;

      logger.info(
        `Limit order triggered at price ${currentPrice} ` +
        `(target: ${this.config.targetPrice}, diff: ${priceDiff}bps)`
      );

      return {
        intents: [intent],
        estimatedPnL: 0n,
        metadata: {
          triggerPrice: currentPrice.toString(),
          targetPrice: this.config.targetPrice.toString(),
          priceDiffBps: priceDiff,
        },
      };
    }

    return {
      intents: [],
      estimatedPnL: 0n,
      metadata: { watching: true, priceDiffBps: priceDiff },
    };
  }
}

// --- Rebalance Strategy ---

export interface RebalanceConfig {
  /** Target allocations: mint -> percentage (0-100) */
  targetAllocations: Map<string, number>;
  /** Rebalance threshold (percent deviation to trigger) */
  thresholdPercent: number;
  /** Maximum slippage */
  maxSlippage: number;
  /** Quote token mint (e.g., USDC) */
  quoteMint: string;
}

export class RebalanceStrategy implements Strategy {
  readonly name = "Rebalance";
  readonly description = "Portfolio rebalancer — adjusts positions to match target allocations";
  readonly version = "1.0.0";

  private config: RebalanceConfig;
  private rebalanceCount: number = 0;

  constructor(config: RebalanceConfig) {
    this.config = config;
    if (!this.validate()) {
      throw new StrategyError("Invalid Rebalance configuration");
    }
  }

  validate(): boolean {
    if (this.config.targetAllocations.size === 0) return false;
    const totalAllocation = [...this.config.targetAllocations.values()].reduce(
      (s, v) => s + v,
      0
    );
    if (Math.abs(totalAllocation - 100) > 0.01) return false;
    if (this.config.thresholdPercent <= 0) return false;
    return true;
  }

  async execute(_context: StrategyContext): Promise<StrategyResult> {
    // In production: fetch current portfolio balances and compute deviations
    // For now, return empty — rebalancing requires real balance data
    const intents: IntentParams[] = [];

    // Simulate: check each allocation for deviation
    for (const [mint, targetPct] of this.config.targetAllocations) {
      // Would compare currentPct vs targetPct
      const currentPct = targetPct; // Placeholder
      const deviation = Math.abs(currentPct - targetPct);

      if (deviation > this.config.thresholdPercent) {
        if (currentPct > targetPct) {
          // Over-allocated: sell
          intents.push({
            type: "swap",
            inputMint: mint,
            outputMint: this.config.quoteMint,
            amount: 0, // Would compute from deviation
            slippage: this.config.maxSlippage,
          });
        } else {
          // Under-allocated: buy
          intents.push({
            type: "swap",
            inputMint: this.config.quoteMint,
            outputMint: mint,
            amount: 0, // Would compute from deviation
            slippage: this.config.maxSlippage,
          });
        }
      }
    }

    if (intents.length > 0) {
      this.rebalanceCount++;
      logger.info(
        `Rebalance #${this.rebalanceCount}: ${intents.length} trades needed`
      );
    }

    return {
      intents,
      estimatedPnL: 0n,
      metadata: {
        rebalanceCount: this.rebalanceCount,
        tradesNeeded: intents.length,
        allocations: Object.fromEntries(this.config.targetAllocations),
      },
    };
  }
}

// --- Strategy Factory ---

export function createStrategy(
  config: StrategyConfig
): Strategy {
  switch (config.name) {
    case "DCA":
      return new DCAStrategy(config.params as unknown as DCAConfig);
    case "TWAP":
      return new TWAPStrategy(config.params as unknown as TWAPConfig);
    case "LimitOrder":
      return new LimitOrderStrategy(config.params as unknown as LimitOrderConfig);
    case "Rebalance":
      return new RebalanceStrategy(config.params as unknown as RebalanceConfig);
    default:
      throw new StrategyError(`Unknown strategy: ${config.name}`);
  }
}

// --- Error ---

export class StrategyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrategyError";
  }
}
