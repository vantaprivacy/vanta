import type { ValidatorInfo } from "./types";
import { Logger } from "../utils/logger";

const logger = new Logger("validator");

export interface ValidatorConfig {
  minStake: bigint;
  maxValidators: number;
  epochDuration: number; // seconds
}

export const DEFAULT_VALIDATOR_CONFIG: ValidatorConfig = {
  minStake: 10_000n,
  maxValidators: 100,
  epochDuration: 432, // ~7.2 min like Solana epoch subdivision
};

export class ValidatorRegistry {
  private validators: Map<string, ValidatorInfo> = new Map();
  private config: ValidatorConfig;

  constructor(config?: Partial<ValidatorConfig>) {
    this.config = { ...DEFAULT_VALIDATOR_CONFIG, ...config };
  }

  register(address: string, stake: bigint): void {
    if (stake < this.config.minStake) {
      throw new Error(
        `Stake ${stake} below minimum ${this.config.minStake}`
      );
    }
    if (this.validators.size >= this.config.maxValidators) {
      throw new Error("Max validator count reached");
    }

    this.validators.set(address, {
      address,
      stake,
      slashedAmount: 0n,
      isJailed: false,
      jailedUntil: 0,
      infractions: [],
      missedBlocks: 0,
    });

    logger.info(`Validator ${address} registered (stake: ${stake})`);
  }

  deregister(address: string): bigint {
    const v = this.validators.get(address);
    if (!v) throw new Error(`Validator ${address} not found`);
    if (v.isJailed) throw new Error(`Cannot deregister jailed validator`);

    this.validators.delete(address);
    logger.info(`Validator ${address} deregistered (returned: ${v.stake})`);
    return v.stake;
  }

  getAll(): ValidatorInfo[] {
    return [...this.validators.values()];
  }

  getActive(): ValidatorInfo[] {
    return this.getAll().filter((v) => !v.isJailed && v.stake > 0n);
  }

  getTotalStake(): bigint {
    return this.getActive().reduce((sum, v) => sum + v.stake, 0n);
  }

  selectLeader(epoch: number): ValidatorInfo | null {
    const active = this.getActive();
    if (active.length === 0) return null;

    // Weighted random by stake — deterministic for given epoch
    const totalStake = this.getTotalStake();
    const seed = BigInt(epoch) * 7919n;
    const target = seed % totalStake;

    let cumulative = 0n;
    for (const v of active) {
      cumulative += v.stake;
      if (cumulative > target) return v;
    }

    return active[active.length - 1];
  }
}
