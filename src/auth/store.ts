/**
 * Legacy single-credential store — now an account-aware compatibility seam.
 *
 * The primary store is the multi-account fleet store (../accounts/store.ts,
 * `accounts.json`). These functions keep their old signatures so the many
 * call sites (serve boot, panel sync, auto-claim, quota routes, control
 * dispatcher) work unchanged while the account layer lands:
 *
 *  - {@link loadCredential} → the ACTIVE account's credential (first enabled
 *    account in store order).
 *  - {@link saveCredential} → add-or-refresh an account (a re-login of a
 *    known account updates it in place; a new login appends a new account).
 *  - {@link clearCredential} → remove the ACTIVE account; the next enabled
 *    account takes over. With one account stored this is byte-for-byte the
 *    old logout.
 *
 * Migration is one-way and best-effort: the first `loadCredential` on a
 * machine that still has only the legacy `credentials.json` copies that
 * credential into `accounts.json` as the account labeled `default` and LEAVES
 * the legacy file untouched (older binaries on the same machine keep working;
 * the file simply goes stale). All encryption lives in ./crypto.ts.
 *
 * @see .omo/plans/zcode-proxy.md Task 14 (original single-credential store)
 */
import { existsSync, unlinkSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Credential } from "./types.js";
import {
  getEncryptionKey,
  getLegacyEncryptionKey,
  encryptWith,
  decryptWith,
} from "./crypto.js";
import {
  loadAccounts,
  activeAccountOf,
  addAccount,
  removeActiveAccount,
  getAccountsStorePath,
} from "../accounts/store.js";

/** Store directory override. Production always uses `~/.zcode-proxy`; this seam
 * exists so tests can point the store at an isolated temp dir — module-level
 * path constants forced store.test.ts onto the REAL user store, and running
 * the suite on a logged-in machine deleted the user's credentials
 * (`clearCredential` in test hooks, observed 2026-09-18). Evaluated per call
 * so the env var works even when set after module load. Shared with
 * ../accounts/store.ts.
 */
const ENV_STORE_DIR = "ZCODE_PROXY_STORE_DIR";

function storeDir(): string {
  return process.env[ENV_STORE_DIR]?.trim() || join(homedir(), ".zcode-proxy");
}

function storeFile(): string {
  return join(storeDir(), "credentials.json");
}

/** Atomic store write: temp file (0o600) + rename over the target. */
function atomicWriteStore(contents: string): void {
  const target = storeFile();
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(storeDir(), { recursive: true });
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, target);
}

async function encrypt(plaintext: string): Promise<string> {
  return encryptWith(getEncryptionKey(), plaintext);
}

/**
 * Save a credential — add-or-refresh an account in the fleet store. Returns
 * nothing (legacy signature); the accounts CLI surfaces the added/refreshed
 * label by calling ../accounts/store.ts directly.
 */
export async function saveCredential(cred: Credential): Promise<void> {
  await addAccount(cred);
}

/**
 * Load the credential of the ACTIVE account (first enabled in store order).
 *
 * When only the legacy `credentials.json` exists, it is read once more here
 * (including the XOR-fold → SHA-256 one-shot re-decrypt) and migrated into
 * `accounts.json` as the `default` account — best-effort by design: a failed
 * migration write (read-only dir, AV lock on Windows, …) must not fail the
 * load; the credential is returned either way and the migration retries on
 * the next boot.
 */
export async function loadCredential(): Promise<Credential | null> {
  if (existsSync(getAccountsStorePath())) {
    const accounts = await loadAccounts();
    return activeAccountOf(accounts)?.credential ?? null;
  }
  if (!existsSync(storeFile())) return null;

  const cred = await loadLegacyCredential();
  if (cred) {
    try {
      await addAccount(cred, { label: "default" });
      console.log(`Migrated stored credential to the accounts store (${getAccountsStorePath()}) as "default"`);
    } catch (e) {
      console.warn(`Accounts-store migration failed (will retry next load): ${(e as Error).message}`);
    }
  }
  return cred;
}

/** The pre-fleet loader: legacy file, new KDF first, XOR-fold fallback. */
async function loadLegacyCredential(): Promise<Credential | null> {
  let raw: string;
  try {
    raw = readFileSync(storeFile(), "utf-8");
  } catch {
    return null; // vanished mid-boot (e.g. concurrent logout) — not an error
  }
  const parsed = JSON.parse(raw) as { encrypted?: string };
  if (!parsed.encrypted) return null;

  let json: string;
  try {
    json = await decryptWith(getEncryptionKey(), parsed.encrypted);
  } catch {
    // Not decryptable under the new SHA-256 KDF — try the legacy XOR-fold key
    // (one-shot migration), then transparently re-store under the new format.
    try {
      json = await decryptWith(getLegacyEncryptionKey(), parsed.encrypted);
    } catch (e) {
      // Stale/corrupt credential file — key derivation is machine-specific
      // ({homedir}-{platform}-{arch}), so cross-machine copies or OS reinstalls
      // produce undecryptable ciphertext. Silently treat as "not logged in".
      console.warn(`Ignoring corrupted or stale credentials at ${storeFile()}: ${(e as Error).message}`);
      return null;
    }
    // Re-store under the new KDF. Best-effort by design: the credential is
    // already decrypted in memory, so a failed re-write (read-only dir, AV
    // lock on Windows, ...) must NOT fail this load — it retries next boot.
    try {
      atomicWriteStore(JSON.stringify({ encrypted: await encrypt(json) }));
    } catch (e) {
      console.warn(`Credential re-encryption under the new key derivation failed (will retry on next load): ${(e as Error).message}`);
    }
  }

  try {
    return JSON.parse(json) as Credential;
  } catch (e) {
    console.warn(`Ignoring corrupted credentials at ${storeFile()}: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Log out of the ACTIVE account: removed from the fleet store, next enabled
 * account (if any) becomes active. Falls back to deleting the legacy file
 * when no accounts store exists yet (pre-migration machines).
 */
export function clearCredential(): void {
  if (existsSync(getAccountsStorePath())) {
    // Fire-and-forget is deterministic here: removeActiveAccount reads,
    // splices and WRITES the store synchronously before its first await, so
    // the on-disk removal is complete by the time this returns (the async
    // tail only decrypts the removed record for the result payload).
    void removeActiveAccount();
    return;
  }
  if (existsSync(storeFile())) {
    unlinkSync(storeFile());
  }
}

/** Path of the LEGACY single-credential file (kept for tests and messages). */
export function getStorePath(): string {
  return storeFile();
}
