import { IntentEngine, IntentParams, IntentResult } from "../core/intent-engine";
import { PrivacyLayer } from "../core/privacy-layer";
import { MEVShield, MEVAnalysis } from "../mev/shield";
import { mergeConfig, validateConfig } from "../config";
import { featureStatus } from "../config/features";
import { randomBytes } from "../utils/crypto";
import { Logger } from "../utils/logger";
import type { VantaConfig } from "./types";

const logger = new Logger("sdk");

export class VantaClient {
  private config: VantaConfig;
  private intentEngine: IntentEngine;
  private mevShield: MEVShield;
  private privacyLayer: PrivacyLayer;

  constructor(config: Partial<VantaConfig>) {
    this.config = mergeConfig(config);
    validateConfig(this.config);

    const masterKey = randomBytes(32);
    this.privacyLayer = new PrivacyLayer(masterKey, this.config.relayNodes);
    this.intentEngine = new IntentEngine(this.privacyLayer, this.config.intentTTL);
    this.mevShield = new MEVShield();

    logger.info("VantaClient initialized");
  }

  async submitIntent(params: IntentParams): Promise<IntentResult> {
    // Analyze MEV risk before submission
    if (this.config.mevShield && params.type === "swap") {
      const pair = `${params.inputMint?.slice(0, 4)}/${params.outputMint?.slice(0, 4)}`;
      const analysis = this.mevShield.analyzeMEVRisk(1, pair, BigInt(params.amount));

      if (analysis.sandwichRisk > 0.5) {
        logger.info(`High MEV risk (${(analysis.sandwichRisk * 100).toFixed(0)}%) — routing via Jito`);
      }
    }

    return this.intentEngine.submitIntent(params);
  }

  analyzeMEV(tokenPair: string, amount: bigint): MEVAnalysis {
    return this.mevShield.analyzeMEVRisk(1, tokenPair, amount);
  }

  getFeatureStatus(): Record<string, string> {
    return featureStatus();
  }

  getConfig(): Readonly<VantaConfig> {
    return Object.freeze({ ...this.config });
  }
}
