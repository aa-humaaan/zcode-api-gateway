/**
 * Tests for the virtual key store: issue/list/remove, hash-only storage,
 * caps and model allowlist admission against ledger counts.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  addKey,
  listKeys,
  removeKey,
  setKeyDisabled,
  hasAnyKeys,
  admitRequest,
  type VirtualKey,
} from "./keys.js";
import { appendUsage, __resetUsageLogForTests } from "../ledger/ledger.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zcode-keys-test-"));
  process.env.ZCODE_PROXY_STORE_DIR = dir;
  process.env.ZCODE_USAGE_LOG = join(dir, "usage.log");
  process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "keys-test-secret";
  __resetUsageLogForTests();
});

afterEach(() => {
  delete process.env.ZCODE_PROXY_STORE_DIR;
  delete process.env.ZCODE_USAGE_LOG;
  delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  __resetUsageLogForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("virtual key store", () => {
  it("add → list; the full key is returned once and never stored", () => {
    const result = addKey({ label: "claude-code" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const issued = result.issued;
    expect(issued.fullKey.startsWith("zk-")).toBe(true);
    expect(issued.fullKey.length).toBeGreaterThan(30);

    const keys = listKeys();
    expect(keys.length).toBe(1);
    expect(keys[0]!.label).toBe("claude-code");
    expect(keys[0]!.prefix).toBe(issued.fullKey.slice(0, 11));
    // The store file must not contain the full key anywhere.
    const raw = readFileSync(join(dir, "api-keys.json"), "utf-8");
    expect(raw).not.toContain(issued.fullKey);
  });

  it("labels are unique and empty labels are rejected", () => {
    addKey({ label: "a" });
    expect(addKey({ label: "A" }).ok).toBe(false);
    expect(addKey({ label: "  " }).ok).toBe(false);
  });

  it("remove + disable by label", () => {
    addKey({ label: "work" });
    expect(setKeyDisabled("work", true).ok).toBe(true);
    expect(listKeys()[0]!.disabled).toBe(true);
    expect(setKeyDisabled("work", false).ok).toBe(true);
    expect(listKeys()[0]!.disabled).toBeUndefined();
    expect(hasAnyKeys()).toBe(true);
    expect(removeKey("work").ok).toBe(true);
    expect(hasAnyKeys()).toBe(false);
  });

  it("admission: disabled key refused with 401", () => {
    addKey({ label: "k" });
    const entry = listKeys()[0]!;
    expect(admitRequest(entry, "glm-5.3").ok).toBe(true);
    setKeyDisabled("k", true);
    const disabled = listKeys()[0]!;
    const verdict = admitRequest(disabled, "glm-5.3");
    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBe(401);
  });

  it("admission: model allowlist refused with 403", () => {
    addKey({ label: "k", models: ["glm-4.6"] });
    const entry = listKeys()[0]!;
    expect(admitRequest(entry, "glm-4.6").ok).toBe(true);
    const verdict = admitRequest(entry, "glm-5.3");
    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBe(403);
  });

  it("admission: request cap hits from today's ledger counts (429)", () => {
    addKey({ label: "k", requestsPerDay: 2 });
    const entry = listKeys()[0]!;
    expect(admitRequest(entry, "m").ok).toBe(true);
    appendUsage({ reqId: "1", format: "ANT", model: "m", stream: false, status: 200, tokens: 10, ttfbMs: 1, keyId: entry.id, keyLabel: "k" });
    expect(admitRequest(entry, "m").ok).toBe(true); // 1 of 2
    appendUsage({ reqId: "2", format: "ANT", model: "m", stream: false, status: 200, tokens: 10, ttfbMs: 1, keyId: entry.id, keyLabel: "k" });
    const verdict = admitRequest(entry, "m");
    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBe(429);
  });

  it("admission: token cap hits from today's ledger tokens (429)", () => {
    addKey({ label: "k", tokensPerDay: 100 });
    const entry = listKeys()[0]!;
    appendUsage({ reqId: "1", format: "ANT", model: "m", stream: false, status: 200, tokens: 150, ttfbMs: 1, keyId: entry.id, keyLabel: "k" });
    const verdict = admitRequest(entry, "m");
    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBe(429);
  });

  it("admission ignores other keys' usage and uncapped keys pass with heavy usage", () => {
    addKey({ label: "capped", requestsPerDay: 1 });
    addKey({ label: "free" });
    const capped = listKeys()[0]!;
    const free = listKeys()[1]!;
    appendUsage({ reqId: "1", format: "ANT", model: "m", stream: false, status: 200, tokens: 10, ttfbMs: 1, keyId: free.id, keyLabel: "free" });
    expect(admitRequest(capped, "m").ok).toBe(true); // other key's usage doesn't count
    expect(admitRequest(free, "m").ok).toBe(true); // no caps → unlimited
  });
});
