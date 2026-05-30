import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  EncryptionEngine,
  generateMasterKey,
  keyFingerprint,
  secureCompare,
  serializeEnvelope,
  deserializeEnvelope,
  deriveIntentKey,
  EncryptionError,
} from "../src/core/encryption";

describe("EncryptionEngine", () => {
  let engine: EncryptionEngine;
  let masterKey: Buffer;

  beforeEach(() => {
    masterKey = generateMasterKey();
    engine = new EncryptionEngine(masterKey);
  });

  afterEach(() => {
    engine.destroy();
  });

  describe("encrypt / decrypt", () => {
    it("should encrypt and decrypt a message roundtrip", () => {
      const plaintext = Buffer.from("Hello, Vanta Protocol!");
      const envelope = engine.encrypt(plaintext);
      const decrypted = engine.decrypt(envelope);

      expect(decrypted.toString()).toBe("Hello, Vanta Protocol!");
    });

    it("should encrypt and decrypt binary data", () => {
      const plaintext = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) plaintext[i] = i;

      const envelope = engine.encrypt(plaintext);
      const decrypted = engine.decrypt(envelope);

      expect(Buffer.compare(decrypted, plaintext)).toBe(0);
    });

    it("should produce different ciphertexts for the same plaintext", () => {
      const plaintext = Buffer.from("same message");
      const env1 = engine.encrypt(plaintext);
      const env2 = engine.encrypt(plaintext);

      expect(Buffer.compare(env1.ciphertext, env2.ciphertext)).not.toBe(0);
      expect(Buffer.compare(env1.nonce, env2.nonce)).not.toBe(0);
      expect(Buffer.compare(env1.salt, env2.salt)).not.toBe(0);
    });

    it("should reject empty plaintext", () => {
      expect(() => engine.encrypt(Buffer.alloc(0))).toThrow(EncryptionError);
    });

    it("should reject plaintext exceeding max size", () => {
      const oversized = Buffer.alloc(65 * 1024); // 65 KB > 64 KB limit
      expect(() => engine.encrypt(oversized)).toThrow("exceeds max size");
    });

    it("should fail decryption with wrong key", () => {
      const plaintext = Buffer.from("secret data");
      const envelope = engine.encrypt(plaintext);

      const otherKey = generateMasterKey();
      const otherEngine = new EncryptionEngine(otherKey);

      // Manually set the envelope to claim the same key version
      envelope.keyVersion = otherEngine.getCurrentKeyVersion();

      expect(() => otherEngine.decrypt(envelope)).toThrow(EncryptionError);
      otherEngine.destroy();
    });

    it("should handle AAD (additional authenticated data)", () => {
      const plaintext = Buffer.from("intent payload");
      const aad = "intent_id:vnt_abc123";

      const envelope = engine.encrypt(plaintext, aad);
      const decrypted = engine.decrypt(envelope);

      expect(decrypted.toString()).toBe("intent payload");
      expect(envelope.aadContext).toBe(aad);
    });
  });

  describe("encryptJSON / decryptJSON", () => {
    it("should handle JSON objects", () => {
      const data = {
        type: "swap",
        inputMint: "So111111",
        outputMint: "EPjFWdd5",
        amount: 1000000000,
      };

      const envelope = engine.encryptJSON(data);
      const decrypted = engine.decryptJSON<typeof data>(envelope);

      expect(decrypted.type).toBe("swap");
      expect(decrypted.amount).toBe(1000000000);
    });

    it("should handle nested objects", () => {
      const data = {
        intent: { id: "vnt_123", params: { slippage: 0.5 } },
        metadata: { privacy: 85 },
      };

      const envelope = engine.encryptJSON(data);
      const decrypted = engine.decryptJSON<typeof data>(envelope);

      expect(decrypted.intent.id).toBe("vnt_123");
      expect(decrypted.intent.params.slippage).toBe(0.5);
    });
  });

  describe("key rotation", () => {
    it("should rotate keys and increment version", () => {
      expect(engine.getCurrentKeyVersion()).toBe(1);

      const newKey = generateMasterKey();
      engine.rotateKey(newKey);

      expect(engine.getCurrentKeyVersion()).toBe(2);
    });

    it("should decrypt data from previous key version after rotation", () => {
      const plaintext = Buffer.from("encrypted with v1");
      const envelope = engine.encrypt(plaintext);
      expect(envelope.keyVersion).toBe(1);

      // Rotate key
      engine.rotateKey(generateMasterKey());
      expect(engine.getCurrentKeyVersion()).toBe(2);

      // Should still decrypt with v1 key
      const decrypted = engine.decrypt(envelope);
      expect(decrypted.toString()).toBe("encrypted with v1");
    });

    it("should encrypt with new key after rotation", () => {
      engine.rotateKey(generateMasterKey());
      const plaintext = Buffer.from("encrypted with v2");
      const envelope = engine.encrypt(plaintext);

      expect(envelope.keyVersion).toBe(2);
      const decrypted = engine.decrypt(envelope);
      expect(decrypted.toString()).toBe("encrypted with v2");
    });

    it("should reject invalid key size on rotation", () => {
      expect(() => engine.rotateKey(Buffer.alloc(16))).toThrow(
        "must be 32 bytes"
      );
    });
  });

  describe("statistics", () => {
    it("should track encryption count", () => {
      engine.encrypt(Buffer.from("a"));
      engine.encrypt(Buffer.from("b"));
      engine.encrypt(Buffer.from("c"));

      const stats = engine.getStats();
      expect(stats.totalEncryptions).toBe(3);
    });

    it("should track decryption count", () => {
      const env = engine.encrypt(Buffer.from("data"));
      engine.decrypt(env);
      engine.decrypt(env);

      const stats = engine.getStats();
      expect(stats.totalDecryptions).toBe(2);
    });

    it("should track bytes encrypted", () => {
      engine.encrypt(Buffer.from("hello")); // 5 bytes
      engine.encrypt(Buffer.alloc(100)); // 100 bytes

      const stats = engine.getStats();
      expect(stats.bytesEncrypted).toBe(105n);
    });

    it("should track key rotations", () => {
      engine.rotateKey(generateMasterKey());
      engine.rotateKey(generateMasterKey());

      const stats = engine.getStats();
      expect(stats.keyRotations).toBe(2);
    });
  });
});

describe("deriveIntentKey", () => {
  it("should derive a 32-byte key", () => {
    const masterKey = generateMasterKey();
    const salt = Buffer.alloc(32);
    const derived = deriveIntentKey(masterKey, salt);

    expect(derived.length).toBe(32);
  });

  it("should produce different keys for different salts", () => {
    const masterKey = generateMasterKey();
    const salt1 = Buffer.alloc(32, 0x01);
    const salt2 = Buffer.alloc(32, 0x02);

    const key1 = deriveIntentKey(masterKey, salt1);
    const key2 = deriveIntentKey(masterKey, salt2);

    expect(Buffer.compare(key1, key2)).not.toBe(0);
  });

  it("should be deterministic for same inputs", () => {
    const masterKey = generateMasterKey();
    const salt = Buffer.alloc(32, 0xaa);

    const key1 = deriveIntentKey(masterKey, salt);
    const key2 = deriveIntentKey(masterKey, salt);

    expect(Buffer.compare(key1, key2)).toBe(0);
  });

  it("should reject invalid master key length", () => {
    expect(() => deriveIntentKey(Buffer.alloc(16), Buffer.alloc(32))).toThrow(
      EncryptionError
    );
  });
});

describe("serializeEnvelope / deserializeEnvelope", () => {
  it("should roundtrip serialize an envelope", () => {
    const engine = new EncryptionEngine(generateMasterKey());
    const envelope = engine.encrypt(Buffer.from("test data"));

    const serialized = serializeEnvelope(envelope);
    const deserialized = deserializeEnvelope(serialized);

    expect(Buffer.compare(deserialized.ciphertext, envelope.ciphertext)).toBe(0);
    expect(Buffer.compare(deserialized.nonce, envelope.nonce)).toBe(0);
    expect(Buffer.compare(deserialized.authTag, envelope.authTag)).toBe(0);
    expect(Buffer.compare(deserialized.salt, envelope.salt)).toBe(0);
    expect(deserialized.keyVersion).toBe(envelope.keyVersion);

    engine.destroy();
  });

  it("should reject too-short data", () => {
    expect(() => deserializeEnvelope(Buffer.alloc(10))).toThrow(
      "too short"
    );
  });
});

describe("utility functions", () => {
  it("keyFingerprint should return 8-char hex", () => {
    const key = generateMasterKey();
    const fp = keyFingerprint(key);

    expect(fp.length).toBe(8);
    expect(/^[0-9a-f]+$/.test(fp)).toBe(true);
  });

  it("secureCompare should return true for equal buffers", () => {
    const a = Buffer.from("hello");
    const b = Buffer.from("hello");
    expect(secureCompare(a, b)).toBe(true);
  });

  it("secureCompare should return false for different buffers", () => {
    const a = Buffer.from("hello");
    const b = Buffer.from("world");
    expect(secureCompare(a, b)).toBe(false);
  });

  it("secureCompare should return false for different lengths", () => {
    const a = Buffer.from("hello");
    const b = Buffer.from("hi");
    expect(secureCompare(a, b)).toBe(false);
  });
});
