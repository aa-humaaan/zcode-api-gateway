/**
 * Local usage ledger — the "which tool/agent ate my quota?" answer.
 *
 * Every completed request appends one self-contained JSONL line: virtual key,
 * client tool, account, plan, model, tokens, timings, outcome. The query side
 * (`readUsage` + `summarizeUsage`) turns the file into per-day / per-tool /
 * per-account / per-model / per-key totals — the data the official panels do
 * not have.
 *
 * File resolution (first match wins — mirrors error-log.ts):
 *   1. `ZCODE_USAGE_LOG` env — explicit file path
 *   2. the directory of `ZCODE_PROXY_CONFIG` (the compose image lands it on
 *      the bind-mounted data volume next to config.yaml and errors.log)
 *   3. `~/.zcode-proxy/usage.log`
 *
 * Design constraints (mirrors error-log.ts):
 * - Must NEVER affect request handling — all FS work is try/catch'd; a broken
 *   destination disables the file (one console.warn) but never the proxy.
 * - Under bun:test the ledger is a no-op unless `ZCODE_USAGE_LOG` points at a
 *   temp file, so test runs never pollute the operator's real data.
 * - Size rotation: past MAX_BYTES the file becomes `usage.log.1` (single
 *   generation, overwritten). Reads include `.1` so day windows spanning a
 *   rotation stay complete.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_BYTES = 20 * 1024 * 1024;

let cachedPath: string | null = null;
let disabled = false;

/** Resolve (and memoize) the ledger file path. */
export function usageLogPath(): string {
  if (cachedPath) return cachedPath;
  const explicit = process.env.ZCODE_USAGE_LOG;
  if (explicit) {
    cachedPath = explicit;
    return cachedPath;
  }
  const configPath = process.env.ZCODE_PROXY_CONFIG;
  if (configPath) {
    cachedPath = join(dirname(configPath), "usage.log");
    return cachedPath;
  }
  cachedPath = join(homedir(), ".zcode-proxy", "usage.log");
  return cachedPath;
}

/** One completed request. `day` is the local `YYYY-MM-DD` — the aggregation key. */
export interface UsageEntry {
  ts: string;
  day: string;
  reqId: string;
  /** "ANT" | "OAI" — wire format the client spoke. */
  format: string;
  model: string;
  plan?: string;
  /** Serving fleet account label (fleet mode); absent in single-account mode. */
  account?: string;
  /** Client tool from the User-Agent (truncated), e.g. `claude-cli/2.0.14`. */
  tool?: string;
  /** Virtual key attribution, when the request presented one. */
  keyId?: string;
  keyLabel?: string;
  stream: boolean;
  status: number;
  /** Output tokens as the proxy observed them (0 when unknown). */
  tokens: number;
  ttfbMs: number;
  totalMs?: number;
  clientRequestId?: string;
  clientSessionId?: string;
}

/** Local `YYYY-MM-DD` — the ledger's day key (matches the operator's clock). */
export function localDayKey(now: number = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local-time ISO timestamp with UTC offset (error-log.ts parity). */
function localIsoTimestamp(): string {
  const d = new Date();
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Append one usage entry as a JSONL line. Never throws. */
export function appendUsage(entry: Omit<UsageEntry, "ts" | "day">): void {
  if (disabled) return;
  if (process.env.NODE_ENV === "test" && !process.env.ZCODE_USAGE_LOG) return;
  const path = usageLogPath();
  try {
    rotateUsageLogIfNeeded(path, MAX_BYTES);
    const line = JSON.stringify({ ts: localIsoTimestamp(), day: localDayKey(), ...entry } satisfies UsageEntry);
    appendFileSync(path, line + "\n");
    readCache.appendsSinceParse += 1; // invalidate the read cache
  } catch (err) {
    disabled = true;
    console.warn(`[ledger] usage log disabled (cannot write ${path}): ${(err as Error).message}`);
  }
}

/** Move an oversized ledger aside (single generation: usage.log.1 is overwritten). */
export function rotateUsageLogIfNeeded(path: string, maxBytes: number): void {
  try {
    if (statSync(path).size > maxBytes) renameSync(path, `${path}.1`);
  } catch {
    // missing file — first write
  }
}

/** Parse one JSONL line; malformed lines are skipped (hand-edits, partial writes). */
function parseLine(line: string): UsageEntry | null {
  try {
    const parsed = JSON.parse(line) as UsageEntry;
    if (typeof parsed.day !== "string" || typeof parsed.status !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Memoized read state: re-parse only when a generation's stat actually changed or we appended since. */
interface ReadCache {
  hasParsed: boolean;
  /** Appends since the last parse — belt-and-suspenders against mtime granularity. */
  appendsSinceParse: number;
  stats: { base: { mtimeMs: number; size: number } | null; rotated: { mtimeMs: number; size: number } | null } | null;
  entries: UsageEntry[];
}

const readCache: ReadCache = { hasParsed: false, appendsSinceParse: 0, stats: null, entries: [] };

function statOf(path: string): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null; // missing file
  }
}

function statsEqual(a: { mtimeMs: number; size: number } | null, b: { mtimeMs: number; size: number } | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/** Read the ledger (current + rotated generation), newest file first. Cached until a file changes or this process appends. */
export function readUsage(): UsageEntry[] {
  const base = usageLogPath();
  const baseStat = statOf(base);
  const rotatedStat = statOf(`${base}.1`);
  const statsUnchanged = readCache.stats !== null
    && statsEqual(baseStat, readCache.stats.base)
    && statsEqual(rotatedStat, readCache.stats.rotated);
  if (readCache.hasParsed && readCache.appendsSinceParse === 0 && statsUnchanged) {
    return readCache.entries;
  }
  const entries: UsageEntry[] = [];
  for (const path of [`${base}.1`, base]) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf-8");
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        const entry = parseLine(line);
        if (entry) entries.push(entry);
      }
    } catch {
      // unreadable generation (AV lock, permissions) — skip it, fail-open
    }
  }
  readCache.hasParsed = true;
  readCache.appendsSinceParse = 0;
  readCache.stats = { base: baseStat, rotated: rotatedStat };
  readCache.entries = entries;
  return entries;
}

/** Entries from the last `days` local days (today included). */
export function readUsageDays(days: number): UsageEntry[] {
  const cutoff = new Date(Date.now() - Math.max(0, days - 1) * 86400_000);
  const cutoffDay = localDayKey(cutoff.getTime());
  return readUsage().filter((e) => e.day >= cutoffDay);
}

export interface UsageTotal {
  name: string;
  requests: number;
  tokens: number;
}

export interface UsageSummary {
  days: number;
  totalRequests: number;
  totalTokens: number;
  byDay: UsageTotal[];
  byTool: UsageTotal[];
  byAccount: UsageTotal[];
  byModel: UsageTotal[];
  byKey: UsageTotal[];
  /** Failed requests (status >= 400) with the top reason statuses. */
  failedRequests: number;
}

function groupTotals(entries: UsageEntry[], keyOf: (e: UsageEntry) => string, sortByName = false): UsageTotal[] {
  const map = new Map<string, UsageTotal>();
  for (const e of entries) {
    const name = keyOf(e);
    const total = map.get(name) ?? { name, requests: 0, tokens: 0 };
    total.requests += 1;
    total.tokens += e.tokens;
    map.set(name, total);
  }
  const totals = [...map.values()];
  return sortByName
    ? totals.sort((a, b) => (a.name < b.name ? -1 : 1))
    : totals.sort((a, b) => b.requests - a.requests || b.tokens - a.tokens);
}

/**
 * Aggregate usage entries over the window: day/tool/account/model/key totals,
 * most-active first (days chronological). Tool falls back to `(unknown)` when
 * the client sent no User-Agent; key falls back to `(admin/open)` for traffic
 * that did not present a virtual key.
 */
export function summarizeUsage(entries: UsageEntry[], days: number): UsageSummary {
  return {
    days,
    totalRequests: entries.length,
    totalTokens: entries.reduce((sum, e) => sum + e.tokens, 0),
    byDay: groupTotals(entries, (e) => e.day, true).sort((a, b) => (a.name < b.name ? -1 : 1)),
    byTool: groupTotals(entries, (e) => e.tool ?? "(unknown)"),
    byAccount: groupTotals(entries, (e) => e.account ?? "(active)"),
    byModel: groupTotals(entries, (e) => e.model),
    byKey: groupTotals(entries, (e) => e.keyLabel ?? "(admin/open)"),
    failedRequests: entries.filter((e) => e.status >= 400).length,
  };
}

/** Today's request/token counts for one virtual key id — cap enforcement input. */
export function countTodayForKey(keyId: string): { requests: number; tokens: number } {
  const today = localDayKey();
  let requests = 0;
  let tokens = 0;
  for (const e of readUsage()) {
    if (e.keyId !== keyId || e.day !== today) continue;
    requests += 1;
    tokens += e.tokens;
  }
  return { requests, tokens };
}

/** Test hook: clear the memoized path, the disabled flag and the read cache. */
export function __resetUsageLogForTests(): void {
  cachedPath = null;
  disabled = false;
  readCache.hasParsed = false;
  readCache.appendsSinceParse = 0;
  readCache.stats = null;
  readCache.entries = [];
}
