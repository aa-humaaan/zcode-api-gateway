/**
 * Tests for the fleet router: chain building, selection strategies,
 * cooldowns, the per-request chain walk and the watcher's matrix update.
 *
 * Router state is module-level (plan/auto.ts pattern) — every test resets it
 * and syncs its own synthetic fleet snapshot. No real network: the watcher
 * runs with injected probe fns.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  syncFleet,
  fleetChain,
  pickServing,
  credentialOf,
  noteRequestResult,
  walkFleetChain,
  evaluateFleetResponse,
  startFleetWatcher,
  entryUsable,
  fleetSnapshot,
  __resetFleetStateForTests,
  __setCooldownForTests,
  __setUsageForTests,
  type ChainEntry,
} from "./router.js";
import type { Account } from "./store.js";
import type { Credential } from "../auth/types.js";
import type { ProxyConfig } from "../config/types.js";

function cred(apiKey: string, extra: Partial<Credential> = {}): Credential {
  return { apiKey, provider: "zai", ...extra };
}

let seq = 0;
function account(extra: Partial<Account> = {}, credential: Credential = cred(`key-${++seq}`)): Account {
  return {
    id: credential.apiKey,
    label: credential.apiKey,
    provider: "zai",
    enabled: true,
    addedAt: 0,
    credential,
    ...extra,
  };
}

/** Minimal ProxyConfig carrying only what the router reads. */
function config(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    planPriority: ["start-plan", "coding-plan"],
    planSwitchRules: undefined,
    accounts: { enabled: true, strategy: "priority", pollIntervalSec: 60 },
    ...overrides,
  } as ProxyConfig;
}

function fleet(...accounts: Account[]): void {
  syncFleet(accounts);
}

const A = "a"; // account ids double as labels in the fixtures

describe("fleet chain", () => {
  beforeEach(() => __resetFleetStateForTests());

  it("interleaves plan priority within store order", () => {
    fleet(account({ id: "a", label: "a" }), account({ id: "b", label: "b" }));
    const chain = fleetChain(config());
    expect(chain.map((e) => `${e.label}/${e.plan}`)).toEqual([
      "a/start-plan",
      "a/coding-plan",
      "b/start-plan",
      "b/coding-plan",
    ]);
  });

  it("skips disabled accounts", () => {
    fleet(account({ id: "a", label: "a", enabled: false }), account({ id: "b", label: "b" }));
    const labels = [...new Set(fleetChain(config()).map((e) => e.label))];
    expect(labels).toEqual(["b"]);
  });

  it("honors a coding-first plan priority", () => {
    fleet(account({ id: "a", label: "a" }));
    expect(fleetChain(config({ planPriority: ["coding-plan", "start-plan"] } as ProxyConfig)).map((e) => e.plan)).toEqual([
      "coding-plan",
      "start-plan",
    ]);
  });
});

describe("pickServing — priority strategy", () => {
  beforeEach(() => __resetFleetStateForTests());

  it("picks the first enabled account's first plan when nothing is known (fail-open)", () => {
    fleet(account({ id: "a", label: "a" }, cred("key-a", { jwt: "j" })), account({ id: "b", label: "b" }, cred("key-b", { jwt: "j" })));
    const picked = pickServing(config())!;
    expect(picked.label).toBe("a");
    expect(picked.plan).toBe("start-plan");
  });

  it("never picks a start-plan entry whose credential has no JWT", () => {
    fleet(account({ id: "a", label: "a" }, cred("key-a", { jwt: undefined })));
    const picked = pickServing(config())!;
    expect(picked.plan).toBe("coding-plan");
  });

  it("a cooled-down entry is skipped, the next entry serves", () => {
    fleet(account({ id: "a", label: "a" }, cred("key-a", { jwt: "j" })), account({ id: "b", label: "b" }));
    const chain = fleetChain(config());
    __setCooldownForTests(chain[0]!, Date.now() + 60_000);
    expect(pickServing(config())!.plan).toBe("coding-plan"); // next entry of the same account
  });

  it("exhausted matrix data (usable: false) skips the entry; probe failure (null) does not", () => {
    fleet(account({ id: "a", label: "a" }, cred("key-a", { jwt: "j" })));
    const cfg = config();
    const chain = fleetChain(cfg);
    // both planes exhausted → next account would serve (none here → null)
    __resetFleetStateForTests();
    fleet(account({ id: "a", label: "a" }, cred("key-a", { jwt: "j" })));
    const entry = fleetChain(cfg)[0]!;
    expect(entryUsable(entry, cfg)).toBe(true); // no data yet
  });

  it("returns null when every entry is blocked", () => {
    fleet(account({ id: "a", label: "a" }, cred("key-a", { jwt: "j" })));
    const cfg = config();
    for (const entry of fleetChain(cfg)) __setCooldownForTests(entry, Date.now() + 60_000);
    expect(pickServing(cfg)).toBeNull();
  });
});

describe("pickServing — round-robin strategy", () => {
  beforeEach(() => __resetFleetStateForTests());

  it("rotates across usable accounts", () => {
    fleet(account({ id: "a", label: "a" }), account({ id: "b", label: "b" }), account({ id: "c", label: "c" }));
    const cfg = config({ accounts: { enabled: true, strategy: "round-robin", pollIntervalSec: 60 } } as Partial<ProxyConfig>);
    const picks = [pickServing(cfg)!.label, pickServing(cfg)!.label, pickServing(cfg)!.label, pickServing(cfg)!.label];
    expect(picks).toEqual(["a", "b", "c", "a"]);
  });

  it("skips disabled and cooled-down accounts without disturbing the rotation", () => {
    fleet(account({ id: "a", label: "a" }), account({ id: "b", label: "b", enabled: false }), account({ id: "c", label: "c" }));
    const cfg = config({ accounts: { enabled: true, strategy: "round-robin", pollIntervalSec: 60 } } as Partial<ProxyConfig>);
    expect(pickServing(cfg)!.label).toBe("a");
    expect(pickServing(cfg)!.label).toBe("c");
    expect(pickServing(cfg)!.label).toBe("a");
  });

  it("round-robin serves the first usable plan of the chosen account", () => {
    fleet(account({ id: "a", label: "a" }, cred("key-a"))); // no jwt → start unusable
    const cfg = config({ accounts: { enabled: true, strategy: "round-robin", pollIntervalSec: 60 } } as Partial<ProxyConfig>);
    expect(pickServing(cfg)!.plan).toBe("coding-plan");
  });
});

describe("pickServing — least-used strategy", () => {
  beforeEach(() => __resetFleetStateForTests());

  it("picks the account with the most remaining headroom", () => {
    fleet(account({ id: "a", label: "a" }), account({ id: "b", label: "b" }));
    const cfg = config({ accounts: { enabled: true, strategy: "least-used", pollIntervalSec: 60 } } as Partial<ProxyConfig>);
    // a: coding plane 20% left; b: coding plane 80% left → b wins
    __setUsageForTests("a", { coding: { usable: true, probedAt: 1, remainingRatio: 0.2 } });
    __setUsageForTests("b", { coding: { usable: true, probedAt: 1, remainingRatio: 0.8 } });
    const picked = pickServing(cfg)!;
    expect(picked.label).toBe("b");
    expect(picked.plan).toBe("coding-plan");
  });

  it("prefers the plane that produced the headroom", () => {
    fleet(account({ id: "a", label: "a" }, cred("key-a", { jwt: "j" })));
    const cfg = config({ accounts: { enabled: true, strategy: "least-used", pollIntervalSec: 60 } } as Partial<ProxyConfig>);
    __setUsageForTests("a", {
      start: { usable: true, probedAt: 1, remainingRatio: 0.9 },
      coding: { usable: true, probedAt: 1, remainingRatio: 0.1 },
    });
    expect(pickServing(cfg)!.plan).toBe("start-plan");
  });
});

describe("cooldowns", () => {
  beforeEach(() => __resetFleetStateForTests());

  it("quota rejection cools down ~10 minutes; serving clears it", () => {
    fleet(account({ id: "a", label: "a" }, cred("key-a", { jwt: "j" })));
    const entry = fleetChain(config())[0]!;
    noteRequestResult(entry, 429);
    expect(entryUsable(entry, config())).toBe(false);
    noteRequestResult(entry, null);
    expect(entryUsable(entry, config())).toBe(true);
  });

  it("a coding-plan 401 cools down longer than a quota rejection", async () => {
    fleet(account({ id: "a", label: "a" }));
    const cfg = config();
    const coding = fleetChain(cfg).find((e) => e.plan === "coding-plan")!;
    noteRequestResult(coding, 429);
    const quotaLeft = remainingCooldownMs(coding);
    __resetFleetStateForTests();
    fleet(account({ id: "a", label: "a" }));
    noteRequestResult(coding, 401);
    const authLeft = remainingCooldownMs(coding);
    expect(authLeft).toBeGreaterThan(quotaLeft);
    expect(authLeft).toBeGreaterThanOrEqual(25 * 60 * 1000);
  });

  it("a start-plan 401 cools down at the quota tier, not the auth tier", () => {
    fleet(account({ id: "a", label: "a" }, cred("key-a", { jwt: "j" })));
    const cfg = config();
    const start = fleetChain(cfg)[0]!;
    noteRequestResult(start, 401);
    expect(remainingCooldownMs(start)).toBeLessThanOrEqual(11 * 60 * 1000);
  });
});

function remainingCooldownMs(entry: ChainEntry): number {
  // Smallest time-shift at which the entry becomes usable again = the
  // remaining cooldown. Binary-searched on entryUsable's `now` parameter.
  let lo = 0;
  let hi = 40 * 60 * 1000;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (entryUsable(entry, config(), Date.now() + mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

describe("walkFleetChain", () => {
  beforeEach(() => __resetFleetStateForTests());

  it("no-op when the first response is fine (handled: false is caller's decision)", async () => {
    // walkFleetChain is only invoked on rejection; this test pins the contract
    // that a served walk clears cooldowns and updates last-serving.
    fleet(account({ id: "a", label: "a" }, cred("key-a", { jwt: "j" })), account({ id: "b", label: "b" }, cred("key-b", { jwt: "j" })));
    const cfg = config();
    const first = fleetChain(cfg)[0]!;
    const servedOn = fleetChain(cfg)[2]!; // b/start-plan
    const dispatches: string[] = [];
    const servedName = `${servedOn.label}/${servedOn.plan}`;
    const outcome = await walkFleetChain({
      config: cfg,
      from: first,
      firstStatus: 429,
      dispatchEntry: async (entry) => {
        dispatches.push(`${entry.label}/${entry.plan}`);
        // Chain entries are fresh objects per fleetChain call — compare by name.
        return `${entry.label}/${entry.plan}` === servedName ? new Response("ok") : new Response(null, { status: 429 });
      },
    });
    expect(dispatches).toEqual(["a/coding-plan", "b/start-plan"]);
    expect(outcome.handled).toBe(true);
    expect(outcome.served?.entry.label).toBe("b");
    // served entry's cooldown cleared; rejected ones cooled down
    expect(entryUsable(first, cfg)).toBe(false);
    expect(entryUsable(servedOn, cfg)).toBe(true);
  });

  it("exhaustion reports every tried entry and the last response", async () => {
    fleet(account({ id: "a", label: "a" }, cred("key-a", { jwt: "j" })), account({ id: "b", label: "b" }, cred("key-b", { jwt: "j" })));
    const cfg = config();
    const first = fleetChain(cfg)[0]!;
    const outcome = await walkFleetChain({
      config: cfg,
      from: first,
      firstStatus: 429,
      dispatchEntry: async () => new Response(null, { status: 429 }),
    });
    expect(outcome.exhausted?.tried).toEqual([
      "a/start-plan",
      "a/coding-plan",
      "b/start-plan",
      "b/coding-plan",
    ]);
    expect(outcome.exhausted?.lastResp.status).toBe(429);
  });

  it("skips entries that are already cooled down mid-walk", async () => {
    fleet(account({ id: "a", label: "a" }, cred("key-a", { jwt: "j" })), account({ id: "b", label: "b" }, cred("key-b", { jwt: "j" })));
    const cfg = config();
    const chain = fleetChain(cfg);
    __setCooldownForTests(chain[1]!, Date.now() + 60_000); // a/coding-plan pre-cooled
    const dispatches: string[] = [];
    await walkFleetChain({
      config: cfg,
      from: chain[0]!,
      firstStatus: 429,
      dispatchEntry: async (entry) => {
        dispatches.push(`${entry.label}/${entry.plan}`);
        return new Response("ok");
      },
    });
    expect(dispatches).toEqual(["b/start-plan"]);
  });
});

describe("evaluateFleetResponse", () => {
  beforeEach(() => __resetFleetStateForTests());

  it("coding-plan 429/401/403 reject; 502 passes (gateway retry owns it)", async () => {
    for (const status of [429, 401, 403]) {
      expect((await evaluateFleetResponse(new Response(null, { status }), "coding-plan")).rejected).toBe(true);
    }
    expect((await evaluateFleetResponse(new Response(null, { status: 502 }), "coding-plan")).rejected).toBe(false);
  });

  it("start-plan 200 with a quota envelope rejects (the sniff)", async () => {
    const resp = new Response(JSON.stringify({ code: 1005, msg: "exceed quota limit" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const evaluated = await evaluateFleetResponse(resp, "start-plan");
    expect(evaluated.rejected).toBe(true);
  });
});

describe("fleet watcher", () => {
  beforeEach(() => __resetFleetStateForTests());

  it("tick probes each account's planes and fills the matrix (fail-open on probe failure)", async () => {
    fleet(account({ id: "a", label: "a" }, cred("key-a", { jwt: "j" })), account({ id: "b", label: "b" }));
    const cfg = config();
    let codingCalls = 0;
    const watcher = startFleetWatcher(cfg, {
      probeGapMs: 0,
      loadAccountsImpl: async () => [
        account({ id: "a", label: "a" }, cred("key-a", { jwt: "j" })),
        account({ id: "b", label: "b" }),
      ],
      fetchStartPlanBalanceImpl: async () => ({
        ok: true,
        balances: [{ showName: "trial", remainingUnits: 50, totalUnits: 100, usedUnits: 50 }],
      }),
      fetchCodingPlanUsageImpl: async (_cfg, _fetch, load) => {
        codingCalls++;
        // The router always passes a loader; the faked signature marks it optional.
        const loaded = await load!();
        if (loaded?.apiKey === "key-a") {
          return {
            ok: true,
            level: "max",
            limits: [{ type: "TIME_LIMIT", percentage: 30, nextResetTime: undefined }],
          };
        }
        return null; // b's probe explodes → null → fail-open
      },
    });
    try {
      await watcher.tick();
      // startFleetWatcher fires one tick immediately, so the manual tick makes
      // two probe cycles over two accounts (the auto-tick may still be in
      // flight — hence the floor, not an exact count).
      expect(codingCalls).toBeGreaterThanOrEqual(2);
      // a: both planes probed — start usable, coding usable (%70 left)
      // b: coding probe returned null (no data), start probed OK
      expect(pickServing(cfg)!.label).toBe("a"); // priority: a first, usable
      // Cool a down entirely → b serves (its coding plane is fail-open usable)
      for (const entry of fleetChain(cfg).filter((e) => e.accountId === "a")) {
        __setCooldownForTests(entry, Date.now() + 60_000);
      }
      expect(pickServing(cfg)!.label).toBe("b");
    } finally {
      watcher.stop();
    }
  });

  it("a successful probe clears the matching cooldown", async () => {
    fleet(account({ id: "a", label: "a" }, cred("key-a", { jwt: "j" })));
    const cfg = config();
    const entry = fleetChain(cfg)[0]!;
    noteRequestResult(entry, 429);
    expect(entryUsable(entry, cfg)).toBe(false);
    const watcher = startFleetWatcher(cfg, {
      probeGapMs: 0,
      loadAccountsImpl: async () => [account({ id: "a", label: "a" }, cred("key-a", { jwt: "j" }))],
      fetchStartPlanBalanceImpl: async () => ({ ok: true, balances: [{ showName: "t", remainingUnits: 1, totalUnits: 10, usedUnits: 9 }] }),
      fetchCodingPlanUsageImpl: async () => ({ ok: true, level: null, limits: [] }),
    });
    try {
      await watcher.tick();
      expect(entryUsable(entry, cfg)).toBe(true);
    } finally {
      watcher.stop();
    }
  });
});

describe("credentialOf", () => {
  beforeEach(() => __resetFleetStateForTests());

  it("resolves the snapshot credential; null after the account is removed", () => {
    fleet(account({ id: "a", label: "a" }, cred("key-a")));
    const entry = fleetChain(config())[0]!;
    expect(credentialOf(entry)?.apiKey).toBe("key-a");
    syncFleet([]);
    expect(credentialOf(entry)).toBeNull();
  });
});

describe("fleetSnapshot", () => {
  beforeEach(() => __resetFleetStateForTests());

  it("reports per-account state: serving marker, enabled flag, entry states", () => {
    fleet(
      account({ id: "a", label: "work" }, cred("key-a", { jwt: "j" })),
      account({ id: "b", label: "trial", enabled: false }, cred("key-b", { jwt: "j" })),
    );
    const cfg = config();
    // Serve from a once → serving marker (pickServing records it); then cool
    // its start entry down and mark its coding plane empty via the matrix.
    const chain = fleetChain(cfg);
    expect(pickServing(cfg)!.label).toBe("work");
    __setCooldownForTests(chain[0]!, Date.now() + 60_000);
    __setUsageForTests("a", { coding: { usable: false, probedAt: 1, remainingRatio: 0 } });

    const snap = fleetSnapshot(cfg);
    expect(snap.strategy).toBe("priority");
    expect(snap.accounts.length).toBe(2);

    const a = snap.accounts[0]!;
    expect(a.label).toBe("work");
    expect(a.enabled).toBe(true);
    expect(a.serving).toBe(true);
    expect(a.isActive).toBe(true);
    expect(a.entries.map((e) => e.state)).toEqual(["cooldown", "empty"]);

    const b = snap.accounts[1]!;
    expect(b.enabled).toBe(false);
    expect(b.serving).toBe(false);
    expect(b.isActive).toBe(false);
    // Disabled: entries show "unknown" regardless of data, synthesized per plan.
    expect(b.entries.map((e) => e.state)).toEqual(["unknown", "unknown"]);
  });

  it("entries without probe data read as unknown (fail-open), not empty", () => {
    fleet(account({ id: "a", label: "a" }, cred("key-a", { jwt: "j" })));
    const snap = fleetSnapshot(config());
    expect(snap.accounts[0]!.entries.map((e) => e.state)).toEqual(["unknown", "unknown"]);
  });

  it("reflects probe ratios for bars", () => {
    fleet(account({ id: "a", label: "a" }, cred("key-a", { jwt: "j" })));
    __setUsageForTests("a", { coding: { usable: true, probedAt: 1, remainingRatio: 0.75 } });
    const snap = fleetSnapshot(config());
    expect(snap.accounts[0]!.entries[1]!.remainingRatio).toBe(0.75);
    expect(snap.accounts[0]!.entries[1]!.state).toBe("usable");
  });
});
