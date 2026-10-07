/**
 * Tests for the multi-account encrypted store.
 *
 * Same isolation discipline as ../auth/store.test.ts: every test runs against
 * a fresh temp store dir; the hooks must NEVER touch the real ~/.zcode-proxy.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  loadAccounts,
  activeAccountOf,
  addAccount,
  removeAccount,
  removeActiveAccount,
  setAccountEnabled,
  renameAccount,
  setPinnedAccount,
  getPinnedAccountId,
  getAccountsStorePath,
} from "./store.js";
import { loadCredential, saveCredential, clearCredential, getStorePath } from "../auth/store.js";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "../auth/types.js";

const TEST_SECRET = "test-encryption-secret-for-zcode-proxy";

function useTempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-accounts-test-"));
  process.env.ZCODE_PROXY_STORE_DIR = dir;
  process.env.ZCODE_PROXY_CREDENTIAL_SECRET = TEST_SECRET;
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

describe("accounts store — basics", () => {
  let dir: string;
  beforeEach(() => { dir = useTempStore(); });
  afterEach(() => dropTempStore(dir));

  it("empty store loads as no accounts", async () => {
    expect(await loadAccounts()).toEqual([]);
  });

  it("add → load roundtrip preserves credential and metadata", async () => {
    const { account } = await addAccount(cred("key-1", { secret: "s1", userId: "u1" }));
    expect(account.label).toBe("zai");
    expect(account.enabled).toBe(true);

    const loaded = await loadAccounts();
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.credential.apiKey).toBe("key-1");
    expect(loaded[0]!.credential.secret).toBe("s1");
    expect(loaded[0]!.credential.userId).toBe("u1");
    expect(loaded[0]!.label).toBe("zai");
    expect(loaded[0]!.id).toBe(account.id);
  });

  it("labels auto-suffix per provider: zai, zai-2, zai-3", async () => {
    await addAccount(cred("key-1"));
    await addAccount(cred("key-2"));
    await addAccount(cred("key-3"));
    const labels = (await loadAccounts()).map((a) => a.label);
    expect(labels).toEqual(["zai", "zai-2", "zai-3"]);
  });

  it("new accounts append: store order is priority, active stays first", async () => {
    await addAccount(cred("key-1"));
    await addAccount(cred("key-2"));
    const accounts = await loadAccounts();
    expect(activeAccountOf(accounts)!.credential.apiKey).toBe("key-1");
  });

  it("re-login of the same account (userId match) refreshes in place, keeps label", async () => {
    await addAccount(cred("key-old", { userId: "u1" }), { label: "work" });
    const { updatedExisting, account, total } = await addAccount(
      cred("key-new", { userId: "u1" }),
    );
    expect(updatedExisting).toBe(true);
    expect(total).toBe(1);
    expect(account.label).toBe("work");

    const loaded = await loadAccounts();
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.credential.apiKey).toBe("key-new");
    expect(loaded[0]!.label).toBe("work");
  });

  it("re-login matching by apiKey when userIds are absent", async () => {
    await addAccount(cred("same-key"));
    const { updatedExisting, total } = await addAccount(cred("same-key"));
    expect(updatedExisting).toBe(true);
    expect(total).toBe(1);
  });

  it("different userIds never match even with no apiKey equality", async () => {
    await addAccount(cred("key-1", { userId: "u1" }));
    await addAccount(cred("key-1", { userId: "u2" }));
    expect((await loadAccounts()).length).toBe(2);
  });

  it("explicit label is honored and kept unique", async () => {
    await addAccount(cred("key-1"), { label: "burner" });
    await addAccount(cred("key-2"), { label: "burner" });
    const labels = (await loadAccounts()).map((a) => a.label);
    expect(labels).toEqual(["burner", "burner-2"]);
  });
});

describe("accounts store — mutation", () => {
  let dir: string;
  beforeEach(() => { dir = useTempStore(); });
  afterEach(() => dropTempStore(dir));

  async function seedTwo(): Promise<void> {
    await addAccount(cred("key-1"), { label: "work" });
    await addAccount(cred("key-2", { provider: "bigmodel" }), { label: "trial" });
  }

  it("removeAccount by label (case-insensitive)", async () => {
    await seedTwo();
    const res = await removeAccount("WORK");
    expect(res.ok).toBe(true);
    expect(res.total).toBe(1);
    expect((await loadAccounts()).map((a) => a.label)).toEqual(["trial"]);
  });

  it("removeAccount by id", async () => {
    await seedTwo();
    const [first] = await loadAccounts();
    const res = await removeAccount(first!.id);
    expect(res.ok).toBe(true);
    expect((await loadAccounts()).map((a) => a.label)).toEqual(["trial"]);
  });

  it("removeAccount of unknown label fails with a reason", async () => {
    await seedTwo();
    const res = await removeAccount("nope");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("nope");
  });

  it("removeActiveAccount removes the first enabled account", async () => {
    await seedTwo();
    const res = await removeActiveAccount();
    expect(res.ok).toBe(true);
    expect(res.account?.label).toBe("work");
    const accounts = await loadAccounts();
    expect(activeAccountOf(accounts)!.label).toBe("trial");
  });

  it("disable skips an account in active selection", async () => {
    await seedTwo();
    await setAccountEnabled("work", false);
    const accounts = await loadAccounts();
    expect(accounts.length).toBe(2);
    expect(activeAccountOf(accounts)!.label).toBe("trial");
    expect(accounts.find((a) => a.label === "work")!.enabled).toBe(false);
  });

  it("all-disabled store has no active account", async () => {
    await seedTwo();
    await setAccountEnabled("work", false);
    await setAccountEnabled("trial", false);
    expect(activeAccountOf(await loadAccounts())).toBeNull();
  });

  it("rename enforces unique labels", async () => {
    await seedTwo();
    const ok = await renameAccount("work", "trial");
    expect(ok.ok).toBe(false);
    expect(ok.error).toContain("already in use");

    const fine = await renameAccount("work", "main");
    expect(fine.ok).toBe(true);
    expect((await loadAccounts()).map((a) => a.label)).toEqual(["main", "trial"]);
  });

  it("empty rename is rejected", async () => {
    await seedTwo();
    const res = await renameAccount("work", "   ");
    expect(res.ok).toBe(false);
  });

  it("corrupt accounts.json loads as empty with no throw", async () => {
    await seedTwo();
    writeFileSync(getAccountsStorePath(), "{ not json", "utf-8");
    expect(await loadAccounts()).toEqual([]);
  });
});

describe("auth/store shim over the accounts store", () => {
  let dir: string;
  beforeEach(() => { dir = useTempStore(); });
  afterEach(() => dropTempStore(dir));

  it("saveCredential + loadCredential work through the fleet store (compat)", async () => {
    await saveCredential(cred("compat-key", { secret: "s" }));
    const loaded = await loadCredential();
    expect(loaded).not.toBeNull();
    expect(loaded!.apiKey).toBe("compat-key");
    expect(loaded!.secret).toBe("s");
  });

  it("saveCredential twice with the same account refreshes, not duplicates", async () => {
    await saveCredential(cred("k", { userId: "u1" }));
    await saveCredential(cred("k2", { userId: "u1" }));
    expect((await loadAccounts()).length).toBe(1);
    expect((await loadCredential())!.apiKey).toBe("k2");
  });

  it("legacy credentials.json migrates into accounts.json as 'default', legacy file kept", async () => {
    // Write a legacy single-credential file under the CURRENT KDF (the XOR
    // fallback path is covered by ../auth/store.test.ts).
    const { getEncryptionKey, encryptWith } = await import("../auth/crypto.js");
    const encrypted = await encryptWith(getEncryptionKey(), JSON.stringify(cred("legacy-key")));
    writeFileSync(getStorePath(), JSON.stringify({ encrypted }), "utf-8");

    const loaded = await loadCredential();
    expect(loaded).not.toBeNull();
    expect(loaded!.apiKey).toBe("legacy-key");

    // Migration landed: one account labeled "default", legacy file untouched.
    const accounts = await loadAccounts();
    expect(accounts.length).toBe(1);
    expect(accounts[0]!.label).toBe("default");
    expect(JSON.parse(readFileSync(getStorePath(), "utf-8")).encrypted).toBe(encrypted);

    // Second load reads the accounts store (legacy path no longer consulted).
    expect((await loadCredential())!.apiKey).toBe("legacy-key");
  });

  it("clearCredential removes the active account; the next one takes over", async () => {
    await saveCredential(cred("k1"));
    await saveCredential(cred("k2", { userId: "u2" }));
    clearCredential();
    expect((await loadCredential())!.apiKey).toBe("k2");
  });

  it("clearCredential with a single account is a full logout", async () => {
    await saveCredential(cred("only"));
    clearCredential();
    expect(await loadCredential()).toBeNull();
  });

  it("undecryptable account row (foreign secret) is skipped, others serve", async () => {
    await saveCredential(cred("good"));
    // Re-encrypt the stored row under a DIFFERENT secret.
    const raw = JSON.parse(readFileSync(getAccountsStorePath(), "utf-8"));
    const saved = process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "another-secret";
    const { getEncryptionKey, encryptWith } = await import("../auth/crypto.js");
    raw.accounts[0].encrypted = await encryptWith(getEncryptionKey(), JSON.stringify(cred("bad")));
    writeFileSync(getAccountsStorePath(), JSON.stringify(raw), "utf-8");
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = saved;

    expect(await loadCredential()).toBeNull();
  });
});

describe("accounts store — pinning (PLAN §9.2)", () => {
  let dir: string;
  beforeEach(() => { dir = useTempStore(); });
  afterEach(() => dropTempStore(dir));

  it("setPinnedAccount by label → getPinnedAccountId roundtrips; auto clears", async () => {
    await addAccount(cred("k1"), { label: "work" });
    await addAccount(cred("k2", { userId: "u2" }), { label: "trial" });

    expect(getPinnedAccountId()).toBeNull();
    const pin = setPinnedAccount("trial");
    expect(pin.ok).toBe(true);
    expect(getPinnedAccountId()).toBe((await loadAccounts()).find((a) => a.label === "trial")!.id);

    setPinnedAccount(null);
    expect(getPinnedAccountId()).toBeNull();
  });

  it("a pin naming a removed account reads as no pin", async () => {
    await addAccount(cred("k1"), { label: "work" });
    setPinnedAccount("work");
    await removeAccount("work");
    expect(getPinnedAccountId()).toBeNull();
  });

  it("unknown label fails with a reason", async () => {
    await addAccount(cred("k1"), { label: "work" });
    const res = setPinnedAccount("nope");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("nope");
  });
});
