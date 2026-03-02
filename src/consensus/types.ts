export type SlashableOffense =
  | "DOUBLE_SIGN"
  | "DOWNTIME"
  | "EQUIVOCATION"
  | "INVALID_STATE_TRANSITION";

export interface ValidatorInfo {
  address: string;
  stake: bigint;
  slashedAmount: bigint;
  isJailed: boolean;
  jailedUntil: number;
  infractions: Infraction[];
  missedBlocks: number;
}

export interface Infraction {
  type: SlashableOffense;
  epoch: number;
  evidence: string;
  slashPct: number;
  amount: bigint;
  timestamp: number;
}

export interface SlashingParams {
  doubleSignSlashPct: number;
  downtimeSlashPct: number;
  equivocationSlashPct: number;
  invalidTransitionSlashPct: number;
  downtimeWindow: number;
  downtimeThreshold: number;
  jailDuration: number;
  maxInfractionsBeforeTombstone: number;
  cooldownEpochs: number;
}
