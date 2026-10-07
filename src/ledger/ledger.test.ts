/**
 * Tests for the local usage ledger: append/read roundtrip, day filtering,
 * aggregates, per-key counting, rotation. Isolation via ZCODE_USAGE_LOG —
 * the ledger is a no-op under bun:test without it (mirrors error-log tests).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  appendUsage,
  readUsage,
  readUsageDays,
  summarizeUsage,
  countTodayForKey,
  usageLogPath,
  localDayKey,
  rotateUsageLogIfNeeded,
  __resetUsageLogForTests,
  type UsageEntry,
} from "./ledger.js";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zcode-ledger-test-"));
  process.env.ZCODE_USAGE_LOG = join(dir, "usage.log");
  __resetUsageLogForTests();
});

afterEach(() => {
  delete process.env.ZCODE_USAGE_LOG;
  __resetUsageLogForTests();
  rmSync(dir, { recursive: true, force: true });
});

function entry(overrides: Partial<UsageEntry> = {}): Omit<UsageEntry, "ts" | "day"> {
  return {
    reqId: "t-#001",
    format: "ANT",
    model: "glm-5.3",
    stream: false,
    status: 200,
    tokens: 100,
    ttfbMs: 120,
    ...overrides,
  };
}

describe("usage ledger", () => {
  it("append → read roundtrip preserves fields and adds ts/day", () => {
    appendUsage(entry({ account: "work", keyLabel: "claude-code", tool: "claude-cli/2.0" }));
    const all = readUsage();
    expect(all.length).toBe(1);
    expect(all[0]!.model).toBe("glm-5.3");
    expect(all[0]!.account).toBe("work");
    expect(all[0]!.keyLabel).toBe("claude-code");
    expect(all[0]!.day).toBe(localDayKey());
    expect(all[0]!.ts).toContain(new Date().getFullYear().toString());
  });

  it("malformed lines are skipped on read", () => {
    appendUsage(entry());
    const { appendFileSync } = require("node:fs");
    appendFileSync(usageLogPath(), "{ broken json\n", "utf-8");
    expect(readUsage().length).toBe(1);
  });

  it("readUsageDays filters by local day window", () => {
    appendUsage(entry({ reqId: "today" }));
    // Hand-write an old entry (3 days ago) with the same schema.
    const old = new Date(Date.now() - 3 * 86400_000);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const oldDay = `${old.getFullYear()}-${pad(old.getMonth() + 1)}-${pad(old.getDate())}`;
    const { appendFileSync } = require("node:fs");
    appendFileSync(usageLogPath(), JSON.stringify({ ts: oldDay, day: oldDay, reqId: "old", format: "ANT", model: "m", stream: false, status: 200, tokens: 5, ttfbMs: 1 }) + "\n", "utf-8");

    expect(readUsage().length).toBe(2);
    expect(readUsageDays(1).map((e) => e.reqId)).toEqual(["today"]);
    expect(readUsageDays(7).length).toBe(2);
  });

  it("summarizeUsage aggregates by day/tool/account/model/key", () => {
    appendUsage(entry({ tokens: 10, keyLabel: "k1", tool: "claude-cli", account: "work", model: "glm-5.3" }));
    appendUsage(entry({ tokens: 20, keyLabel: "k1", tool: "claude-cli", account: "work", model: "glm-5.3" }));
    appendUsage(entry({ tokens: 40, status: 429, keyLabel: "k2", tool: "codex", account: "trial", model: "glm-4.6" }));

    const summary = summarizeUsage(readUsage(), 7);
    expect(summary.totalRequests).toBe(3);
    expect(summary.totalTokens).toBe(70);
    expect(summary.failedRequests).toBe(1);
    expect(summary.byTool[0]!.name).toBe("claude-cli");
    expect(summary.byTool[0]!.requests).toBe(2);
    expect(summary.byAccount.map((a) => a.name)).toEqual(["work", "trial"]);
    expect(summary.byKey[0]!.name).toBe("k1");
    expect(summary.byModel[0]!.tokens).toBe(30);
  });

  it("countTodayForKey counts only today's entries for the given key id", () => {
    appendUsage(entry({ reqId: "1" }));
    const all = readUsage();
    const keyId = all[0]!.reqId; // reuse as a fake key id
    // Append a second entry that carries keyId.
    appendUsage(entry({ reqId: "2" }));
    const lines = readUsage();
    // Manually tag both with the key id via a fresh append (appendUsage without keyId can't carry it — write directly).
    const { writeFileSync } = require("node:fs");
    const tagged = lines.map((e, i) => ({ ...e, keyId: i === 0 ? keyId : undefined }));
    writeFileSync(usageLogPath(), tagged.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    const counts = countTodayForKey(keyId);
    expect(counts.requests).toBe(1);
  });

  it("rotation moves an oversized file to .1; reads include both generations", () => {
    writeFileSync(usageLogPath(), "x".repeat(64) + "\n", "utf-8");
    rotateUsageLogIfNeeded(usageLogPath(), 32);
    expect(statSync(`${usageLogPath()}.1`).size).toBe(65);
    appendUsage(entry());
    expect(readUsage().length).toBe(1); // from the fresh file
    const { appendFileSync } = require("node:fs");
    appendFileSync(`${usageLogPath()}.1`, JSON.stringify({ ts: "x", day: localDayKey(), reqId: "rot", format: "ANT", model: "m", stream: false, status: 200, tokens: 1, ttfbMs: 1 }) + "\n", "utf-8");
    expect(readUsage().length).toBe(2); // both generations read
  });
});

describe("usage ledger — read cache", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zcode-ledger-cache-"));
    process.env.ZCODE_USAGE_LOG = join(dir, "usage.log");
    __resetUsageLogForTests();
  });

  afterEach(() => {
    delete process.env.ZCODE_USAGE_LOG;
    __resetUsageLogForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it("repeated reads with an unchanged file hit the cache; appends show up immediately", () => {
    appendUsage(entry({ reqId: "one" }));
    expect(readUsage().length).toBe(1);
    // Same content again → cache path returns the same data (reference-stable).
    expect(readUsage().length).toBe(1);
    appendUsage(entry({ reqId: "two" }));
    expect(readUsage().length).toBe(2); // append invalidates the cache
  });

  it("an EXTERNAL file change (new mtime) is picked up without an append", () => {
    appendUsage(entry({ reqId: "one" }));
    readUsage();
    const { appendFileSync } = require("node:fs");
    // Simulate another process appending (no appendUsage call → no counter bump).
    appendFileSync(usageLogPath(), JSON.stringify({ ts: "x", day: localDayKey(), reqId: "external", format: "ANT", model: "m", stream: false, status: 200, tokens: 1, ttfbMs: 1 }) + "\n", "utf-8");
    const all = readUsage();
    expect(all.map((e) => e.reqId)).toContain("external");
  });
});
