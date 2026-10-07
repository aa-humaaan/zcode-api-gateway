/**
 * Tests for the burn-rate projection and pre-switch steering: slope from
 * probe history, refill reset, pre-switch activation/preference and the
 * serve-anything fallback.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  syncFleet,
  fleetChain,
  pickServing,
  minutesToEmpty,
  applyPreSwitch,
  fleetSnapshot,
  __resetFleetStateForTests,
  __setUsageForTests,
  __setProbeHistoryForTests,
  __setCooldownForTests,
} from "./router.js";
import type { Account } from "./store.js";
import type { Credential } from "../auth/types.js";
import type { ProxyConfig } from "../config/types.js";

function cred(apiKey: string, extra: Partial<Credential> = {}): Credential {
  return { apiKey, provider: "zai", ...extra };
}

let seq = 0;
function account(extra: Partial<Account> = {}): Account {
  const key = `key-${++seq}`;
  return { id: extra.id ?? key, label: extra.label ?? key, provider: "zai", enabled: true, addedAt: 0, credential: cred(key), ...extra };
}

function config(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    planPriority: ["coding-plan"],
    accounts: { enabled: true, strategy: "priority", pollIntervalSec: 60, preSwitchMinutes: 0 },
    ...overrides,
  } as ProxyConfig;
}

beforeEach(() => __resetFleetStateForTests());

describe("minutesToEmpty", () => {
  it("projects from a declining ratio slope (no capacity needed)", () => {
    const now = Date.now();
    // 40% left, burned 20 points over 10 minutes → 2%/min → empty in 20 min.
    const tte = minutesToEmpty({
      coding: {
        usable: true, probedAt: now, remainingRatio: 0.4,
        history: [{ r: 0.6, ts: now - 10 * 60_000 }, { r: 0.4, ts: now }],
      },
      start: { usable: null, probedAt: 0, remainingRatio: null },
    }, "coding");
    expect(tte).not.toBeNull();
    expect(tte!).toBeCloseTo(20, 0);
  });

  it("returns null below the baseline window or with no history", () => {
    const now = Date.now();
    expect(minutesToEmpty(undefined, "coding")).toBeNull();
    expect(minutesToEmpty({ coding: { usable: true, probedAt: now, remainingRatio: 0.5, history: [{ r: 0.6, ts: now - 60_000 }, { r: 0.5, ts: now }] }, start: { usable: null, probedAt: 0, remainingRatio: null } }, "coding")).toBeNull();
  });

  it("a refill (rising ratio) yields no projection", () => {
    const now = Date.now();
    const usage = { coding: { usable: true, probedAt: now, remainingRatio: 0.9, history: [{ r: 0.5, ts: now - 20 * 60_000 }, { r: 0.4, ts: now - 10 * 60_000 }, { r: 0.9, ts: now }] }, start: { usable: null, probedAt: 0, remainingRatio: null } };
    // History ending HIGHER than it started = refill/reset: drop <= 0 → no
    // projection (recordBurnReading clears such history in the live watcher).
    expect(minutesToEmpty(usage, "coding")).toBeNull();
  });
});

describe("pre-switch", () => {
  it("steers new traffic to the next account when the current one projects empty soon", () => {
    const accounts = [account({ id: "a", label: "a" }), account({ id: "b", label: "b" })];
    syncFleet(accounts);
    const cfg = config({ accounts: { enabled: true, strategy: "priority", pollIntervalSec: 60, preSwitchMinutes: 30 } });
    __setUsageForTests("a", { coding: { usable: true, probedAt: Date.now(), remainingRatio: 0.4 } });
    __setUsageForTests("b", { coding: { usable: true, probedAt: Date.now(), remainingRatio: 0.8 } });
    // a burns 20 points/10min → empty in 20 min < 30 min threshold
    __setProbeHistoryForTests("a", "coding", [
      { r: 0.6, ts: Date.now() - 10 * 60_000 },
      { r: 0.4, ts: Date.now() },
    ]);
    applyPreSwitch(cfg, accounts, Date.now());
    const picked = pickServing(cfg)!;
    expect(picked.label).toBe("b");
  });

  it("rides the current account when the projection is beyond the threshold", () => {
    syncFleet([account({ id: "a", label: "a" }), account({ id: "b", label: "b" })]);
    const cfg = config({ accounts: { enabled: true, strategy: "priority", pollIntervalSec: 60, preSwitchMinutes: 10 } });
    __setUsageForTests("a", { coding: { usable: true, probedAt: Date.now(), remainingRatio: 0.4 } });
    __setProbeHistoryForTests("a", "coding", [
      { r: 0.6, ts: Date.now() - 10 * 60_000 },
      { r: 0.4, ts: Date.now() },
    ]);
    expect(pickServing(cfg)!.label).toBe("a"); // empty in ~20 min > 10 min threshold
  });

  it("serves anyway when EVERY account is pre-switched (never 429 a live account)", () => {
    syncFleet([account({ id: "a", label: "a" })]);
    const cfg = config({ accounts: { enabled: true, strategy: "priority", pollIntervalSec: 60, preSwitchMinutes: 30 } });
    __setUsageForTests("a", { coding: { usable: true, probedAt: Date.now(), remainingRatio: 0.1 } });
    __setProbeHistoryForTests("a", "coding", [
      { r: 0.6, ts: Date.now() - 10 * 60_000 },
      { r: 0.1, ts: Date.now() },
    ]);
    expect(pickServing(cfg)!.label).toBe("a"); // single fleet: fallback beats empty
  });

  it("preSwitchMinutes: 0 (default) never steers", () => {
    syncFleet([account({ id: "a", label: "a" }), account({ id: "b", label: "b" })]);
    const cfg = config();
    __setUsageForTests("a", { coding: { usable: true, probedAt: Date.now(), remainingRatio: 0.05 } });
    __setProbeHistoryForTests("a", "coding", [
      { r: 0.6, ts: Date.now() - 10 * 60_000 },
      { r: 0.05, ts: Date.now() },
    ]);
    expect(pickServing(cfg)!.label).toBe("a");
  });
});

describe("minRemaining floor (PLAN §9.3)", () => {
  it("steers away when a usable plane's absolute remaining is below the floor", () => {
    const accounts = [account({ id: "a", label: "a" }), account({ id: "b", label: "b" })];
    syncFleet(accounts);
    const cfg = config({ accounts: { enabled: true, strategy: "priority", pollIntervalSec: 60, preSwitchMinutes: 0, minRemaining: 200 } });
    __setUsageForTests("a", { coding: { usable: true, probedAt: Date.now(), remainingRatio: 0.9, remainingAbsolute: 150 } });
    __setUsageForTests("b", { coding: { usable: true, probedAt: Date.now(), remainingRatio: 0.5, remainingAbsolute: 5000 } });
    applyPreSwitch(cfg, accounts, Date.now());
    expect(pickServing(cfg)!.label).toBe("b");
  });

  it("does NOT steer on the floor when remaining is unknown or above it", () => {
    const accounts = [account({ id: "a", label: "a" }), account({ id: "b", label: "b" })];
    syncFleet(accounts);
    const cfg = config({ accounts: { enabled: true, strategy: "priority", pollIntervalSec: 60, preSwitchMinutes: 0, minRemaining: 200 } });
    __setUsageForTests("a", { coding: { usable: true, probedAt: Date.now(), remainingRatio: 0.9, remainingAbsolute: null } });
    applyPreSwitch(cfg, accounts, Date.now());
    expect(pickServing(cfg)!.label).toBe("a"); // unknown ≠ low
  });

  it("neither trigger configured → never steers", () => {
    const accounts = [account({ id: "a", label: "a" }), account({ id: "b", label: "b" })];
    syncFleet(accounts);
    const cfg = config();
    __setUsageForTests("a", { coding: { usable: true, probedAt: Date.now(), remainingRatio: 0.9, remainingAbsolute: 5 } });
    applyPreSwitch(cfg, accounts, Date.now());
    expect(pickServing(cfg)!.label).toBe("a");
  });
});

describe("account pinning (PLAN §9.2)", () => {
  it("the pinned account serves despite priority order", () => {
    const accounts = [account({ id: "a", label: "a" }), account({ id: "b", label: "b" })];
    syncFleet(accounts, accounts[1]!.id); // pin b, priority says a
    const cfg = config();
    expect(pickServing(cfg)!.label).toBe("b");
  });

  it("a stale pin (disabled account) falls back to strategy", () => {
    const accounts = [account({ id: "a", label: "a" }), account({ id: "b", label: "b", enabled: false })];
    syncFleet(accounts, accounts[1]!.id);
    const cfg = config();
    expect(pickServing(cfg)!.label).toBe("a");
  });

  it("the pin overrides the pre-switch floor (explicit human intent)", () => {
    const accounts = [account({ id: "a", label: "a" }), account({ id: "b", label: "b" })];
    syncFleet(accounts, accounts[0]!.id); // pin a
    const cfg = config({ accounts: { enabled: true, strategy: "priority", pollIntervalSec: 60, preSwitchMinutes: 0, minRemaining: 200 } });
    __setUsageForTests("a", { coding: { usable: true, probedAt: Date.now(), remainingRatio: 0.1, remainingAbsolute: 50 } });
    __setUsageForTests("b", { coding: { usable: true, probedAt: Date.now(), remainingRatio: 0.9, remainingAbsolute: 9000 } });
    applyPreSwitch(cfg, accounts, Date.now());
    expect(pickServing(cfg)!.label).toBe("a"); // human pin > automatic floor
  });

  it("a pin can't serve through a cooldown (falls to strategy until it expires)", () => {
    const accounts = [account({ id: "a", label: "a" }), account({ id: "b", label: "b" })];
    syncFleet(accounts, accounts[0]!.id);
    const cfg = config();
    for (const entry of fleetChain(cfg).filter((e) => e.accountId === "a")) {
      __setCooldownForTests(entry, Date.now() + 60_000);
    }
    expect(pickServing(cfg)!.label).toBe("b");
  });

  it("snapshot exposes the pin", () => {
    const accounts = [account({ id: "a", label: "a" }), account({ id: "b", label: "b" })];
    syncFleet(accounts, accounts[1]!.id);
    const snap = fleetSnapshot(config());
    expect(snap.accounts.map((a) => a.pinned)).toEqual([false, true]);
  });
});
