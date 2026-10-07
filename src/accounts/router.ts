/**
 * Fleet router — multi-account serving + failover. The (account, plan)
 * generalization of ../plan/auto.ts: where the plan auto-switch moves
 * traffic between the two plan tiers of ONE account, the fleet router moves
 * it across the whole (account × plan) chain built from the accounts store.
 *
 * Three layers, mirroring the repo's existing seams:
 *  - A background watcher (`startFleetWatcher`, skeleton of startPlanAutoWatcher)
 *    probes every enabled account's quota planes on a staggered cadence and
 *    keeps a usability matrix (probe failures never mark an account unusable —
 *    fail-open, same rule as the plan watcher).
 *  - Strategy-aware serving (`pickServing`): priority (drain in store order),
 *    round-robin (spread evenly), least-used (most headroom first — an
 *    approximation from the quota planes until the usage ledger lands).
 *  - A per-request chain walk (`walkFleetChain`, callback shape of
 *    retryOnPlanExhausted): when the serving entry's gateway rejects the
 *    request, the SAME request rebuilds and retries on the next usable chain
 *    entry — possibly a different plan AND a different account — until one
 *    serves or the chain is exhausted (then the client gets a clean 429).
 *
 * Cooldowns are per (account, plan): one dead entry never freezes the fleet.
 * Quota rejections cool down for 10 minutes (PLAN_FALLBACK_COOLDOWN_MS);
 * a coding-plan 401/403 (the API key itself refused) for 30 minutes. A
 * successful watcher probe clears the matching cooldown — direct evidence
 * the entry works again.
 *
 * Module-level state follows the plan/auto.ts singleton pattern;
 * `__resetFleetStateForTests` restores a clean slate.
 */
import {
  PLAN_FALLBACK_COOLDOWN_MS,
  planPriorityOf,
  planWatchedLimitsOf,
  hasUsableBalance,
  codingUsable,
  describeCodingWindow,
  formatDuration,
  sniffStartPlanRejection,
  type PlanTier,
} from "../plan/auto.js";
import type { Credential } from "../auth/types.js";
import type { ProxyConfig } from "../config/types.js";
import {
  loadAccounts,
  type Account,
} from "./store.js";
import {
  fetchStartPlanBalance,
  fetchCodingPlanUsage,
  type StartPlanBalance,
  type CodingPlanUsage,
} from "../server/routes-quota.js";
import { notify } from "../notify/notify.js";

/** One (account, plan) routing unit — the fleet's failover currency. */
export interface ChainEntry {
  accountId: string;
  label: string;
  provider: Credential["provider"];
  plan: PlanTier;
}

/** Quota-plane observation for one account (null = no data yet — fail-open). */
interface PlaneUsage {
  usable: boolean | null;
  /** Unix ms of the last probe that touched this plane. */
  probedAt: number;
  /** Remaining quota 0..1 (min across watched windows / max bucket); null when unknown. */
  remainingRatio: number | null;
  /**
   * Recent remaining-ratio readings for the burn-rate projection (oldest
   * first, capped). Cleared when a reading jumps UP (quota reset/refill) —
   * a refill must not read as negative burn.
   */
  history?: Array<{ r: number; ts: number }>;
}

interface AccountUsage {
  start: PlaneUsage;
  coding: PlaneUsage;
  /** Last successful probe payloads (log-line rendering; not routing inputs). */
  codingProbe?: CodingPlanUsage;
  startProbe?: StartPlanBalance;
}

/** Quota rejections cool an entry down for this long (plan-fallback parity). */
export const FLEET_REJECTION_COOLDOWN_MS = PLAN_FALLBACK_COOLDOWN_MS;
/** A coding-plan 401/403 means the API key itself was refused — cool down longer. */
export const FLEET_AUTH_COOLDOWN_MS = 1_800_000;

interface FleetState {
  accounts: Account[];
  usage: Map<string, AccountUsage>;
  /** `${accountId}:${plan}` → cooldown-until epoch ms. */
  cooldowns: Map<string, number>;
  /**
   * Pre-switch: accountId → until epoch ms. Accounts projecting empty within
   * `accounts.preSwitchMinutes` stop RECEIVING new steady-state traffic (the
   * strategies skip them) while still serving as failover targets — the next
   * account takes the load BEFORE the hard 429. Off when config is 0.
   */
  preSwitch: Map<string, number>;
  /** Round-robin cursor over usable accounts. */
  rrCursor: number;
  /** What pickServing last chose (watcher log line). */
  lastServing: ChainEntry | null;
}

const state: FleetState = {
  accounts: [],
  usage: new Map(),
  cooldowns: new Map(),
  preSwitch: new Map(),
  rrCursor: 0,
  lastServing: null,
};

/** Replace the account snapshot (store is the source of truth); runtime state of removed accounts is dropped. */
export function syncFleet(accounts: Account[]): void {
  state.accounts = accounts;
  const ids = new Set(accounts.map((a) => a.id));
  for (const id of [...state.usage.keys()]) {
    if (!ids.has(id)) state.usage.delete(id);
  }
  for (const id of [...state.preSwitch.keys()]) {
    if (!ids.has(id)) state.preSwitch.delete(id);
  }
}

/** The failover chain: enabled accounts in store order × plan priority. */
export function fleetChain(config: ProxyConfig): ChainEntry[] {
  const entries: ChainEntry[] = [];
  const priority = planPriorityOf(config);
  for (const account of state.accounts) {
    if (!account.enabled) continue;
    for (const plan of priority) {
      entries.push({ accountId: account.id, label: account.label, provider: account.credential.provider, plan });
    }
  }
  return entries;
}

function credentialOfId(accountId: string): Credential | null {
  return state.accounts.find((a) => a.id === accountId)?.credential ?? null;
}

/** The credential a chain entry serves with; null when the account vanished. */
export function credentialOf(entry: ChainEntry): Credential | null {
  return credentialOfId(entry.accountId);
}

function cooldownKey(entry: ChainEntry): string {
  return `${entry.accountId}:${entry.plan}`;
}

/**
 * Can this entry take traffic right now? Cooldowns are hard gates; probe
 * data is fail-open (no data / probe failure never blocks). A start-plan
 * entry whose credential carries no JWT is statically unusable — that is a
 * known-capability fact, not missing probe data.
 */
export function entryUsable(entry: ChainEntry, config: ProxyConfig, now: number = Date.now()): boolean {
  const until = state.cooldowns.get(cooldownKey(entry));
  if (until !== undefined && now < until) return false;
  const cred = credentialOfId(entry.accountId);
  if (!cred) return false;
  if (entry.plan === "start-plan" && !cred.jwt) return false;
  const usage = state.usage.get(entry.accountId);
  if (!usage) return true;
  const plane = entry.plan === "start-plan" ? usage.start : usage.coding;
  return plane.usable === null ? true : plane.usable;
}

/**
 * The upstream statuses that make an entry's gateway answer "not this
 * entry". start-plan mirrors shouldFallbackPlan exactly (401/402/403/429/
 * 502/504 + the 200-envelope sniff done separately). coding-plan adds
 * 401/403 to the plan watcher's 429: a key the gateway refuses cannot be
 * fixed by retrying the same account, so the request moves accounts.
 */
export function fleetEntryRejected(status: number, plan: PlanTier): boolean {
  if (plan === "start-plan") {
    return status === 401 || status === 402 || status === 403 || status === 429 || status === 502 || status === 504;
  }
  return status === 429 || status === 401 || status === 402 || status === 403;
}

/**
 * Evaluate one upstream response for fleet failover: error statuses per
 * {@link fleetEntryRejected}, plus the start-plan 200-JSON-error-envelope
 * sniff (that gateway exhausts plans that way too). The (possibly
 * reconstructed) response comes back so the caller can still serve it.
 */
export async function evaluateFleetResponse(resp: Response, plan: PlanTier): Promise<{ rejected: boolean; resp: Response }> {
  if (fleetEntryRejected(resp.status, plan)) return { rejected: true, resp };
  if (plan === "start-plan" && resp.status === 200) {
    const sniff = await sniffStartPlanRejection(resp);
    return { rejected: sniff.rejected, resp: sniff.response };
  }
  return { rejected: false, resp };
}

/**
 * Record a request outcome for an entry. `status === null` = served OK
 * (clears any cooldown); otherwise the upstream status sets the cooldown —
 * 10 min for quota/gateway rejections, 30 min for a coding-plan key refusal.
 */
export function noteRequestResult(entry: ChainEntry, status: number | null): void {
  const key = cooldownKey(entry);
  if (status === null) {
    state.cooldowns.delete(key);
    return;
  }
  const authReject = entry.plan === "coding-plan" && (status === 401 || status === 403);
  state.cooldowns.set(key, Date.now() + (authReject ? FLEET_AUTH_COOLDOWN_MS : FLEET_REJECTION_COOLDOWN_MS));
}

/** Strategy dispatch: the entry that should serve the next request (null = nothing usable). */
export function pickServing(config: ProxyConfig): ChainEntry | null {
  const chain = fleetChain(config);
  if (chain.length === 0) return null;
  const pick = (entries: ChainEntry[]): ChainEntry | null => {
    const strategy = config.accounts?.strategy ?? "priority";
    return strategy === "round-robin"
      ? pickRoundRobin(config, entries)
      : strategy === "least-used"
        ? pickLeastUsed(config, entries)
        : (entries.find((e) => entryUsable(e, config)) ?? null);
  };
  // Pre-switch first pass: skip accounts projected to empty soon. If that
  // leaves nothing (single-account fleet, or every account projecting out),
  // serve anyway — riding the current account into the 429 beats serving
  // nothing, and the per-request walk still fails over.
  const now = Date.now();
  const notPreSwitched = (e: ChainEntry): boolean => {
    const until = state.preSwitch.get(e.accountId);
    return until === undefined || now >= until;
  };
  const picked = pick(chain.filter(notPreSwitched)) ?? pick(chain);
  if (picked) state.lastServing = picked;
  return picked;
}

function pickRoundRobin(config: ProxyConfig, chain: ChainEntry[]): ChainEntry | null {
  // Group usable entries per account (chain order preserved); rotate across
  // ACCOUNTS so each gets an even share of requests.
  const byAccount = new Map<string, ChainEntry[]>();
  for (const entry of chain) {
    if (!entryUsable(entry, config)) continue;
    const list = byAccount.get(entry.accountId);
    if (list) list.push(entry);
    else byAccount.set(entry.accountId, [entry]);
  }
  const usableAccounts = [...byAccount.values()];
  if (usableAccounts.length === 0) return null;
  const bucket = usableAccounts[state.rrCursor % usableAccounts.length]!;
  state.rrCursor = (state.rrCursor + 1) % Number.MAX_SAFE_INTEGER;
  return bucket[0]!;
}

/** Remaining quota of one plane, 0..1; null when no sane numbers are reported. */
function planeRatio(usage: AccountUsage | undefined, plan: PlanTier): number | null {
  const plane = usage === undefined ? null : plan === "start-plan" ? usage.start : usage.coding;
  return plane?.remainingRatio ?? null;
}

function pickLeastUsed(config: ProxyConfig, chain: ChainEntry[]): ChainEntry | null {
  const byAccount = new Map<string, ChainEntry[]>();
  for (const entry of chain) {
    if (!entryUsable(entry, config)) continue;
    const list = byAccount.get(entry.accountId);
    if (list) list.push(entry);
    else byAccount.set(entry.accountId, [entry]);
  }
  if (byAccount.size === 0) return null;
  // Headroom score per account: the best remaining ratio across its planes;
  // a plane with no probe data counts as 0.5 (neutral) — the quota planes
  // only approximate spend until the usage ledger lands (PLAN §3.1).
  let bestId: string | null = null;
  let bestScore = -1;
  for (const [accountId] of byAccount) {
    const usage = state.usage.get(accountId);
    const start = planeRatio(usage, "start-plan") ?? 0.5;
    const coding = planeRatio(usage, "coding-plan") ?? 0.5;
    const score = Math.max(start, coding);
    if (score > bestScore) {
      bestScore = score;
      bestId = accountId;
    }
  }
  const entries = byAccount.get(bestId!)!;
  // Serve with the plane that produced the headroom (ties → the earlier
  // plan-priority entry); fall back to the account's first usable entry.
  const usage = state.usage.get(bestId!)!;
  const start = planeRatio(usage, "start-plan");
  const coding = planeRatio(usage, "coding-plan");
  if (start !== null && (coding === null || start >= coding)) {
    const entry = entries.find((e) => e.plan === "start-plan");
    if (entry) return entry;
  }
  if (coding !== null) {
    const entry = entries.find((e) => e.plan === "coding-plan");
    if (entry) return entry;
  }
  return entries[0]!;
}

/** The next usable chain entry strictly after `entry`; null when none remains. */
export function nextAfter(entry: ChainEntry, config: ProxyConfig): ChainEntry | null {
  const chain = fleetChain(config);
  const at = chain.findIndex((e) => e.accountId === entry.accountId && e.plan === entry.plan);
  if (at < 0) return null;
  for (let i = at + 1; i < chain.length; i++) {
    const candidate = chain[i]!;
    if (entryUsable(candidate, config)) return candidate;
  }
  return null;
}

/** `work/start-plan` — the readable chain-entry name for logs. */
export function entryName(entry: ChainEntry): string {
  return `${entry.label}/${entry.plan}`;
}

export interface FleetWalkOutcome {
  handled: boolean;
  /** The entry that served and its response, when the walk found one. */
  served?: { entry: ChainEntry; resp: Response };
  /** Every entry refused: the tried names and the last evaluated response. */
  exhausted?: { tried: string[]; lastResp: Response };
}

/**
 * Per-request fleet failover (callback shape mirrors retryOnPlanExhausted):
 * the caller already evaluated the first response as rejected — walk the
 * remaining chain, rebuilding + dispatching the SAME request on each next
 * usable entry, until one serves or the chain is exhausted. Each hop is
 * noted (cooldown on rejection, clear on serve) so concurrent requests skip
 * entries that just failed.
 */
export async function walkFleetChain(args: {
  config: ProxyConfig;
  from: ChainEntry;
  /** The first (rejected) response's upstream status — for its cooldown. */
  firstStatus: number;
  dispatchEntry: (entry: ChainEntry) => Promise<Response>;
  onFallback?: (message: string) => void;
}): Promise<FleetWalkOutcome> {
  const tried: string[] = [entryName(args.from)];
  noteRequestResult(args.from, args.firstStatus);
  const log = args.onFallback ?? ((m: string) => console.log(m));

  let current = args.from;
  let lastResp: Response | null = null;
  for (;;) {
    const next = nextAfter(current, args.config);
    if (next === null) {
      const triedNames = tried.join(", ");
      notify("fleet_exhausted", `fleet exhausted: every account/plan refused the request (${triedNames}) — requests will 429 until quota or cooldowns recover`);
      return {
        handled: true,
        exhausted: {
          tried,
          // Unreachable in practice: the loop body always sets lastResp
          // before the next iteration, and the first iteration runs the
          // dispatch below. The null-check keeps the type honest.
          lastResp: lastResp ?? new Response(null, { status: 502 }),
        },
      };
    }
    tried.push(entryName(next));
    log(`fleet: ${entryName(current)} rejected → trying ${entryName(next)}`);
    notify("entry_cooldown", `fleet: ${entryName(current)} rejected upstream — failing over to ${entryName(next)}`);
    const resp = await args.dispatchEntry(next);
    const evaluated = await evaluateFleetResponse(resp, next.plan);
    lastResp = evaluated.resp;
    if (!evaluated.rejected) {
      noteRequestResult(next, null);
      state.lastServing = next;
      return { handled: true, served: { entry: next, resp: evaluated.resp } };
    }
    noteRequestResult(next, resp.status);
    current = next;
  }
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

/**
 * The fleet-router handle threaded through server options. Per-request
 * routing (pickServing / nextAfter / walkFleetChain) runs off the module
 * functions — the handlers already hold `config` — so the handle only owns
 * the lifecycle seams: snapshot sync and the background watcher.
 */
export interface FleetRouter {
  /** Re-read the accounts store into the router snapshot (boot, login events). */
  sync(): Promise<void>;
  startWatcher(): FleetWatcher;
}

export function createFleetRouter(config: ProxyConfig, deps: FleetWatcherDeps = {}): FleetRouter {
  return {
    async sync(): Promise<void> {
      syncFleet(await loadAccounts().catch(() => [] as Account[]));
    },
    startWatcher(): FleetWatcher {
      return startFleetWatcher(config, deps);
    },
  };
}

export interface FleetWatcher {
  stop(): void;
  /** One probe cycle → matrix update. Exposed for tests. */
  tick(): Promise<void>;
}

export interface FleetWatcherDeps {
  fetchImpl?: typeof fetch;
  loadAccountsImpl?: typeof loadAccounts;
  fetchStartPlanBalanceImpl?: typeof fetchStartPlanBalance;
  fetchCodingPlanUsageImpl?: typeof fetchCodingPlanUsage;
  /** Sleep between per-account probes inside one tick, in ms. Default 1500. */
  probeGapMs?: number;
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

function ensureUsage(accountId: string): AccountUsage {
  let usage = state.usage.get(accountId);
  if (!usage) {
    usage = {
      start: { usable: null, probedAt: 0, remainingRatio: null },
      coding: { usable: null, probedAt: 0, remainingRatio: null },
    };
    state.usage.set(accountId, usage);
  }
  return usage;
}

/** Max remaining/total across balance buckets with a sane total. */
function startRatio(balances: StartPlanBalance["balances"]): number | null {
  const ratios = balances
    .filter((b) => b.totalUnits > 0)
    .map((b) => Math.min(1, Math.max(0, b.remainingUnits / b.totalUnits)));
  return ratios.length === 0 ? null : Math.max(...ratios);
}

/** Min remaining ratio across the WATCHED coding windows (the binding constraint). */
function codingRatio(limits: CodingPlanUsage["limits"], watchTypes: string[]): number | null {
  const ratios: number[] = [];
  for (const type of watchTypes) {
    const row = limits.find((l) => l.type === type);
    if (!row) continue;
    if (row.percentage !== undefined && row.percentage >= 0 && row.percentage <= 100) {
      ratios.push(1 - row.percentage / 100);
    } else if (typeof row.remaining === "number" && typeof row.total === "number" && row.total > 0) {
      ratios.push(Math.min(1, Math.max(0, row.remaining / row.total)));
    }
  }
  return ratios.length === 0 ? null : Math.min(...ratios);
}

/** Probe-history cap — old readings beyond this add nothing to the slope. */
const HISTORY_CAP = 6;
/** Minimum baseline minutes for a trustworthy slope (percent-granularity probes are noisy). */
const SLOPE_BASELINE_MIN = 5;

/**
 * Record one remaining-ratio reading into the plane's burn history. A reading
 * HIGHER than the previous one means quota reset/refill — the history resets,
 * because a refill must never read as negative burn.
 */
function recordBurnReading(usage: AccountUsage, plane: "start" | "coding", ratio: number | null, now: number): void {
  if (ratio === null) return;
  const target = usage[plane];
  const history = target.history ?? (target.history = []);
  const prev = history[history.length - 1];
  if (prev !== undefined && ratio > prev.r) {
    history.length = 0; // refill/reset — start a fresh baseline
  }
  history.push({ r: ratio, ts: now });
  if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP);
}

/**
 * Projected minutes until this plane runs out, from the remaining-ratio slope
 * across the probe history. This needs no window capacity: both the remaining
 * share and the burn come from the same 0..1 readings. Returns null when the
 * baseline is too short/flat or the plane is refilling — honest "unknown".
 */
export function minutesToEmpty(usage: AccountUsage | undefined, plane: "start" | "coding"): number | null {
  const history = usage?.[plane].history;
  if (!history || history.length < 2) return null;
  const first = history[0]!;
  const last = history[history.length - 1]!;
  const dtMin = (last.ts - first.ts) / 60_000;
  if (dtMin < SLOPE_BASELINE_MIN) return null;
  const drop = first.r - last.r;
  if (drop <= 0) return null;
  const burnPerMin = drop / dtMin;
  const tte = last.r / burnPerMin;
  return Number.isFinite(tte) && tte > 0 ? tte : null;
}

/** Pre-switch pass: activate/deactivate per account from projections + config. */
export function applyPreSwitch(config: ProxyConfig, accounts: Account[], now: number): void {
  const thresholdMin = config.accounts?.preSwitchMinutes ?? 0;
  if (thresholdMin <= 0) {
    state.preSwitch.clear();
    return;
  }
  for (const account of accounts) {
    if (!account.enabled) {
      state.preSwitch.delete(account.id);
      continue;
    }
    const usage = state.usage.get(account.id);
    const tte = minutesToEmpty(usage, "coding") ?? minutesToEmpty(usage, "start");
    const wasActive = state.preSwitch.has(account.id);
    if (tte !== null && tte <= thresholdMin) {
      state.preSwitch.set(account.id, now + Math.max(1, Math.round(tte)) * 60_000);
      if (!wasActive) {
        notify(
          "pre_switch",
          `fleet: "${account.label}" projects empty in ~${formatDuration(tte * 60_000)} at current burn — steering new traffic to the next account`,
        );
      }
    } else {
      state.preSwitch.delete(account.id);
    }
  }
}

/**
 * Start the fleet watcher: re-syncs the account snapshot, then probes every
 * enabled account's quota planes on `config.accounts.pollIntervalSec`, with
 * `probeGapMs` spacing BETWEEN accounts inside a tick so a fleet of N never
 * means N simultaneous hammering of the quota endpoints (they rate-limit).
 */
export function startFleetWatcher(config: ProxyConfig, deps: FleetWatcherDeps = {}): FleetWatcher {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const loadAccountsImpl = deps.loadAccountsImpl ?? loadAccounts;
  const fetchStart = deps.fetchStartPlanBalanceImpl ?? fetchStartPlanBalance;
  const fetchCoding = deps.fetchCodingPlanUsageImpl ?? fetchCodingPlanUsage;
  const probeGapMs = deps.probeGapMs ?? 1500;

  const watcher: FleetWatcher = {
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    async tick(): Promise<void> {
      if (stopped) return;
      const accounts = (await loadAccountsImpl().catch(() => [])) as Account[];
      syncFleet(accounts);
      const enabled = accounts.filter((a) => a.enabled);

      for (let i = 0; i < enabled.length; i++) {
        if (stopped) return;
        const account = enabled[i]!;
        if (i > 0) await sleep(probeGapMs);
        const cred = account.credential;
        const loader = async (): Promise<Credential> => cred;
        const usage = ensureUsage(account.id);
        const now = Date.now();

        const [start, coding] = await Promise.all([
          fetchStart(config, deps.fetchImpl, loader).catch(() => null),
          fetchCoding(config, deps.fetchImpl, loader).catch(() => null),
        ]);

        if (start !== null) {
          if (start.ok) {
            const wasUsable = usage.start.usable;
            const ratio = startRatio(start.balances);
            usage.start = {
              usable: hasUsableBalance(start.balances),
              probedAt: now,
              remainingRatio: ratio,
            };
            recordBurnReading(usage, "start", ratio, now);
            usage.startProbe = start;
            // The billing plane answered with the account's JWT — direct
            // evidence the start entry works; drop its cooldown.
            state.cooldowns.delete(`${account.id}:start-plan`);
            if (wasUsable !== false && usage.start.usable === false) {
              notify("account_empty", `fleet: account "${account.label}" start-plan tokens are empty`);
            }
          } else {
            usage.start.probedAt = now; // failed probe: fail-open, keep old data
          }
        }
        if (coding !== null) {
          if (coding.ok) {
            const wasUsable = usage.coding.usable;
            const ratio = codingRatio(coding.limits, planWatchedLimitsOf(config, "coding-plan"));
            usage.coding = {
              usable: codingUsable(coding.limits, planWatchedLimitsOf(config, "coding-plan")),
              probedAt: now,
              remainingRatio: ratio,
            };
            recordBurnReading(usage, "coding", ratio, now);
            usage.codingProbe = coding;
            state.cooldowns.delete(`${account.id}:coding-plan`);
            if (wasUsable !== false && usage.coding.usable === false) {
              notify("account_empty", `fleet: account "${account.label}" coding-plan windows are empty`);
            }
          } else {
            usage.coding.probedAt = now;
          }
        }
      }

      // Pre-switch: with a threshold configured, project each account's time
      // to empty and steer steady-state traffic off the dying ones early.
      applyPreSwitch(config, enabled, Date.now());

      const line = formatFleetLine(config);
      if (line) console.log(line);
    },
  };

  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void watcher.tick().finally(scheduleNext);
    }, (config.accounts?.pollIntervalSec ?? 60) * 1000);
  };
  void watcher.tick().finally(scheduleNext);
  return watcher;
}

/** `100.568.323` — tr-TR dotted grouping (plan/auto.ts parity). */
const GROUPED = new Intl.NumberFormat("tr-TR");

/**
 * The operator-facing fleet line (one per tick that saw data):
 * `fleet: serving work/coding-plan (priority) | work: 5h Window: %30 used,
 * resets in 3h 5m; tokens 55.543.454 / 100.000.000 left | trial: no data`.
 * Null when no account reported anything (silence, not spam).
 */
export function formatFleetLine(config: ProxyConfig): string | null {
  if (state.accounts.length === 0) return null;
  const now = Date.now();
  const parts: string[] = [];
  let sawData = false;
  for (const account of state.accounts) {
    if (!account.enabled) {
      parts.push(`${account.label}: disabled`);
      continue;
    }
    const usage = state.usage.get(account.id);
    const bits: string[] = [];
    if (usage?.codingProbe) {
      sawData = true;
      for (const type of planWatchedLimitsOf(config, "coding-plan")) {
        const row = usage.codingProbe.limits.find((l) => l.type === type);
        if (row) bits.push(`${type}: ${describeCodingWindow(row, "left", now)}`);
      }
    }
    if (usage?.startProbe?.ok) {
      const bucket = usage.startProbe.balances.find((b) => b.remainingUnits > 0) ?? usage.startProbe.balances[0];
      if (bucket) {
        sawData = true;
        bits.push(`tokens ${GROUPED.format(bucket.remainingUnits)} / ${GROUPED.format(bucket.totalUnits)} left`);
      }
    }
    // Burn-rate projection when the history supports a slope (≥5 min baseline).
    const tte = minutesToEmpty(usage, "coding") ?? minutesToEmpty(usage, "start");
    if (tte !== null) {
      sawData = true;
      bits.push(`burn projects empty in ~${formatDuration(tte * 60_000)}`);
    }
    const preSwitchUntil = state.preSwitch.get(account.id);
    if (preSwitchUntil !== undefined && now < preSwitchUntil) {
      bits.push("pre-switching traffic away");
    }
    parts.push(bits.length > 0 ? `${account.label}: ${bits.join("; ")}` : `${account.label}: no data`);
  }
  if (!sawData) return null;
  const serving = state.lastServing ? `${state.lastServing.label}/${state.lastServing.plan}` : "—";
  const strategy = config.accounts?.strategy ?? "priority";
  return `fleet: serving ${serving} (${strategy}) | ${parts.join(" | ")}`;
}

/** Restore pristine module state in tests. */
export function __resetFleetStateForTests(): void {
  state.accounts = [];
  state.usage = new Map();
  state.cooldowns = new Map();
  state.preSwitch = new Map();
  state.rrCursor = 0;
  state.lastServing = null;
}

// ---------------------------------------------------------------------------
// UI snapshot (TUI fleet card / web panel / CLI)
// ---------------------------------------------------------------------------

/** Per-entry state for UIs: the four states a routing unit can be in. */
export type FleetEntryState = "usable" | "empty" | "unknown" | "cooldown";

export interface FleetSnapshotEntry {
  plan: PlanTier;
  state: FleetEntryState;
  /** Remaining quota 0..1 from the last successful probe; null = unknown. */
  remainingRatio: number | null;
}

export interface FleetSnapshotAccount {
  id: string;
  label: string;
  provider: string;
  enabled: boolean;
  /** This account is what the router last served from. */
  serving: boolean;
  /** First enabled account in store order — the pre-fleet "active". */
  isActive: boolean;
  /** Projected to run out soon: new steady-state traffic is steering away. */
  preSwitch: boolean;
  entries: FleetSnapshotEntry[];
}

export interface FleetSnapshot {
  strategy: string;
  accounts: FleetSnapshotAccount[];
}

/**
 * Read-only fleet status for UIs. Pure state read: no network, no store I/O —
 * safe to call per render / per panel poll. Reflects the watcher's matrix and
 * the cooldown map; an account the watcher has not probed yet shows its
 * entries as "unknown" (the router still serves them — fail-open).
 */
export function fleetSnapshot(config: ProxyConfig): FleetSnapshot {
  const now = Date.now();
  const active = state.accounts.find((a) => a.enabled);
  const accounts: FleetSnapshotAccount[] = state.accounts.map((a) => {
    const usage = state.usage.get(a.id);
    const chain = fleetChain(config).filter((e) => e.accountId === a.id);
    const entries: FleetSnapshotEntry[] = (chain.length > 0 ? chain : (["start-plan", "coding-plan"] as PlanTier[]).map((plan) => ({
      accountId: a.id,
      label: a.label,
      provider: a.credential.provider,
      plan,
    }))).map((e) => {
      const until = state.cooldowns.get(cooldownKey(e));
      const plane = e.plan === "start-plan" ? usage?.start : usage?.coding;
      const st: FleetEntryState =
        !a.enabled
          ? "unknown" // disabled entries never serve; a stale cooldown is noise
          : until !== undefined && now < until
            ? "cooldown"
            : plane?.usable === undefined || plane.usable === null
              ? "unknown"
              : plane.usable
                ? "usable"
                : "empty";
      return { plan: e.plan, state: st, remainingRatio: plane?.remainingRatio ?? null };
    });
    return {
      id: a.id,
      label: a.label,
      provider: a.credential.provider,
      enabled: a.enabled,
      serving: state.lastServing?.accountId === a.id,
      isActive: active?.id === a.id,
      preSwitch: (() => {
        const until = state.preSwitch.get(a.id);
        return until !== undefined && now < until;
      })(),
      entries,
    };
  });
  return { strategy: config.accounts?.strategy ?? "priority", accounts };
}

/** Test seams: inject usage/cooldowns without probing. */
export function __setUsageForTests(accountId: string, usage: Partial<AccountUsage>): void {
  const current = ensureUsage(accountId);
  if (usage.start) current.start = { ...current.start, ...usage.start };
  if (usage.coding) current.coding = { ...current.coding, ...usage.coding };
}

export function __setCooldownForTests(entry: ChainEntry, until: number): void {
  state.cooldowns.set(cooldownKey(entry), until);
}

/** Test seam: attach raw probe payloads for the fleet log line. */
export function __setProbeCacheForTests(accountId: string, coding?: CodingPlanUsage, start?: StartPlanBalance): void {
  const usage = ensureUsage(accountId);
  if (coding) usage.codingProbe = coding;
  if (start) usage.startProbe = start;
}

/** Test seam: inject burn history (projection input) without running probes. */
export function __setProbeHistoryForTests(accountId: string, plane: "start" | "coding", history: Array<{ r: number; ts: number }>): void {
  const usage = ensureUsage(accountId);
  usage[plane].history = [...history];
}
