/**
 * Local event notifications — the gateway tells you BEFORE you wonder why
 * everything 429s: fleet exhausted, an account entry cooling down, a virtual
 * key hitting its cap, a trial plan claimed.
 *
 * Sinks (both opt-in via config.yaml `notifications:`):
 *  - `webhook`: generic JSON POST `{service, event, message, ts}` — works for
 *    plain receivers; Discord/Slack users point it at a relay or use ntfy.
 *  - `ntfy`: POST to an ntfy topic URL (https://ntfy.sh/<your-topic>) with the
 *    message as the body — phone push via the ntfy app.
 *
 * Design constraints:
 *  - Fire-and-forget: notifications must NEVER delay or fail a request. Every
 *    send is a detached fetch with a hard timeout; all errors are silenced
 *    with at most one warn line.
 *  - Dedupe: the same event repeats no faster than `cooldownSec` (default
 *    300s) — a stuck upstream must not turn into a webhook flood.
 *  - No telemetry: messages carry only what the event already logged locally.
 */
import type { ProxyConfig } from "../config/types.js";

export type NotifyEvent =
  | "fleet_exhausted"
  | "entry_cooldown"
  | "account_empty"
  | "pre_switch"
  | "key_cap"
  | "claim";

export interface NotifyDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface NotifyState {
  webhook: string | null;
  ntfy: string | null;
  cooldownMs: number;
  lastSent: Map<NotifyEvent, number>;
  warned: boolean;
}

const state: NotifyState = {
  webhook: null,
  ntfy: null,
  cooldownMs: 300_000,
  lastSent: new Map(),
  warned: false,
};

/** Bind the notification sinks from config. Called once per boot; hot-reload safe (re-call on config change). */
export function configureNotify(config: ProxyConfig): void {
  state.webhook = config.notifications?.webhook?.trim() || null;
  state.ntfy = config.notifications?.ntfy?.trim() || null;
  state.cooldownMs = Math.max(10, config.notifications?.cooldownSec ?? 300) * 1000;
}

/** True when this event may fire right now (dedupe window); records the send. */
function claimSendSlot(event: NotifyEvent, now: number): boolean {
  const last = state.lastSent.get(event);
  if (last !== undefined && now - last < state.cooldownMs) return false;
  state.lastSent.set(event, now);
  return true;
}

/**
 * Fire one event to every configured sink. Synchronous, never throws — the
 * sends are detached promises; a caller mid-request cannot observe them.
 * Events with no configured sinks (the default) cost one map lookup.
 */
export function notify(event: NotifyEvent, message: string, deps: NotifyDeps = {}): void {
  if (state.webhook === null && state.ntfy === null) return;
  const now = deps.now?.() ?? Date.now();
  if (!claimSendSlot(event, now)) return;
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (state.webhook !== null) {
    const url = state.webhook;
    void fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "zcode-proxy", event, message, ts: new Date(now).toISOString() }),
      signal: AbortSignal.timeout(5000),
    }).then((resp) => {
      if (!resp.ok) warnOnce(`webhook answered ${resp.status}`);
    }).catch((err: unknown) => {
      warnOnce(`webhook send failed: ${(err as Error).message}`);
    });
  }

  if (state.ntfy !== null) {
    const url = state.ntfy;
    void fetchImpl(url, {
      method: "POST",
      headers: { Title: `zcode-proxy: ${event}`, Tags: "warning" },
      body: message,
      signal: AbortSignal.timeout(5000),
    }).then((resp) => {
      if (!resp.ok) warnOnce(`ntfy answered ${resp.status}`);
    }).catch((err: unknown) => {
      warnOnce(`ntfy send failed: ${(err as Error).message}`);
    });
  }
}

function warnOnce(message: string): void {
  if (state.warned) return;
  state.warned = true;
  console.warn(`[notify] ${message} (further notification failures are silent)`);
}

/** Test hook: reset sinks, dedupe state and the warn-once latch. */
export function __resetNotifyForTests(): void {
  state.webhook = null;
  state.ntfy = null;
  state.cooldownMs = 300_000;
  state.lastSent.clear();
  state.warned = false;
}
