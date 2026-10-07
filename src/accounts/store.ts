/**
 * Multi-account encrypted credential store (fleet foundation).
 *
 * `~/.zcode-proxy/accounts.json` holds an ORDERED list of accounts — array
 * order is the serving priority (first enabled account = active). Each
 * account's credential is AES-GCM encrypted individually under the same
 * SHA-256 KDF as the legacy single-credential store (../auth/crypto.ts), so
 * per-account encryption composes with the existing secret machinery and a
 * future per-account export/import only needs to move one `encrypted` blob.
 *
 * Semantics kept deliberately close to ../auth/store.ts so the two stores
 * behave the same under `ZCODE_PROXY_STORE_DIR` (test isolation — see the
 * incident note there) and `ZCODE_PROXY_CREDENTIAL_SECRET` (pinned secret for
 * Docker / cross-machine moves):
 *  - corrupt/undecryptable data warns and is skipped, never throws;
 *  - writes are atomic (temp file + rename), 0o600;
 *  - the legacy `credentials.json` is NEVER written or deleted here — the
 *    one-way migration into this store lives in ../auth/store.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Credential } from "../auth/types.js";
import { getEncryptionKey, encryptWith, decryptWith } from "../auth/crypto.js";

/** Same test-isolation seam as the legacy store (see ../auth/store.ts). */
const ENV_STORE_DIR = "ZCODE_PROXY_STORE_DIR";

/** On-disk shape: one row per account, credential encrypted per row. */
interface AccountRecord {
  id: string;
  label: string;
  provider: string;
  enabled: boolean;
  /** Unix epoch ms. */
  addedAt: number;
  /** AES-GCM envelope of the serialized Credential (base64 iv ‖ ct). */
  encrypted: string;
}

/** Decrypted in-memory view of one account. */
export interface Account {
  id: string;
  label: string;
  provider: string;
  enabled: boolean;
  addedAt: number;
  credential: Credential;
}

function storeDir(): string {
  return process.env[ENV_STORE_DIR]?.trim() || join(homedir(), ".zcode-proxy");
}

/** Path of the multi-account store file. */
export function getAccountsStorePath(): string {
  return join(storeDir(), "accounts.json");
}

/** Atomic multi-account store write: temp file (0o600) + rename over the target. */
function atomicWriteStore(contents: string): void {
  const target = getAccountsStorePath();
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, target);
}

interface AccountsFile {
  version: number;
  accounts: AccountRecord[];
}

function parseAccountsFile(raw: string): AccountRecord[] {
  const parsed = JSON.parse(raw) as Partial<AccountsFile>;
  if (!Array.isArray(parsed.accounts)) return [];
  // Keep only rows with a usable shape — a hand-edited or partially corrupt
  // file must not take the whole fleet down. Dropped rows are NOT rewritten
  // back until the next successful save (see loadAccounts for the trade-off).
  return parsed.accounts.filter(
    (r): r is AccountRecord =>
      r !== null
      && typeof r === "object"
      && typeof r.id === "string"
      && typeof r.label === "string"
      && typeof r.encrypted === "string",
  );
}

/** Read the raw records; a missing/corrupt file reads as empty (with a warning). */
function readRecords(): AccountRecord[] {
  const path = getAccountsStorePath();
  if (!existsSync(path)) return [];
  try {
    return parseAccountsFile(readFileSync(path, "utf-8"));
  } catch (e) {
    console.warn(`Ignoring corrupted accounts store at ${path}: ${(e as Error).message}`);
    return [];
  }
}

function writeRecords(records: AccountRecord[]): void {
  mkdirSync(dirname(getAccountsStorePath()), { recursive: true });
  atomicWriteStore(JSON.stringify({ version: 1, accounts: records }, null, 2));
}

async function decryptRecord(rec: AccountRecord): Promise<Account | null> {
  const key = getEncryptionKey();
  try {
    const json = await decryptWith(key, rec.encrypted);
    const credential = JSON.parse(json) as Credential;
    if (typeof credential?.apiKey !== "string" || credential.apiKey.length === 0) return null;
    return { ...rec, credential };
  } catch {
    // Undecryptable under the current derivation: stale cross-machine blob or
    // corrupt row. Skip it loudly — a silently missing account reads as
    // "logged out" and is much more confusing than one warning line.
    console.warn(`Skipping account "${rec.label}" (undecryptable credential) in ${getAccountsStorePath()}`);
    return null;
  }
}

/**
 * All usable accounts, in store order (= serving priority). Never throws;
 * unusable rows are skipped with a warning.
 */
export async function loadAccounts(): Promise<Account[]> {
  const records = readRecords();
  const accounts: Account[] = [];
  for (const rec of records) {
    const account = await decryptRecord(rec);
    if (account) accounts.push(account);
  }
  return accounts;
}

/** The account that serves requests: first enabled account in store order. */
export function activeAccountOf(accounts: Account[]): Account | null {
  return accounts.find((a) => a.enabled) ?? null;
}

/**
 * Same real-world account? A re-login must refresh the existing entry, not
 * append a duplicate: match on the upstream user id when both sides carry
 * one (the stable identity across key rotations), else on the API key.
 */
function sameAccount(a: Credential, b: Credential): boolean {
  if (a.userId && b.userId) return a.userId === b.userId;
  return a.apiKey === b.apiKey;
}

/** `zai`, `zai-2`, `zai-3`… — first free label for the given base. */
function uniqueLabel(existing: AccountRecord[], base: string): string {
  const taken = new Set(existing.map((r) => r.label.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export interface AddAccountResult {
  account: Account;
  /** True when an existing entry was refreshed in place (re-login), false when appended. */
  updatedExisting: boolean;
  /** Store size after the operation (for CLI reporting). */
  total: number;
}

/**
 * Add an account, or refresh the matching entry when the credential belongs
 * to an account already stored (label, id, position and enabled flag are
 * kept on refresh — only the credential and provider move). Appended
 * accounts go LAST: store order is priority, and a new account must not
 * silently steal "active" from the ones before it.
 */
export async function addAccount(
  cred: Credential,
  opts: { label?: string } = {},
): Promise<AddAccountResult> {
  const records = readRecords();
  const encrypted = await encryptWith(getEncryptionKey(), JSON.stringify(cred));

  // Match against decrypted credentials: encryption is non-deterministic
  // (random IV), so equality must be checked on plaintext.
  let matchIndex = -1;
  for (let i = 0; i < records.length; i++) {
    const decrypted = await decryptRecord(records[i]!);
    if (decrypted && sameAccount(cred, decrypted.credential)) {
      matchIndex = i;
      break;
    }
  }

  if (matchIndex >= 0) {
    const prev = records[matchIndex]!;
    records[matchIndex] = { ...prev, encrypted, provider: cred.provider };
    writeRecords(records);
    return {
      account: { ...prev, provider: cred.provider, credential: cred },
      updatedExisting: true,
      total: records.length,
    };
  }

  const record: AccountRecord = {
    id: randomUUID(),
    label: uniqueLabel(records, opts.label ?? cred.provider),
    provider: cred.provider,
    enabled: true,
    addedAt: Date.now(),
    encrypted,
  };
  records.push(record);
  writeRecords(records);
  return {
    account: { ...record, credential: cred },
    updatedExisting: false,
    total: records.length,
  };
}

/** Resolve an account by label (case-insensitive) or id; -1 when not found. */
function findByRef(records: AccountRecord[], ref: string): number {
  const lower = ref.toLowerCase();
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec.label.toLowerCase() === lower || rec.id === ref) return i;
  }
  return -1;
}

export interface MutateResult {
  ok: boolean;
  /** Human-readable failure reason when `ok` is false. */
  error?: string;
  account?: Account;
  total: number;
}

/** Remove one account by label or id. */
export async function removeAccount(ref: string): Promise<MutateResult> {
  const records = readRecords();
  const at = findByRef(records, ref);
  if (at < 0) return { ok: false, error: `no account named "${ref}"`, total: records.length };
  const [removed] = records.splice(at, 1);
  writeRecords(records);
  const account = await decryptRecord(removed!);
  return { ok: true, account: account ?? undefined, total: records.length };
}

/**
 * Remove the ACTIVE account (first enabled). This is what `auth logout`
 * maps onto: logging out means dropping the serving account, and the next
 * enabled account (if any) takes over as active.
 */
export async function removeActiveAccount(): Promise<MutateResult> {
  const records = readRecords();
  const at = records.findIndex((r) => r.enabled !== false);
  if (at < 0) return { ok: false, error: "no enabled account", total: records.length };
  const [removed] = records.splice(at, 1);
  writeRecords(records);
  const account = await decryptRecord(removed!);
  return { ok: true, account: account ?? undefined, total: records.length };
}

/** Enable or disable one account by label or id. A disabled account never serves. */
export async function setAccountEnabled(ref: string, enabled: boolean): Promise<MutateResult> {
  const records = readRecords();
  const at = findByRef(records, ref);
  if (at < 0) return { ok: false, error: `no account named "${ref}"`, total: records.length };
  records[at] = { ...records[at]!, enabled };
  writeRecords(records);
  const account = await decryptRecord(records[at]!);
  return { ok: true, account: account ?? undefined, total: records.length };
}

/** Rename one account. Labels stay unique (case-insensitive). */
export async function renameAccount(ref: string, newLabel: string): Promise<MutateResult> {
  const trimmed = newLabel.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "label cannot be empty", total: readRecords().length };
  }
  const records = readRecords();
  const at = findByRef(records, ref);
  if (at < 0) return { ok: false, error: `no account named "${ref}"`, total: records.length };
  const clash = records.some(
    (r, i) => i !== at && r.label.toLowerCase() === trimmed.toLowerCase(),
  );
  if (clash) {
    return { ok: false, error: `label "${trimmed}" is already in use`, total: records.length };
  }
  records[at] = { ...records[at]!, label: trimmed };
  writeRecords(records);
  const account = await decryptRecord(records[at]!);
  return { ok: true, account: account ?? undefined, total: records.length };
}
