/**
 * `startServer` option assembly shared by every entry that boots the proxy
 * in-process (serve / tui).
 */
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import type { FleetRouter } from "../accounts/router.js";
import { ResponseStore } from "../responses/store.js";

/** Build `startServer` options, wiring the Responses store when its config gate is on. */
export function buildServerOptions(
  config: ProxyConfig,
  auth: AuthManager,
  debug: boolean,
  fleet?: FleetRouter,
): { config: ProxyConfig; auth: AuthManager; debug: boolean; fleet?: FleetRouter; responseStore?: ResponseStore } {
  const opts: { config: ProxyConfig; auth: AuthManager; debug: boolean; fleet?: FleetRouter; responseStore?: ResponseStore } = { config, auth, debug };
  if (fleet) opts.fleet = fleet;
  if (config.responses.enabled) {
    opts.responseStore = new ResponseStore({ maxEntries: config.responses.storeMaxEntries, ttlMs: config.responses.storeTtlMs });
  }
  return opts;
}
