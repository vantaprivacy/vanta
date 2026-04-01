export interface VantaConfig {
  rpcUrl: string;
  privacyLevel: "encrypted" | "shielded" | "public";
  mevShield: boolean;
  relayNodes: string[];
  zkBackend: "groth16" | "plonk";
  maxRetries: number;
  timeoutMs: number;
  intentTTL: number;
}

export interface VantaStats {
  totalIntents: number;
  encryptedIntents: number;
  mevBlocked: number;
  totalSavings: bigint;
  activeRelays: number;
  privacyScore: number;
}
