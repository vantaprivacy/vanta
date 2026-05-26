/**
 * VANTA Encryption Module
 *
 * Provides AES-256-GCM encryption/decryption for intent payloads,
 * key derivation via HKDF-SHA256, and envelope encryption for
 * relay-layer privacy.
 *
 * Architecture:
 *   Master Key -> HKDF -> Per-Intent Key -> AES-256-GCM(payload)
 *   Each intent gets a unique derived key via a random salt.
 *   The salt is transmitted alongside the ciphertext (not secret).
 */

import * as crypto from "crypto";
import { Logger } from "../utils/logger";

const logger = new Logger("encryption");

// --- Types ---

export interface EncryptionEnvelope {
  /** AES-256-GCM ciphertext */
  ciphertext: Buffer;
  /** 12-byte nonce / IV */
  nonce: Buffer;
  /** 16-byte GCM authentication tag */
  authTag: Buffer;
  /** 32-byte HKDF salt used to derive the per-intent key */
  salt: Buffer;
  /** Optional additional authenticated data context */
  aadContext?: string;
  /** Timestamp of encryption (unix ms) */
  encryptedAt: number;
  /** Key version for rotation support */
  keyVersion: number;
}

export interface KeyMaterial {
  masterKey: Buffer;
  version: number;
  createdAt: number;
  rotateAfterMs: number;
}

export interface EncryptionStats {
  totalEncryptions: number;
  totalDecryptions: number;
  failedDecryptions: number;
  bytesEncrypted: bigint;
  bytesDecrypted: bigint;
  averageEncryptionTimeUs: number;
  keyRotations: number;
}

export interface DerivedKeyInfo {
  key: Buffer;
  salt: Buffer;
  context: string;
  derivedAt: number;
}

// --- Constants ---

const AES_KEY_LENGTH = 32; // 256 bits
const GCM_NONCE_LENGTH = 12; // 96 bits (NIST recommended)
const GCM_TAG_LENGTH = 16; // 128 bits
const HKDF_SALT_LENGTH = 32;
const HKDF_INFO_PREFIX = "vanta-intent-v1";
const MAX_PLAINTEXT_SIZE = 64 * 1024; // 64 KB max per intent
const KEY_ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// --- Key Derivation ---

/**
 * Derive a per-intent encryption key from the master key using HKDF-SHA256.
 *
 * @param masterKey - 32-byte master key
 * @param salt - Random salt (unique per intent)
 * @param context - Additional context string for domain separation
 * @returns Derived 32-byte key
 */
export function deriveIntentKey(
  masterKey: Buffer,
  salt: Buffer,
  context: string = "encrypt"
): Buffer {
  if (masterKey.length !== AES_KEY_LENGTH) {
    throw new EncryptionError(
      `Master key must be ${AES_KEY_LENGTH} bytes, got ${masterKey.length}`
    );
  }

  const info = Buffer.from(`${HKDF_INFO_PREFIX}:${context}`);
  const derived = crypto.hkdfSync("sha256", masterKey, salt, info, AES_KEY_LENGTH);
  return Buffer.from(derived);
}

/**
 * Derive a key pair for asymmetric envelope encryption (future use).
 * Uses Ed25519 for key agreement, then derives a shared secret.
 */
export function deriveSharedSecret(
  privateKey: Buffer,
  publicKey: Buffer,
  salt: Buffer
): Buffer {
  // X25519 key agreement
  const sharedSecret = crypto.diffieHellman({
    privateKey: crypto.createPrivateKey({
      key: privateKey,
      format: "der",
      type: "pkcs8",
    }),
    publicKey: crypto.createPublicKey({
      key: publicKey,
      format: "der",
      type: "spki",
    }),
  });

  // Derive symmetric key from shared secret
  const info = Buffer.from(`${HKDF_INFO_PREFIX}:ecdh`);
  const derived = crypto.hkdfSync("sha256", sharedSecret, salt, info, AES_KEY_LENGTH);
  return Buffer.from(derived);
}

// --- Core Encryption Engine ---

export class EncryptionEngine {
  private keyMaterial: KeyMaterial;
  private previousKeys: KeyMaterial[] = [];
  private stats: EncryptionStats = {
    totalEncryptions: 0,
    totalDecryptions: 0,
    failedDecryptions: 0,
    bytesEncrypted: 0n,
    bytesDecrypted: 0n,
    averageEncryptionTimeUs: 0,
    keyRotations: 0,
  };
  private encryptionTimeSamples: number[] = [];

  constructor(masterKey: Buffer, keyVersion: number = 1) {
    if (masterKey.length !== AES_KEY_LENGTH) {
      throw new EncryptionError(
        `Master key must be ${AES_KEY_LENGTH} bytes`
      );
    }

    this.keyMaterial = {
      masterKey: Buffer.from(masterKey),
      version: keyVersion,
      createdAt: Date.now(),
      rotateAfterMs: KEY_ROTATION_INTERVAL_MS,
    };

    logger.info(`Encryption engine initialized (key v${keyVersion})`);
  }

  /**
   * Encrypt a plaintext payload using AES-256-GCM with a derived per-intent key.
   *
   * @param plaintext - Data to encrypt (max 64KB)
   * @param aad - Optional additional authenticated data (not encrypted, but authenticated)
   * @returns Encryption envelope containing ciphertext + metadata
   */
  encrypt(plaintext: Buffer, aad?: string): EncryptionEnvelope {
    if (plaintext.length === 0) {
      throw new EncryptionError("Cannot encrypt empty plaintext");
    }
    if (plaintext.length > MAX_PLAINTEXT_SIZE) {
      throw new EncryptionError(
        `Plaintext exceeds max size: ${plaintext.length} > ${MAX_PLAINTEXT_SIZE}`
      );
    }

    this.checkKeyRotation();
    const startTime = performance.now();

    // Generate random salt and nonce
    const salt = crypto.randomBytes(HKDF_SALT_LENGTH);
    const nonce = crypto.randomBytes(GCM_NONCE_LENGTH);

    // Derive per-intent key
    const intentKey = deriveIntentKey(this.keyMaterial.masterKey, salt);

    // AES-256-GCM encryption
    const cipher = crypto.createCipheriv("aes-256-gcm", intentKey, nonce);

    if (aad) {
      cipher.setAAD(Buffer.from(aad), { plaintextLength: plaintext.length });
    }

    const encrypted = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    // Update stats
    const elapsedUs = (performance.now() - startTime) * 1000;
    this.recordEncryptionTime(elapsedUs);
    this.stats.totalEncryptions++;
    this.stats.bytesEncrypted += BigInt(plaintext.length);

    // Zero out the derived key
    intentKey.fill(0);

    logger.debug(
      `Encrypted ${plaintext.length}B -> ${encrypted.length}B ` +
      `(${elapsedUs.toFixed(0)}us, key v${this.keyMaterial.version})`
    );

    return {
      ciphertext: encrypted,
      nonce,
      authTag,
      salt,
      aadContext: aad,
      encryptedAt: Date.now(),
      keyVersion: this.keyMaterial.version,
    };
  }

  /**
   * Decrypt an encryption envelope back to plaintext.
   *
   * @param envelope - Encryption envelope from encrypt()
   * @returns Decrypted plaintext buffer
   * @throws EncryptionError if authentication fails or key version mismatch
   */
  decrypt(envelope: EncryptionEnvelope): Buffer {
    const key = this.resolveKeyForVersion(envelope.keyVersion);
    if (!key) {
      this.stats.failedDecryptions++;
      throw new EncryptionError(
        `No key material for version ${envelope.keyVersion}`
      );
    }

    const startTime = performance.now();

    // Derive the same per-intent key
    const intentKey = deriveIntentKey(key.masterKey, envelope.salt);

    try {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        intentKey,
        envelope.nonce
      );

      decipher.setAuthTag(envelope.authTag);

      if (envelope.aadContext) {
        decipher.setAAD(Buffer.from(envelope.aadContext), {
          plaintextLength: envelope.ciphertext.length,
        });
      }

      const decrypted = Buffer.concat([
        decipher.update(envelope.ciphertext),
        decipher.final(),
      ]);

      const elapsedUs = (performance.now() - startTime) * 1000;
      this.stats.totalDecryptions++;
      this.stats.bytesDecrypted += BigInt(decrypted.length);

      logger.debug(
        `Decrypted ${envelope.ciphertext.length}B -> ${decrypted.length}B ` +
        `(${elapsedUs.toFixed(0)}us)`
      );

      return decrypted;
    } catch (error) {
      this.stats.failedDecryptions++;
      throw new EncryptionError(
        `Decryption failed: ${error instanceof Error ? error.message : "unknown"}`,
        "DECRYPTION_FAILED"
      );
    } finally {
      intentKey.fill(0);
    }
  }

  /**
   * Encrypt a JSON-serializable object.
   * Convenience wrapper that handles serialization.
   */
  encryptJSON<T>(data: T, aad?: string): EncryptionEnvelope {
    const json = JSON.stringify(data);
    return this.encrypt(Buffer.from(json, "utf-8"), aad);
  }

  /**
   * Decrypt an envelope and parse the result as JSON.
   */
  decryptJSON<T>(envelope: EncryptionEnvelope): T {
    const plaintext = this.decrypt(envelope);
    return JSON.parse(plaintext.toString("utf-8")) as T;
  }

  /**
   * Rotate the master key. Old keys are kept for decryption of
   * previously encrypted data.
   */
  rotateKey(newMasterKey: Buffer): void {
    if (newMasterKey.length !== AES_KEY_LENGTH) {
      throw new EncryptionError("New master key must be 32 bytes");
    }

    // Archive current key
    this.previousKeys.push({ ...this.keyMaterial });

    // Limit key history to prevent unbounded memory growth
    if (this.previousKeys.length > 10) {
      const removed = this.previousKeys.shift()!;
      removed.masterKey.fill(0);
    }

    const newVersion = this.keyMaterial.version + 1;
    this.keyMaterial = {
      masterKey: Buffer.from(newMasterKey),
      version: newVersion,
      createdAt: Date.now(),
      rotateAfterMs: KEY_ROTATION_INTERVAL_MS,
    };

    this.stats.keyRotations++;
    logger.info(`Key rotated to v${newVersion}`);
  }

  /**
   * Check if the current key should be rotated based on age.
   */
  shouldRotateKey(): boolean {
    const age = Date.now() - this.keyMaterial.createdAt;
    return age >= this.keyMaterial.rotateAfterMs;
  }

  /**
   * Get encryption statistics.
   */
  getStats(): Readonly<EncryptionStats> {
    return { ...this.stats };
  }

  /**
   * Get current key version.
   */
  getCurrentKeyVersion(): number {
    return this.keyMaterial.version;
  }

  /**
   * Securely destroy all key material.
   * Call this when shutting down.
   */
  destroy(): void {
    this.keyMaterial.masterKey.fill(0);
    for (const key of this.previousKeys) {
      key.masterKey.fill(0);
    }
    this.previousKeys = [];
    logger.info("Encryption engine destroyed — all keys zeroed");
  }

  // --- Private helpers ---

  private resolveKeyForVersion(version: number): KeyMaterial | null {
    if (this.keyMaterial.version === version) {
      return this.keyMaterial;
    }
    return this.previousKeys.find((k) => k.version === version) ?? null;
  }

  private checkKeyRotation(): void {
    if (this.shouldRotateKey()) {
      logger.warn(
        `Key v${this.keyMaterial.version} is past rotation interval ` +
        `(age: ${Math.round((Date.now() - this.keyMaterial.createdAt) / 3600000)}h)`
      );
    }
  }

  private recordEncryptionTime(us: number): void {
    this.encryptionTimeSamples.push(us);
    if (this.encryptionTimeSamples.length > 1000) {
      this.encryptionTimeSamples = this.encryptionTimeSamples.slice(-500);
    }
    const sum = this.encryptionTimeSamples.reduce((a, b) => a + b, 0);
    this.stats.averageEncryptionTimeUs = sum / this.encryptionTimeSamples.length;
  }
}

// --- Utilities ---

/**
 * Generate a cryptographically secure master key.
 */
export function generateMasterKey(): Buffer {
  return crypto.randomBytes(AES_KEY_LENGTH);
}

/**
 * Compute a fingerprint of a key (for logging, not security).
 * Returns first 8 hex chars of SHA-256.
 */
export function keyFingerprint(key: Buffer): string {
  const hash = crypto.createHash("sha256").update(key).digest();
  return hash.subarray(0, 4).toString("hex");
}

/**
 * Constant-time buffer comparison to prevent timing attacks.
 */
export function secureCompare(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Serialize an encryption envelope to a compact binary format
 * for network transmission.
 *
 * Format: [version:1][salt:32][nonce:12][tag:16][ciphertext:N]
 */
export function serializeEnvelope(envelope: EncryptionEnvelope): Buffer {
  const version = Buffer.alloc(1);
  version.writeUInt8(envelope.keyVersion);

  return Buffer.concat([
    version,
    envelope.salt,
    envelope.nonce,
    envelope.authTag,
    envelope.ciphertext,
  ]);
}

/**
 * Deserialize a binary envelope back to an EncryptionEnvelope.
 */
export function deserializeEnvelope(data: Buffer): EncryptionEnvelope {
  if (data.length < 1 + HKDF_SALT_LENGTH + GCM_NONCE_LENGTH + GCM_TAG_LENGTH) {
    throw new EncryptionError("Envelope data too short");
  }

  let offset = 0;

  const keyVersion = data.readUInt8(offset);
  offset += 1;

  const salt = data.subarray(offset, offset + HKDF_SALT_LENGTH);
  offset += HKDF_SALT_LENGTH;

  const nonce = data.subarray(offset, offset + GCM_NONCE_LENGTH);
  offset += GCM_NONCE_LENGTH;

  const authTag = data.subarray(offset, offset + GCM_TAG_LENGTH);
  offset += GCM_TAG_LENGTH;

  const ciphertext = data.subarray(offset);

  return {
    ciphertext: Buffer.from(ciphertext),
    nonce: Buffer.from(nonce),
    authTag: Buffer.from(authTag),
    salt: Buffer.from(salt),
    encryptedAt: 0,
    keyVersion,
  };
}

// --- Error class ---

export class EncryptionError extends Error {
  readonly code: string;

  constructor(message: string, code: string = "ENCRYPTION_ERROR") {
    super(message);
    this.name = "EncryptionError";
    this.code = code;
  }
}
