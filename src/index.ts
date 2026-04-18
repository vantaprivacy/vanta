/**
 * VANTA Protocol — Private AI Agent Infrastructure
 * Entry point for the core library
 */

export { VantaClient } from "./sdk/client";
export { IntentEngine } from "./core/intent-engine";
export { PrivacyLayer } from "./core/privacy-layer";
export { MEVShield } from "./mev/shield";
export { SlashingEngine, SlashableOffense } from "./consensus/slashing";
export { FEATURES, requireFeature } from "./config/features";

export type { VantaConfig } from "./sdk/types";
export type { EncryptedIntent, IntentResult } from "./core/intent-engine";
export type { Proof, VerificationKey, ZKConfig } from "./zk/types";
export type { ValidatorInfo, Infraction } from "./consensus/types";

import { Logger } from "./utils/logger";

const logger = new Logger("vanta");

export function getVersion(): string {
  return "0.5.0-beta";
}

logger.info(`VANTA Protocol v${getVersion()} loaded`);
// v0.3.0 release tag
// v0.4.0
