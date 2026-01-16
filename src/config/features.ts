/**
 * Feature flags — experimental modules behind gates.
 * Enable via environment variables.
 */

export interface FeatureFlags {
  ZK_PROOFS: boolean;
  ZK_RECURSIVE_VERIFICATION: boolean;
  ZK_BATCH_PROVING: boolean;
  MAINNET: boolean;
  ENABLE_STAKING: boolean;
  INTENT_BATCHING: boolean;
}

export const FEATURES: FeatureFlags = {
  ZK_PROOFS: process.env.ENABLE_ZK === "true",
  ZK_RECURSIVE_VERIFICATION: false,
  ZK_BATCH_PROVING: false,
  MAINNET: process.env.ENABLE_MAINNET === "true",
  ENABLE_STAKING: process.env.ENABLE_STAKING === "true",
  INTENT_BATCHING: process.env.ENABLE_INTENT_BATCHING === "true",
};

export function requireFeature(flag: keyof FeatureFlags): void {
  if (!FEATURES[flag]) {
    throw new Error(
      `Feature "${flag}" is not enabled. ` +
      `Set the corresponding env var to opt in.`
    );
  }
}

export function featureStatus(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(FEATURES).map(([k, v]) => [k, v ? "enabled" : "disabled"])
  );
}
// requireFeature() added for flag-gated modules
