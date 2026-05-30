import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentExecutor, type IntentSubmitter } from "../src/agent/executor";
import {
  DCAStrategy,
  TWAPStrategy,
  LimitOrderStrategy,
  type DCAConfig,
  type TWAPConfig,
  type LimitOrderConfig,
} from "../src/agent/strategy";
import type { IntentResult } from "../src/core/intent-engine";

// --- Mock intent submitter ---

class MockIntentSubmitter implements IntentSubmitter {
  submissions: Array<{ type: string; amount: number }> = [];
  shouldFail: boolean = false;

  async submitIntent(params: { type: string; amount: number }): Promise<IntentResult> {
    if (this.shouldFail) {
      throw new Error("Submission failed");
    }
    this.submissions.push(params);
    return {
      intentId: `vnt_${Math.random().toString(36).slice(2)}`,
      status: "relayed",
      privacyScore: 80,
      txSignature: `sig_${Date.now()}`,
      executionTimeMs: 150,
    };
  }
}

// --- DCA Strategy Tests ---

describe("DCAStrategy", () => {
  it("should create a valid DCA strategy", () => {
    const config: DCAConfig = {
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amountPerInterval: 1_000_000_000n,
      totalIntervals: 10,
      maxSlippage: 1.0,
    };

    const strategy = new DCAStrategy(config);
    expect(strategy.name).toBe("DCA");
    expect(strategy.validate()).toBe(true);
  });

  it("should produce one intent per execution", async () => {
    const strategy = new DCAStrategy({
      inputMint: "So11111",
      outputMint: "EPjFWdd5",
      amountPerInterval: 500_000_000n,
      totalIntervals: 5,
      maxSlippage: 0.5,
    });

    const result = await strategy.execute({
      agentId: "agent_1",
      walletAddress: "wallet1",
      maxPositionLamports: 10_000_000_000n,
      privacyLevel: "enhanced",
      dryRun: false,
      executionNumber: 1,
      timestamp: Date.now(),
    });

    expect(result.intents.length).toBe(1);
    expect(result.intents[0].type).toBe("swap");
    expect(result.intents[0].amount).toBe(500_000_000);
  });

  it("should complete after all intervals", async () => {
    const strategy = new DCAStrategy({
      inputMint: "So11111",
      outputMint: "EPjFWdd5",
      amountPerInterval: 100_000n,
      totalIntervals: 3,
      maxSlippage: 1.0,
    });

    const ctx = {
      agentId: "agent_1",
      walletAddress: "wallet1",
      maxPositionLamports: 10_000_000_000n,
      privacyLevel: "enhanced" as const,
      dryRun: false,
      executionNumber: 1,
      timestamp: Date.now(),
    };

    await strategy.execute(ctx);
    await strategy.execute({ ...ctx, executionNumber: 2 });
    await strategy.execute({ ...ctx, executionNumber: 3 });

    // 4th execution should return empty (complete)
    const result = await strategy.execute({ ...ctx, executionNumber: 4 });
    expect(result.intents.length).toBe(0);
    expect(result.metadata.complete).toBe(true);
  });

  it("should track progress correctly", async () => {
    const strategy = new DCAStrategy({
      inputMint: "So11111",
      outputMint: "EPjFWdd5",
      amountPerInterval: 1_000_000n,
      totalIntervals: 10,
      maxSlippage: 1.0,
    });

    const ctx = {
      agentId: "agent_1",
      walletAddress: "wallet1",
      maxPositionLamports: 10_000_000_000n,
      privacyLevel: "enhanced" as const,
      dryRun: false,
      executionNumber: 1,
      timestamp: Date.now(),
    };

    await strategy.execute(ctx);
    await strategy.execute({ ...ctx, executionNumber: 2 });

    const progress = strategy.getProgress();
    expect(progress.executed).toBe(2);
    expect(progress.total).toBe(10);
    expect(progress.totalSpent).toBe(2_000_000n);
    expect(progress.percentComplete).toBe(20);
  });

  it("should reject invalid configuration", () => {
    expect(
      () =>
        new DCAStrategy({
          inputMint: "",
          outputMint: "EPjFWdd5",
          amountPerInterval: 0n,
          totalIntervals: 0,
          maxSlippage: -1,
        })
    ).toThrow();
  });
});

// --- TWAP Strategy Tests ---

describe("TWAPStrategy", () => {
  it("should split total amount across slices", async () => {
    const strategy = new TWAPStrategy({
      inputMint: "So11111",
      outputMint: "EPjFWdd5",
      totalAmount: 10_000_000_000n, // 10 SOL
      slices: 5,
      maxSlippage: 0.5,
      minIntervalSeconds: 0,
      priceDeviationThreshold: 5,
    });

    const ctx = {
      agentId: "agent_1",
      walletAddress: "wallet1",
      maxPositionLamports: 10_000_000_000n,
      privacyLevel: "enhanced" as const,
      dryRun: false,
      executionNumber: 1,
      timestamp: Date.now(),
    };

    const result = await strategy.execute(ctx);
    expect(result.intents.length).toBe(1);
    expect(result.intents[0].amount).toBe(2_000_000_000); // 10 SOL / 5 slices
  });

  it("should enforce minimum interval", async () => {
    const strategy = new TWAPStrategy({
      inputMint: "So11111",
      outputMint: "EPjFWdd5",
      totalAmount: 10_000_000_000n,
      slices: 5,
      maxSlippage: 0.5,
      minIntervalSeconds: 60,
      priceDeviationThreshold: 5,
    });

    const ctx = {
      agentId: "agent_1",
      walletAddress: "wallet1",
      maxPositionLamports: 10_000_000_000n,
      privacyLevel: "enhanced" as const,
      dryRun: false,
      executionNumber: 1,
      timestamp: Date.now(),
    };

    // First execution succeeds
    const r1 = await strategy.execute(ctx);
    expect(r1.intents.length).toBe(1);

    // Second execution too soon — should return empty
    const r2 = await strategy.execute({
      ...ctx,
      executionNumber: 2,
      timestamp: Date.now() + 10_000, // 10s later (< 60s)
    });
    expect(r2.intents.length).toBe(0);
    expect(r2.metadata.waiting).toBe(true);
  });
});

// --- LimitOrder Strategy Tests ---

describe("LimitOrderStrategy", () => {
  it("should trigger when price matches target", async () => {
    const strategy = new LimitOrderStrategy({
      inputMint: "So11111",
      outputMint: "EPjFWdd5",
      amount: 5_000_000_000n,
      targetPrice: 150_000_000_000n,
      toleranceBps: 50,
      expiresAt: Date.now() + 3600_000,
    });

    const ctx = {
      agentId: "agent_1",
      walletAddress: "wallet1",
      maxPositionLamports: 10_000_000_000n,
      privacyLevel: "enhanced" as const,
      dryRun: false,
      executionNumber: 1,
      timestamp: Date.now(),
    };

    const result = await strategy.execute(ctx);
    expect(result.intents.length).toBe(1);
    expect(result.intents[0].type).toBe("swap");
    expect(result.intents[0].amount).toBe(5_000_000_000);
  });

  it("should not trigger twice", async () => {
    const strategy = new LimitOrderStrategy({
      inputMint: "So11111",
      outputMint: "EPjFWdd5",
      amount: 1_000_000_000n,
      targetPrice: 100_000_000_000n,
      toleranceBps: 100,
      expiresAt: Date.now() + 3600_000,
    });

    const ctx = {
      agentId: "agent_1",
      walletAddress: "wallet1",
      maxPositionLamports: 10_000_000_000n,
      privacyLevel: "enhanced" as const,
      dryRun: false,
      executionNumber: 1,
      timestamp: Date.now(),
    };

    await strategy.execute(ctx);
    const r2 = await strategy.execute({ ...ctx, executionNumber: 2 });

    expect(r2.intents.length).toBe(0);
    expect(r2.metadata.filled).toBe(true);
  });

  it("should reject expired orders", () => {
    expect(
      () =>
        new LimitOrderStrategy({
          inputMint: "So11111",
          outputMint: "EPjFWdd5",
          amount: 1_000_000_000n,
          targetPrice: 100_000_000_000n,
          toleranceBps: 100,
          expiresAt: Date.now() - 1000, // Already expired
        })
    ).toThrow();
  });
});

// --- AgentExecutor Tests ---

describe("AgentExecutor", () => {
  let executor: AgentExecutor;
  let submitter: MockIntentSubmitter;

  beforeEach(() => {
    submitter = new MockIntentSubmitter();
    executor = new AgentExecutor(submitter, { maxAgents: 5 });
  });

  afterEach(() => {
    executor.stopAll();
  });

  it("should create an agent", async () => {
    const strategy = new DCAStrategy({
      inputMint: "So11111",
      outputMint: "EPjFWdd5",
      amountPerInterval: 1_000_000n,
      totalIntervals: 5,
      maxSlippage: 1.0,
    });

    const agent = await executor.createAgent("Test DCA", strategy);

    expect(agent.name).toBe("Test DCA");
    expect(agent.state).toBe("idle");
    expect(agent.executionCount).toBe(0);
  });

  it("should enforce max agents limit", async () => {
    const makeStrategy = () =>
      new DCAStrategy({
        inputMint: "So11111",
        outputMint: "EPjFWdd5",
        amountPerInterval: 1_000_000n,
        totalIntervals: 1,
        maxSlippage: 1.0,
      });

    for (let i = 0; i < 5; i++) {
      await executor.createAgent(`Agent ${i}`, makeStrategy());
    }

    await expect(
      executor.createAgent("Agent 6", makeStrategy())
    ).rejects.toThrow("Max agents");
  });

  it("should stop an agent", async () => {
    const strategy = new DCAStrategy({
      inputMint: "So11111",
      outputMint: "EPjFWdd5",
      amountPerInterval: 1_000_000n,
      totalIntervals: 5,
      maxSlippage: 1.0,
    });

    const agent = await executor.createAgent("Stoppable", strategy);
    executor.stopAgent(agent.id);

    expect(executor.getAgent(agent.id)?.state).toBe("stopped");
  });

  it("should remove an agent", async () => {
    const strategy = new DCAStrategy({
      inputMint: "So11111",
      outputMint: "EPjFWdd5",
      amountPerInterval: 1_000_000n,
      totalIntervals: 5,
      maxSlippage: 1.0,
    });

    const agent = await executor.createAgent("Removable", strategy);
    const removed = executor.removeAgent(agent.id);

    expect(removed).toBe(true);
    expect(executor.getAgent(agent.id)).toBeUndefined();
  });

  it("should list all agents", async () => {
    const makeStrategy = () =>
      new DCAStrategy({
        inputMint: "So11111",
        outputMint: "EPjFWdd5",
        amountPerInterval: 1_000_000n,
        totalIntervals: 1,
        maxSlippage: 1.0,
      });

    await executor.createAgent("Agent A", makeStrategy());
    await executor.createAgent("Agent B", makeStrategy());

    const all = executor.getAllAgents();
    expect(all.length).toBe(2);
    expect(all.map((a) => a.name)).toContain("Agent A");
    expect(all.map((a) => a.name)).toContain("Agent B");
  });

  it("should track metrics", async () => {
    const metrics = executor.getMetrics();
    expect(metrics.activeAgents).toBe(0);
    expect(metrics.totalExecutions).toBe(0);
    expect(metrics.totalPnL).toBe(0n);
  });
});
