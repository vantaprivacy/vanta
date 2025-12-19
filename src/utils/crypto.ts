import * as crypto from "crypto";

export function randomBytes(size: number): Uint8Array {
  return new Uint8Array(crypto.randomBytes(size));
}

export function deriveKey(masterKey: Uint8Array, salt: Uint8Array): Uint8Array {
  const derived = crypto.hkdfSync("sha256", masterKey, salt, Buffer.from("vanta-intent"), 32);
  return new Uint8Array(derived);
}

export function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(crypto.createHash("sha256").update(data).digest());
}

export function generateKeypair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey: new Uint8Array(publicKey.export({ type: "spki", format: "der" })),
    secretKey: new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" })),
  };
}
