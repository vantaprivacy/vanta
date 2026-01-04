import { Logger } from "../utils/logger";
import { randomBytes, deriveKey } from "../utils/crypto";
import type { EncryptedIntent } from "./intent-engine";

interface EncryptionResult {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

interface RelayResult {
  success: boolean;
  txSignature?: string;
  executionTimeMs: number;
  relayNode: string;
}

const logger = new Logger("privacy-layer");

export class PrivacyLayer {
  private masterKey: Uint8Array;
  private relayNodes: string[];
  private currentRelay: number = 0;

  constructor(masterKey: Uint8Array, relayNodes: string[]) {
    if (masterKey.length !== 32) {
      throw new Error("Master key must be 32 bytes (AES-256)");
    }
    if (relayNodes.length === 0) {
      throw new Error("At least one relay node required");
    }
    this.masterKey = masterKey;
    this.relayNodes = relayNodes;
  }

  async encrypt(plaintext: Uint8Array): Promise<EncryptionResult> {
    const nonce = randomBytes(12); // 96-bit nonce for AES-GCM
    const intentKey = deriveKey(this.masterKey, nonce);

    // AES-256-GCM encryption
    // In production this uses WebCrypto API or tweetnacl
    const ciphertext = this.aesGcmEncrypt(plaintext, intentKey, nonce);

    logger.debug(`Encrypted ${plaintext.length} bytes → ${ciphertext.length} bytes`);
    return { ciphertext, nonce };
  }

  async decrypt(ciphertext: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
    const intentKey = deriveKey(this.masterKey, nonce);
    return this.aesGcmDecrypt(ciphertext, intentKey, nonce);
  }

  async routeToRelay(intent: EncryptedIntent): Promise<RelayResult> {
    const relay = this.selectRelay();
    const startTime = Date.now();

    try {
      logger.info(`Routing intent ${intent.id} → ${relay}`);

      // In production: HTTP POST to relay node with encrypted payload
      // Relay decrypts only the routing header, not the strategy
      const response = await this.sendToRelay(relay, intent);

      return {
        success: true,
        txSignature: response.signature,
        executionTimeMs: Date.now() - startTime,
        relayNode: relay,
      };
    } catch (error) {
      logger.error(`Relay ${relay} failed: ${error}`);
      // Try next relay
      return this.fallbackRelay(intent, startTime);
    }
  }

  private selectRelay(): string {
    const relay = this.relayNodes[this.currentRelay % this.relayNodes.length];
    this.currentRelay++;
    return relay;
  }

  private async fallbackRelay(
    intent: EncryptedIntent,
    startTime: number
  ): Promise<RelayResult> {
    for (let i = 0; i < this.relayNodes.length; i++) {
      const relay = this.selectRelay();
      try {
        const response = await this.sendToRelay(relay, intent);
        return {
          success: true,
          txSignature: response.signature,
          executionTimeMs: Date.now() - startTime,
          relayNode: relay,
        };
      } catch {
        continue;
      }
    }
    return {
      success: false,
      executionTimeMs: Date.now() - startTime,
      relayNode: "none",
    };
  }

  private async sendToRelay(
    _relayUrl: string,
    _intent: EncryptedIntent
  ): Promise<{ signature: string }> {
    // Stub — real implementation uses fetch() to relay API
    throw new Error("Relay communication not available in offline mode");
  }

  private aesGcmEncrypt(
    plaintext: Uint8Array,
    key: Uint8Array,
    nonce: Uint8Array
  ): Uint8Array {
    // Stub — production uses crypto.subtle.encrypt or tweetnacl-sealedbox
    const output = new Uint8Array(plaintext.length + 16); // +16 for GCM tag
    output.set(plaintext);
    output.set(nonce.slice(0, 16), plaintext.length);
    return output;
  }

  private aesGcmDecrypt(
    ciphertext: Uint8Array,
    _key: Uint8Array,
    _nonce: Uint8Array
  ): Uint8Array {
    return ciphertext.slice(0, ciphertext.length - 16);
  }
}
