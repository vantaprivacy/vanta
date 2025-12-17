import type { VantaConfig } from "../sdk/types";

export const DEFAULT_CONFIG: VantaConfig = {
  rpcUrl: "https://api.mainnet-beta.solana.com",
  privacyLevel: "encrypted",
  mevShield: true,
  relayNodes: [
    "https://relay-1.usevanta.xyz",
    "https://relay-2.usevanta.xyz",
    "https://relay-3.usevanta.xyz",
  ],
  zkBackend: "groth16",
  maxRetries: 3,
  timeoutMs: 30_000,
  intentTTL: 60,
};

export function mergeConfig(partial: Partial<VantaConfig>): VantaConfig {
  return { ...DEFAULT_CONFIG, ...partial };
}

export function validateConfig(config: VantaConfig): void {
  if (!config.rpcUrl) throw new Error("rpcUrl is required");
  if (!["encrypted", "shielded", "public"].includes(config.privacyLevel)) {
    throw new Error(`Invalid privacy level: ${config.privacyLevel}`);
  }
  if (config.timeoutMs < 1000) {
    throw new Error("Timeout must be >= 1000ms");
  }
}
