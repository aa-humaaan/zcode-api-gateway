/**
 * Virtual API keys — local keys your TOOLS use, so traffic is attributable
 * and cappable per tool. `zk keys add claude-code` issues `zk-…`; the tool
 * presents it instead of the admin `proxyApiKey`.
 *
 * Store: `<store dir>/api-keys.json` (the ZCODE_PROXY_STORE_DIR seam — same
 * directory as accounts.json). Keys are stored as SHA-256 hashes with an
 * 8-char display prefix; the full key is shown once at creation and never
 * recoverable. These keys gate LOCAL access only — they never reach upstream.
 *
 * Semantics:
 *  - No proxyApiKey and no virtual keys configured → open local use, exactly
 *    as before (the zero-config path never changes).
 *  - proxyApiKey set → the admin key works everywhere, as today.
 *  - Virtual keys configured → every request must present the admin key OR a
 *    valid virtual key; a virtual key additionally carries its caps (per-day
 *    request/token limits, evaluated against the usage ledger) and an
 *    optional model allowlist.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { countTodayForKey } from "../ledger/ledger.js";
import { notify } from "../notify/notify.js";

/** Same test-isolation seam as the credential/account stores. */
const ENV_STORE_DIR = "ZCODE_PROXY_STORE_DIR";

function storeDir(): string {
  return process.env[ENV_STORE_DIR]?.trim() || join(homedir(), ".zcode-proxy");
}

function storeFile(): string {
  return join(storeDir(), "api-keys.json");
}

export interface VirtualKey {
  id: string;
  label: string;
  /** First 8 chars of the full key — display only, never sufficient to auth. */
  prefix: string;
  /** SHA-256 hex of the full key. */
  hash: string;
  createdAt: number;
  disabled?: boolean;
  caps?: {
    /** Max requests per local day; absent = unlimited. */
    requestsPerDay?: number;
    /** Max OUTPUT tokens per local day; absent = unlimited. */
    tokensPerDay?: number;
  };
  /** Model allowlist; absent/empty = all models. */
  models?: string[];
}

interface KeysFile {
  version: number;
  keys: VirtualKey[];
}

function readKeys(): VirtualKey[] {
  if (!existsSync(storeFile())) return [];
  try {
    const parsed = JSON.parse(readFileSync(storeFile(), "utf-8")) as Partial<KeysFile>;
    return Array.isArray(parsed.keys) ? parsed.keys.filter((k) => k && typeof k.hash === "string") : [];
  } catch (e) {
    console.warn(`Ignoring corrupted api-keys store at ${storeFile()}: ${(e as Error).message}`);
    return [];
  }
}

function writeKeys(keys: VirtualKey[]): void {
  mkdirSync(storeDir(), { recursive: true });
  const target = storeFile();
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify({ version: 1, keys }, null, 2), { mode: 0o600 });
  renameSync(tmp, target);
}

function hashKey(full: string): string {
  return createHash("sha256").update(full, "utf-8").digest("hex");
}

export interface IssuedKey {
  entry: VirtualKey;
  /** The full key — shown ONCE at creation. */
  fullKey: string;
}

export interface AddKeyOptions {
  label: string;
  requestsPerDay?: number;
  tokensPerDay?: number;
  models?: string[];
}

/** Create a virtual key. Labels are unique (case-insensitive). */
export function addKey(opts: AddKeyOptions): { ok: true; issued: IssuedKey } | { ok: false; error: string } {
  const label = opts.label.trim();
  if (label.length === 0) return { ok: false, error: "label cannot be empty" };
  const keys = readKeys();
  if (keys.some((k) => k.label.toLowerCase() === label.toLowerCase())) {
    return { ok: false, error: `label "${label}" is already in use` };
  }
  const fullKey = `zk-${randomBytes(24).toString("hex")}`;
  const entry: VirtualKey = {
    id: randomUUID(),
    label,
    prefix: fullKey.slice(0, 11),
    hash: hashKey(fullKey),
    createdAt: Date.now(),
    ...(opts.requestsPerDay !== undefined || opts.tokensPerDay !== undefined
      ? { caps: { ...(opts.requestsPerDay !== undefined ? { requestsPerDay: opts.requestsPerDay } : {}), ...(opts.tokensPerDay !== undefined ? { tokensPerDay: opts.tokensPerDay } : {}) } }
      : {}),
    ...(opts.models && opts.models.length > 0 ? { models: opts.models } : {}),
  };
  keys.push(entry);
  writeKeys(keys);
  return { ok: true, issued: { entry, fullKey } };
}

/** All keys, in creation order. */
export function listKeys(): VirtualKey[] {
  return readKeys();
}

/** Resolve by label (case-insensitive), id, or display prefix. */
function findByRef(keys: VirtualKey[], ref: string): number {
  const lower = ref.toLowerCase();
  return keys.findIndex((k) => k.label.toLowerCase() === lower || k.id === ref || k.prefix.toLowerCase() === lower);
}

export function removeKey(ref: string): { ok: boolean; error?: string; label?: string } {
  const keys = readKeys();
  const at = findByRef(keys, ref);
  if (at < 0) return { ok: false, error: `no key "${ref}"` };
  const [removed] = keys.splice(at, 1);
  writeKeys(keys);
  return { ok: true, label: removed?.label };
}

export function setKeyDisabled(ref: string, disabled: boolean): { ok: boolean; error?: string; label?: string } {
  const keys = readKeys();
  const at = findByRef(keys, ref);
  if (at < 0) return { ok: false, error: `no key "${ref}"` };
  keys[at] = { ...keys[at]!, ...(disabled ? { disabled: true } : { disabled: undefined }) };
  writeKeys(keys);
  return { ok: true, label: keys[at]!.label };
}

/** Whether any virtual keys exist — the "must present a key" gate input. */
export function hasAnyKeys(): boolean {
  return readKeys().length > 0;
}

/** Extract the presented bearer/x-api-key string from a request's headers. */
function presentedKeyOf(headers: { get(name: string): string | null }): string | null {
  const auth = headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    const value = auth.slice(7).trim();
    if (value) return value;
  }
  const apiKey = headers.get("x-api-key");
  if (apiKey && apiKey.trim()) return apiKey.trim();
  return null;
}

/**
 * Resolve the virtual key a request presents (hash lookup), null when it
 * presents none or an unknown one. The ADMIN proxyApiKey never resolves here
 * — it is checked separately by the server gate.
 */
export function resolveRequestKey(req: Request): VirtualKey | null {
  const presented = presentedKeyOf(req.headers);
  if (presented === null) return null;
  const hash = hashKey(presented);
  return readKeys().find((k) => k.hash === hash) ?? null;
}

export interface KeyAdmission {
  ok: boolean;
  /** Human-readable refusal when ok is false. */
  reason?: string;
  /** HTTP status for the refusal (429 caps, 403 model allowlist, 401 disabled). */
  status?: number;
}

/**
 * Check a resolved virtual key against its caps (from today's ledger counts)
 * and the request's model against its allowlist. Uncapped keys pass trivially.
 */
export function admitRequest(entry: VirtualKey, model: string): KeyAdmission {
  if (entry.disabled) {
    return { ok: false, reason: `virtual key "${entry.label}" is disabled`, status: 401 };
  }
  if (entry.models && entry.models.length > 0 && !entry.models.includes(model)) {
    return {
      ok: false,
      reason: `model "${model}" is not allowed for key "${entry.label}" (allowed: ${entry.models.join(", ")})`,
      status: 403,
    };
  }
  if (entry.caps?.requestsPerDay !== undefined || entry.caps?.tokensPerDay !== undefined) {
    const today = countTodayForKey(entry.id);
    if (entry.caps.requestsPerDay !== undefined && today.requests >= entry.caps.requestsPerDay) {
      const reason = `virtual key "${entry.label}" hit its daily request cap (${entry.caps.requestsPerDay})`;
      notify("key_cap", reason);
      return { ok: false, reason, status: 429 };
    }
    if (entry.caps.tokensPerDay !== undefined && today.tokens >= entry.caps.tokensPerDay) {
      const reason = `virtual key "${entry.label}" hit its daily token cap (${entry.caps.tokensPerDay})`;
      notify("key_cap", reason);
      return { ok: false, reason, status: 429 };
    }
  }
  return { ok: true };
}

/** Test hook: nothing cached, but keeps call sites symmetric with other stores. */
export function getKeysStorePath(): string {
  return storeFile();
}
