/**
 * Account manager — the fleet-level companion of ../auth/manager.ts.
 *
 * Where AuthManager holds ONE in-memory credential slot (and stays in place
 * for the request paths), AccountManager is the account-fleet API the CLI,
 * panel and — from the router milestone on — the failover engine drive:
 * list/add/remove/enable/rename plus an event stream so watchers and UIs can
 * refresh themselves when the fleet changes underneath them (e.g. the serve
 * panel logs a second account in while the proxy keeps running).
 *
 * Every operation goes straight to the store (../accounts/store.ts): the file
 * is tiny, always local, and the source of truth — no in-memory fleet cache
 * to invalidate. Mirrors the AuthManager error style: getters throw with a
 * run-this-next hint instead of returning null, so callers stay linear.
 */
import type { Credential } from "../auth/types.js";
import {
  loadAccounts,
  activeAccountOf,
  addAccount,
  removeAccount,
  removeActiveAccount,
  setAccountEnabled,
  renameAccount,
  type Account,
  type AddAccountResult,
  type MutateResult,
} from "./store.js";

/** Fleet change notifications (see {@link AccountManager.subscribe}). */
export type AccountEvent =
  | { type: "added"; account: Account; total: number }
  | { type: "refreshed"; account: Account; total: number }
  | { type: "removed"; account: Account | undefined; total: number; wasActive: boolean }
  | { type: "enabled"; account: Account; total: number }
  | { type: "disabled"; account: Account; total: number }
  | { type: "renamed"; account: Account; total: number };

export type AccountEventListener = (event: AccountEvent) => void;

export class AccountManager {
  private readonly listeners = new Set<AccountEventListener>();

  /** All accounts in serving order. Never throws; unusable rows are skipped by the store. */
  async list(): Promise<Account[]> {
    return loadAccounts();
  }

  /** The account serving requests right now (first enabled in store order). */
  async getActive(): Promise<Account | null> {
    return activeAccountOf(await loadAccounts());
  }

  /**
   * The active account's credential — the fleet-shaped twin of
   * AuthManager.getCredential. Throws with the same actionable tone when the
   * fleet is empty, so router-side callers can surface "log in first".
   */
  async getActiveCredential(): Promise<Credential> {
    const active = await this.getActive();
    if (!active) {
      throw new Error(
        "No enabled account — run: zcode-proxy auth login <zai|bigmodel> (or enable one: zcode-proxy accounts enable <label>)",
      );
    }
    return active.credential;
  }

  /** Add an account, or refresh the matching entry on re-login. Emits `added`/`refreshed`. */
  async add(cred: Credential, opts: { label?: string } = {}): Promise<AddAccountResult> {
    const result = await addAccount(cred, opts);
    this.emit(
      result.updatedExisting
        ? { type: "refreshed", account: result.account, total: result.total }
        : { type: "added", account: result.account, total: result.total },
    );
    return result;
  }

  /** Remove one account by label or id. Emits `removed` (with `wasActive`) on success. */
  async remove(ref: string): Promise<MutateResult> {
    const before = await this.getActive();
    const result = await removeAccount(ref);
    if (result.ok) {
      this.emit({
        type: "removed",
        account: result.account,
        total: result.total,
        wasActive: before !== null && result.account !== undefined && before.id === result.account.id,
      });
    }
    return result;
  }

  /** Remove the ACTIVE account (what `auth logout` maps onto). Emits `removed`. */
  async removeActive(): Promise<MutateResult> {
    const result = await removeActiveAccount();
    if (result.ok) {
      this.emit({
        type: "removed",
        account: result.account,
        total: result.total,
        wasActive: true,
      });
    }
    return result;
  }

  /** Enable/disable an account. Emits `enabled`/`disabled` on success. */
  async setEnabled(ref: string, enabled: boolean): Promise<MutateResult> {
    const result = await setAccountEnabled(ref, enabled);
    if (result.ok && result.account) {
      this.emit(
        enabled
          ? { type: "enabled", account: result.account, total: result.total }
          : { type: "disabled", account: result.account, total: result.total },
      );
    }
    return result;
  }

  /** Rename an account (labels stay unique). Emits `renamed` on success. */
  async rename(ref: string, newLabel: string): Promise<MutateResult> {
    const result = await renameAccount(ref, newLabel);
    if (result.ok && result.account) {
      this.emit({ type: "renamed", account: result.account, total: result.total });
    }
    return result;
  }

  /** Subscribe to fleet changes. Returns an unsubscribe function. */
  subscribe(listener: AccountEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AccountEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // A broken listener must never break the mutation that triggered it.
        console.warn(`[accounts] listener failed: ${(err as Error).message}`);
      }
    }
  }
}
