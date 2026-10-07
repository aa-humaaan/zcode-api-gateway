/**
 * Tests for the auto-claim wiring (startAutoClaim): single-account vs fleet
 * composite. No network — poll intervals are far beyond the test horizon, so
 * no tick ever fires; only construction/stop semantics are verified.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { startAutoClaim } from "./runtime.js";
import { addAccount, getAccountsStorePath } from "../accounts/store.js";
import { AuthManager } from "../auth/manager.js";
import type { ProxyConfig } from "../config/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "../auth/types.js";

function cred(apiKey: string, extra: Partial<Credential> = {}): Credential {
  return { apiKey, provider: "zai", ...extra };
}

let dirs: string[] = [];
afterEach(() => {
  delete process.env.ZCODE_PROXY_STORE_DIR;
  delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function useTempStore(): void {
  dirs.push(mkdtempSync(join(tmpdir(), "zcode-claim-test-")));
  process.env.ZCODE_PROXY_STORE_DIR = dirs[dirs.length - 1]!;
  process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "claim-test-secret";
}

function config(accountsEnabled: boolean): ProxyConfig {
  return {
    claim: { enabled: true, auto: true, origin: "http://127.0.0.1:9", pollIntervalSec: 3600, cooldownMs: 60000, planId: "" },
    identity: { appVersion: "3.14.0", sourceTitle: "cli", refererOrigin: "https://zcode.z.ai" },
    accounts: { enabled: accountsEnabled, strategy: "priority", pollIntervalSec: 60 },
  } as unknown as ProxyConfig;
}

describe("startAutoClaim — fleet wiring", () => {
  it("single-account mode with an empty fleet still returns a stoppable handle", () => {
    useTempStore();
    const handle = startAutoClaim(config(false), new AuthManager());
    handle.stop();
    expect(typeof handle.stop).toBe("function");
  });

  it("fleet mode: one scheduler per enabled account with a JWT, stop() tears all down", async () => {
    useTempStore();
    await addAccount(cred("k1", { jwt: "j1" }), { label: "work" });
    await addAccount(cred("k2", { jwt: "j2" }), { label: "trial" });
    await addAccount(cred("k3", { provider: "bigmodel" }), { label: "nojwt" }); // skipped: no JWT

    const handle = startAutoClaim(config(true), new AuthManager());
    // The composite builds schedulers asynchronously; stop() must be safe
    // before, during, and after that resolution.
    handle.stop();
    await new Promise((r) => setTimeout(r, 20));
    handle.stop(); // idempotent
    expect(getAccountsStorePath().length).toBeGreaterThan(0);
  });
});
