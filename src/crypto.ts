import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Envelope encryption: each secret gets its own data key (DEK), and the DEK is
// wrapped with the master key. Rotating the master key only rewraps DEKs.

export interface Sealed {
  ciphertext: Buffer;
  wrappedDek: Buffer;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

function encrypt(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function decrypt(key: Buffer, sealed: Buffer, aad: string): Buffer {
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = sealed.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** `aad` binds the ciphertext to its owner (e.g. "user:provider") so rows cannot be swapped. */
export function seal(masterKey: Buffer, plaintext: string, aad: string): Sealed {
  const dek = randomBytes(32);
  return {
    ciphertext: encrypt(dek, Buffer.from(plaintext, "utf8"), aad),
    wrappedDek: encrypt(masterKey, dek, `dek:${aad}`),
  };
}

export function open(masterKey: Buffer, sealed: Sealed, aad: string): string {
  const dek = decrypt(masterKey, sealed.wrappedDek, `dek:${aad}`);
  return decrypt(dek, sealed.ciphertext, aad).toString("utf8");
}
