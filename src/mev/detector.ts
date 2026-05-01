import { Logger } from "../utils/logger";

export interface SandwichAttack {
  frontrunTx: string;
  victimTx: string;
  backrunTx: string;
  extractedValue: bigint;
  pool: string;
  timestamp: number;
}

const logger = new Logger("mev-detector");

export class MEVDetector {
  private detectedAttacks: SandwichAttack[] = [];
  private monitoredPools: Set<string> = new Set();

  addPool(pool: string): void {
    this.monitoredPools.add(pool);
  }

  /**
   * Analyze a sequence of transactions for sandwich patterns.
   * Pattern: buy → victim swap → sell within same slot
   */
  detectSandwich(
    transactions: Array<{ sig: string; slot: number; accounts: string[]; type: string }>
  ): SandwichAttack[] {
    const attacks: SandwichAttack[] = [];
    const bySlot = new Map<number, typeof transactions>();

    // Group by slot
    for (const tx of transactions) {
      const slot = tx.slot;
      if (!bySlot.has(slot)) bySlot.set(slot, []);
      bySlot.get(slot)!.push(tx);
    }

    // Check each slot for sandwich pattern
    for (const [slot, txs] of bySlot) {
      if (txs.length < 3) continue;

      for (let i = 0; i < txs.length - 2; i++) {
        const front = txs[i];
        const victim = txs[i + 1];
        const back = txs[i + 2];

        if (
          front.type === "swap" &&
          victim.type === "swap" &&
          back.type === "swap" &&
          this.sharePool(front, victim, back)
        ) {
          const attack: SandwichAttack = {
            frontrunTx: front.sig,
            victimTx: victim.sig,
            backrunTx: back.sig,
            extractedValue: 0n, // would compute from amounts
            pool: front.accounts[0],
            timestamp: Date.now(),
          };

          attacks.push(attack);
          this.detectedAttacks.push(attack);

          logger.warn(
            `Sandwich detected in slot ${slot}: ${front.sig} → ${victim.sig} → ${back.sig}`
          );
        }
      }
    }

    return attacks;
  }

  getDetectedAttacks(): SandwichAttack[] {
    return [...this.detectedAttacks];
  }

  getTotalExtractedValue(): bigint {
    return this.detectedAttacks.reduce((sum, a) => sum + a.extractedValue, 0n);
  }

  private sharePool(
    ...txs: Array<{ accounts: string[] }>
  ): boolean {
    const pools = txs.map((tx) => tx.accounts[0]);
    return pools.every((p) => p === pools[0]);
  }
}
// expanded: historical slot scanning
