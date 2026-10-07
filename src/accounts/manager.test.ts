/**
 * Tests for the account manager: active-account selection and the event
 * stream the router/TUI/panel will subscribe to.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AccountManager, type AccountEvent } from "./manager.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "../auth/types.js";

function useTempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-manager-test-"));
  process.env.ZCODE_PROXY_STORE_DIR = dir;
  process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "manager-test-secret";
  return dir;
}

function dropTempStore(dir: string): void {
  delete process.env.ZCODE_PROXY_STORE_DIR;
  delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  rmSync(dir, { recursive: true, force: true });
}

function cred(apiKey: string, extra: Partial<Credential> = {}): Credential {
  return { apiKey, provider: "zai", ...extra };
}

describe("account manager", () => {
  let dir: string;
  beforeEach(() => { dir = useTempStore(); });
  afterEach(() => dropTempStore(dir));

  it("getActiveCredential throws with a login hint on an empty fleet", async () => {
    const manager = new AccountManager();
    await expect(manager.getActiveCredential()).rejects.toThrow("auth login");
  });

  it("active account is the first enabled account in store order", async () => {
    const manager = new AccountManager();
    await manager.add(cred("k1"), { label: "work" });
    await manager.add(cred("k2"), { label: "trial" });
    expect((await manager.getActiveCredential()).apiKey).toBe("k1");
  });

  it("disabling the active account promotes the next one", async () => {
    const manager = new AccountManager();
    await manager.add(cred("k1"), { label: "work" });
    await manager.add(cred("k2"), { label: "trial" });
    await manager.setEnabled("work", false);
    expect((await manager.getActiveCredential()).apiKey).toBe("k2");
  });

  it("events fire for the fleet lifecycle", async () => {
    const manager = new AccountManager();
    const events: AccountEvent[] = [];
    const unsubscribe = manager.subscribe((e) => events.push(e));

    await manager.add(cred("k1"), { label: "work" });
    await manager.add(cred("k2"), { label: "trial" });
    await manager.setEnabled("work", false);
    await manager.rename("trial", "backup");
    await manager.removeActive(); // removes "trial"/"backup" (work disabled)

    unsubscribe();
    await manager.add(cred("k3"), { label: "solo" });

    expect(events.map((e) => e.type)).toEqual([
      "added",
      "added",
      "disabled",
      "renamed",
      "removed",
    ]);
    const removed = events[4]!;
    expect(removed.type === "removed" && removed.wasActive).toBe(true);
  });

  it("subscribe's unsubscribe stops delivery", async () => {
    const manager = new AccountManager();
    let fired = 0;
    const unsubscribe = manager.subscribe(() => fired++);
    await manager.add(cred("k1"));
    unsubscribe();
    await manager.add(cred("k2"));
    expect(fired).toBe(1);
  });

  it("a throwing listener does not break the mutation or other listeners", async () => {
    const manager = new AccountManager();
    let second = 0;
    manager.subscribe(() => { throw new Error("listener bug"); });
    manager.subscribe(() => second++);
    await manager.add(cred("k1"));
    expect(second).toBe(1);
    expect((await manager.list()).length).toBe(1);
  });
});
