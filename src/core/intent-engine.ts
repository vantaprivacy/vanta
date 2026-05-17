import { PrivacyLayer } from "./privacy-layer";
import { Logger } from "../utils/logger";
import { randomBytes } from "../utils/crypto";

export interface EncryptedIntent {
  id: string;
  encryptedPayload: Uint8Array;
  nonce: Uint8Array;
  timestamp: number;
  ttl: number;
  privacyScore: number;
}

export interface IntentParams {
  type: "swap" | "transfer" | "stake" | "lp_deposit" | "lp_withdraw";
  inputMint?: string;
  outputMint?: string;
  amount: number;
  slippage?: number;
  recipient?: string;
}

export interface IntentResult {
  intentId: string;
  status: "submitted" | "relayed" | "executed" | "failed";
  privacyScore: number;
  txSignature?: string;
  executionTimeMs?: number;
}

const logger = new Logger("intent-engine");

export class IntentEngine {
  private privacyLayer: PrivacyLayer;
  private pendingIntents: Map<string, EncryptedIntent> = new Map();
  private intentTTL: number;

  constructor(privacyLayer: PrivacyLayer, intentTTL = 60) {
    this.privacyLayer = privacyLayer;
    this.intentTTL = intentTTL;
  }

  async createIntent(params: IntentParams): Promise<EncryptedIntent> {
    this.validateParams(params);

    const intentId = this.generateIntentId();
    const payload = JSON.stringify({
      ...params,
      id: intentId,
      timestamp: Date.now(),
    });

    const { ciphertext, nonce } = await this.privacyLayer.encrypt(
      new TextEncoder().encode(payload)
    );

    const intent: EncryptedIntent = {
      id: intentId,
      encryptedPayload: ciphertext,
      nonce,
      timestamp: Date.now(),
      ttl: this.intentTTL,
      privacyScore: this.calculatePrivacyScore(params),
    };

    this.pendingIntents.set(intentId, intent);
    logger.info(`Intent created: ${intentId} (privacy: ${intent.privacyScore}/100)`);

    return intent;
  }

  async submitIntent(params: IntentParams): Promise<IntentResult> {
    const intent = await this.createIntent(params);

    // Route through privacy layer to relay network
    const relayResult = await this.privacyLayer.routeToRelay(intent);

    return {
      intentId: intent.id,
      status: relayResult.success ? "relayed" : "failed",
      privacyScore: intent.privacyScore,
      txSignature: relayResult.txSignature,
      executionTimeMs: relayResult.executionTimeMs,
    };
  }

  getIntent(id: string): EncryptedIntent | undefined {
    return this.pendingIntents.get(id);
  }

  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [id, intent] of this.pendingIntents) {
      if (now - intent.timestamp > intent.ttl * 1000) {
        this.pendingIntents.delete(id);
        pruned++;
      }
    }
    if (pruned > 0) logger.info(`Pruned ${pruned} expired intents`);
    return pruned;
  }

  private validateParams(params: IntentParams): void {
    if (!params.type) throw new Error("Intent type is required");
    if (params.amount <= 0) throw new Error("Amount must be positive");
    if (params.type === "swap" && (!params.inputMint || !params.outputMint)) {
      throw new Error("Swap intents require inputMint and outputMint");
    }
    if (params.type === "transfer" && !params.recipient) {
      throw new Error("Transfer intents require recipient");
    }
  }

  private calculatePrivacyScore(params: IntentParams): number {
    let score = 70; // base for encrypted intent
    if (params.type === "swap") score += 10; // swaps benefit most
    if (params.amount > 100_000_000_000) score -= 15; // large amounts harder to hide
    if (params.slippage && params.slippage > 1) score -= 5;
    return Math.min(100, Math.max(0, score));
  }

  private generateIntentId(): string {
    return `vnt_${Buffer.from(randomBytes(16)).toString("hex")}`;
  }
}
// privacy score calculation
// added: vnt_ prefix
