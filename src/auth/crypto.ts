/**
 * Shared credential-encryption primitives.
 *
 * Extracted verbatim from store.ts when the multi-account store
 * (../accounts/store.ts) needed the same AES-GCM envelope: one derivation,
 * one key format, so a credential stays decryptable no matter which store
 * wrote it. See store.ts for the KDF history (SHA-256 now, XOR-fold legacy
 * for one-shot migration decrypt only).
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";

const ENV_SECRET = "ZCODE_PROXY_CREDENTIAL_SECRET";

/**
 * Derive the AES-GCM key as SHA-256(seed) (audit R2-13). The previous XOR-fold
 * construction was a pseudo-KDF: a seed shorter than 32 bytes left zero blocks
 * in the key. Scope note: on default machine-derived seeds the security gain
 * is ~0 (any same-user process can re-derive the seed either way, 0o600 only
 * stops other users) — the motivation is structural: env-secret deployments
 * (`ZCODE_PROXY_CREDENTIAL_SECRET`) get real 32-byte diffusion, and the
 * misleading "KDF" is gone.
 */
export function getEncryptionKey(): Uint8Array {
  const seed = process.env[ENV_SECRET] ?? `${homedir()}-${process.platform}-${process.arch}`;
  return new Uint8Array(createHash("sha256").update(seed, "utf-8").digest());
}

/**
 * Legacy XOR-fold key (pre-SHA-256 store format). Kept ONLY for one-shot
 * migration decrypts — never used for new writes.
 */
export function getLegacyEncryptionKey(): Uint8Array {
  const hash = new Uint8Array(new ArrayBuffer(32));
  const encoder = new TextEncoder();

  const seed = process.env[ENV_SECRET] ?? `${homedir()}-${process.platform}-${process.arch}`;
  const seedBytes = encoder.encode(seed);
  for (let i = 0; i < seedBytes.length; i++) {
    hash[i % 32] ^= seedBytes[i];
  }
  return hash;
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  // Copy into a plain ArrayBuffer: bun-types types Uint8Array as
  // ArrayBufferLike, which is not assignable to BufferSource.
  const ab = new ArrayBuffer(raw.byteLength);
  new Uint8Array(ab).set(raw);
  return crypto.subtle.importKey(
    "raw",
    ab,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/** AES-GCM encrypt → base64(iv ‖ ciphertext). */
export async function encryptWith(key: Uint8Array, plaintext: string): Promise<string> {
  const aesKey = await importAesKey(key);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    encoder.encode(plaintext),
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return Buffer.from(combined).toString("base64");
}

/** base64(iv ‖ ciphertext) → AES-GCM decrypt. Throws on wrong key / corrupt data. */
export async function decryptWith(key: Uint8Array, ciphertext: string): Promise<string> {
  const aesKey = await importAesKey(key);
  const combined = Buffer.from(ciphertext, "base64");
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    data,
  );

  return new TextDecoder().decode(decrypted);
}
