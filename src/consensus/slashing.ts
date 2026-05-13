import { EventEmitter } from "events";
import type { ValidatorInfo, Infraction, SlashingParams, SlashableOffense } from "./types";
import { Logger } from "../utils/logger";

export { SlashableOffense } from "./types";

const logger = new Logger("slashing");

export const DEFAULT_PARAMS: SlashingParams = {
  doubleSignSlashPct: 500,
  downtimeSlashPct: 10,
  equivocationSlashPct: 1000,
  invalidTransitionSlashPct: 2000,
  downtimeWindow: 100,
  downtimeThreshold: 50,
  jailDuration: 3,
  maxInfractionsBeforeTombstone: 5,
  cooldownEpochs: 2,
};

export class SlashingEngine extends EventEmitter {
  private validators: Map<string, ValidatorInfo> = new Map();
  private params: SlashingParams;
  private currentEpoch: number = 0;
  private slashingHistory: Infraction[] = [];
  private tombstoned: Set<string> = new Set();

  constructor(params: Partial<SlashingParams> = {}) {
    super();
    this.params = { ...DEFAULT_PARAMS, ...params };
  }

  registerValidator(address: string, stake: bigint): void {
    if (this.tombstoned.has(address)) {
      throw new Error(`Validator ${address} is tombstoned`);
    }
    this.validators.set(address, {
      address, stake, slashedAmount: 0n, isJailed: false,
      jailedUntil: 0, infractions: [], missedBlocks: 0,
    });
    logger.info(`Registered validator ${address} with stake ${stake}`);
  }

  setEpoch(epoch: number): void {
    this.currentEpoch = epoch;
    for (const [addr, v] of this.validators) {
      if (v.isJailed && v.jailedUntil <= epoch) {
        v.isJailed = false;
        this.emit("unjailed", { address: addr, epoch });
      }
    }
  }

  recordMissedBlock(address: string): Infraction | null {
    const v = this.getValidator(address);
    v.missedBlocks++;
    if (v.missedBlocks >= this.params.downtimeThreshold) {
      v.missedBlocks = 0;
      return this.slash(address, "DOWNTIME", "auto:downtime_threshold");
    }
    return null;
  }

  slash(address: string, offense: SlashableOffense, evidence: string): Infraction {
    const v = this.getValidator(address);
    if (this.tombstoned.has(address)) throw new Error(`${address} already tombstoned`);

    const lastSameType = v.infractions
      .filter((i) => i.type === offense)
      .sort((a, b) => b.epoch - a.epoch)[0];

    if (lastSameType && this.currentEpoch - lastSameType.epoch < this.params.cooldownEpochs) {
      throw new Error(`Cooldown active: ${offense} for ${address}`);
    }

    const slashPct = this.getSlashPercent(offense);
    const slashAmount = (v.stake * BigInt(slashPct)) / 10000n;

    v.stake -= slashAmount;
    v.slashedAmount += slashAmount;
    if (v.stake < 0n) v.stake = 0n;

    v.isJailed = true;
    v.jailedUntil = this.currentEpoch + this.params.jailDuration;

    const infraction: Infraction = {
      type: offense, epoch: this.currentEpoch, evidence,
      slashPct, amount: slashAmount, timestamp: Date.now(),
    };

    v.infractions.push(infraction);
    this.slashingHistory.push(infraction);
    this.emit("slashed", { address, infraction, remainingStake: v.stake });

    logger.warn(`Slashed ${address}: ${offense} (${slashAmount} tokens, ${slashPct}bp)`);

    if (v.infractions.length >= this.params.maxInfractionsBeforeTombstone) {
      this.tombstone(address);
    }

    return infraction;
  }

  private tombstone(address: string): void {
    const v = this.getValidator(address);
    this.tombstoned.add(address);
    const remaining = v.stake;
    v.stake = 0n;
    v.slashedAmount += remaining;
    this.emit("tombstoned", { address, totalSlashed: v.slashedAmount });
    logger.error(`Tombstoned validator ${address}`);
  }

  getValidatorState(address: string): ValidatorInfo | undefined {
    return this.validators.get(address);
  }

  getActiveValidators(): ValidatorInfo[] {
    return [...this.validators.values()].filter(
      (v) => !v.isJailed && !this.tombstoned.has(v.address) && v.stake > 0n
    );
  }

  isTombstoned(address: string): boolean {
    return this.tombstoned.has(address);
  }

  private getValidator(address: string): ValidatorInfo {
    const v = this.validators.get(address);
    if (!v) throw new Error(`Unknown validator: ${address}`);
    return v;
  }

  private getSlashPercent(offense: SlashableOffense): number {
    const map: Record<SlashableOffense, number> = {
      DOUBLE_SIGN: this.params.doubleSignSlashPct,
      DOWNTIME: this.params.downtimeSlashPct,
      EQUIVOCATION: this.params.equivocationSlashPct,
      INVALID_STATE_TRANSITION: this.params.invalidTransitionSlashPct,
    };
    return map[offense] ?? 100;
  }
}
// fix: jail duration now correctly uses epoch + duration
// fix: cap slash at current stake
