/**
 * Entry point — load config, create auth manager, start proxy server.
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import { loadConfig } from "./config/loader.js";
import { watchConfigFile, type ConfigWatchHandles } from "./config/watch.js";
import { AuthManager } from "./auth/manager.js";
import { startServer, type ProxyServer } from "./server/server.js";
import { collectQuotaSnapshot } from "./server/routes-quota.js";
import { loadCredential, clearCredential, getStorePath } from "./auth/store.js";
import { AccountManager } from "./accounts/manager.js";
import { getAccountsStorePath } from "./accounts/store.js";
import { createFleetRouter, syncFleet, fleetSnapshot, type FleetRouter } from "./accounts/router.js";
import { loadAccounts } from "./accounts/store.js";
import { addKey, listKeys, removeKey, setKeyDisabled, getKeysStorePath } from "./keys/keys.js";
import { readUsageDays, summarizeUsage, usageLogPath } from "./ledger/ledger.js";
import { configureNotify } from "./notify/notify.js";
import { ZaiOAuthClient, BigmodelOAuthClient, BigmodelPollOAuthClient, LOGIN_TIMEOUT_MS, parsePastedCallbackUrl, type OAuthResult } from "./auth/oauth.js";
import { KeyResolver } from "./auth/resolver.js";
import type { Credential } from "./auth/types.js";
import type { ProviderId } from "./provider/types.js";
import type { ProxyConfig } from "./config/types.js";
import { updateConfigYaml, ensureConfigFile } from "./config/edit.js";
import { openBrowser } from "./runtime/open-browser.js";
import { pasteLoginInstructions, readPastedLine, boldIfTTY } from "./runtime/paste-login.js";
import { buildServerOptions } from "./server/server-options.js";
import {
  resolvePanelSettings,
  startPanelServer,
  type ControlDispatcher,
  type PanelServer,
  type PanelSettings,
} from "./server/panel.js";
import { checkForUpdate } from "./update/check.js";
import { formatDuration } from "./plan/auto.js";
import { LogBuffer, createControlDispatcher, type ControlState } from "./control.js";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { ensureNodeFetchNoTimeouts } from "./runtime/node-fetch-compat.js";

export const VERSION = "4.9.0";

if (require.main === module) main();

export interface ServeArgs {
  configPath?: string;
  debug: boolean;
}

/**
 * Parse `serve` subcommand arguments. The token `debug` toggles debug mode;
 * any other token is treated as the config path. Order-independent:
 *   []                → { debug: false }
 *   ["debug"]         → { debug: true }
 *   ["my.yaml"]       → { configPath: "my.yaml", debug: false }
 *   ["debug","x.yaml"] → { configPath: "x.yaml", debug: true }
 *   ["x.yaml","debug"] → { configPath: "x.yaml", debug: true }
 */
export function parseServeArgs(args: string[]): ServeArgs {
  const debug = args.includes("debug");
  const configPath = args.find((a) => a !== "debug");
  return { configPath, debug };
}

export function main(): void {
  // Fire-and-forget is race-safe: the dynamic import resolves in a microtask,
  // before the listener's event-loop callback can admit a request.
  void ensureNodeFetchNoTimeouts();
  try {
    runCli();
  } catch (err) {
    process.stderr.write(`zcode-proxy: uncaught error: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  }
}

function runCli(): void {
  const args = process.argv.slice(2);

  // `--cli` opts out of the default TUI and restores the classic CLI dispatch
  // (bare `--cli` = the old no-arg default: serve).
  if (args[0] === "--cli") {
    dispatchCli(args.slice(1));
    return;
  }
  // Default surface is the TUI. Bare invocation, the retired `tui` token
  // (kept as a silent alias), and tui-style args (`debug`, `*.yaml`) all land
  // here — the former `tui <args>` subcommand simply dropped its prefix.
  if (
    args.length === 0 ||
    args[0] === "tui" ||
    args[0] === "debug" ||
    args[0].endsWith(".yaml") ||
    args[0].endsWith(".yml")
  ) {
    launchTui(parseServeArgs(args[0] === "tui" ? args.slice(1) : args));
    return;
  }
  dispatchCli(args);
}

/** Classic CLI dispatch — subcommand routing where bare = serve. */
function dispatchCli(args: string[]): void {
  const cmd = args[0] ?? "serve";

  if (cmd === "auth") {
    authCommand(args.slice(1));
  } else if (cmd === "accounts") {
    void accountsCommand(args.slice(1));
  } else if (cmd === "keys") {
    void keysCommand(args.slice(1));
  } else if (cmd === "usage") {
    void usageCommand(args.slice(1));
  } else if (cmd === "claim") {
    void claimCommand(args.slice(1));
  } else if (cmd === "quota") {
    void quotaCommand();
  } else if (cmd === "tui") {
    // Kept for muscle memory under `--cli`: the default dispatch already
    // routes `tui` to the TUI, but `--cli tui` should not regress to an error.
    launchTui(parseServeArgs(args.slice(1)));
  } else if (cmd === "serve" || cmd.endsWith(".yaml") || cmd.endsWith(".yml")) {
    const serveArgs = cmd === "serve"
      ? parseServeArgs(args.slice(1))
      : parseServeArgs(args);
    serve(serveArgs.configPath, serveArgs.debug);
  } else if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(`zcode-proxy ${VERSION}`);
  } else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
  } else {
    console.error(`Unknown command: ${cmd}\n`);
    printHelp();
    process.exit(1);
  }
}

function launchTui(args: ServeArgs): void {
  // Dynamic import: the TUI module imports helpers back from this file, so a
  // static edge would create a load-time cycle (same pattern as claimCommand).
  import("./tui/app.js")
    .then((m) => m.runTui(args))
    .catch((err: unknown) => {
      process.stderr.write(`zcode-proxy: tui failed: ${(err as Error).stack ?? String(err)}\n`);
      process.exit(1);
    });
}

function printHelp(): void {
  console.log(`zcode-proxy ${VERSION}

Usage:
  zcode-proxy                       Interactive terminal UI (default):
                                    login, start/stop, live logs
  zcode-proxy [debug] [config.yaml] Same, with debug diagnostics / custom config
  zcode-proxy serve [config.yaml]   Start the proxy server (classic CLI mode)
  zcode-proxy serve debug [config.yaml]
                                    Start with verbose per-request diagnostics
  zcode-proxy --cli                 Classic CLI mode (bare --cli = serve)
  zcode-proxy auth login <provider> Login via OAuth (provider: zai | bigmodel)
                                    Adds an account; repeat for multiple accounts
  zcode-proxy auth login <provider> --import
                                    Import API key from ~/.zcode/v2/config.json
  zcode-proxy auth logout           Log out of the ACTIVE account (next takes over)
  zcode-proxy auth status           Show current authentication state
  zcode-proxy accounts list         List accounts (order = serving priority)
  zcode-proxy accounts remove <label>
  zcode-proxy accounts enable|disable <label>
  zcode-proxy accounts rename <old> <new>
  zcode-proxy keys add <label> [--requests-per-day N] [--tokens-per-day N] [--models m1,m2]
                                    Issue a virtual key for one tool (shown once)
  zcode-proxy keys list             List virtual keys
  zcode-proxy keys remove|enable|disable <label>
  zcode-proxy usage [days]          Usage totals (default 7 days): by day/tool/account/model/key
  zcode-proxy claim [list|now]      List / claim weekend-plan trial packages
  zcode-proxy quota                 Show plan quota (per-model remaining/total)
  zcode-proxy version               Show version
  zcode-proxy help                  Show this help

Examples:
  zcode-proxy                       Terminal UI: login, start/stop, live logs
  zcode-proxy debug                 Terminal UI with per-request diagnostics
  zcode-proxy serve debug           CLI: start with extra debug logging
  zcode-proxy auth login bigmodel   OAuth login for Bigmodel
  zcode-proxy auth login bigmodel --import
                                    Import existing key from ZCode config
  zcode-proxy auth status           Check if logged in
`);
}

/**
 * Mirror console output into a ring buffer so the panel's Logs card has data.
 * The buffer is also what `getLogs` reads.
 */
function installLogTee(): LogBuffer {
  const buffer = new LogBuffer();
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => { buffer.push(args.join(" ")); origLog(...args); };
  console.error = (...args: unknown[]) => { buffer.push("[error] " + args.join(" ")); origErr(...args); };
  console.warn = (...args: unknown[]) => { buffer.push("[warn] " + args.join(" ")); origWarn(...args); };
  return buffer;
}

/**
 * Start the optional web panel for `serve`. `serve` has no TUI, so this is the
 * only way to see quota, read live logs or switch provider/plan on a headless
 * box without `docker exec`.
 *
 * Commands are dispatched in-process through `createControlDispatcher()`: no
 * separate control port ever opens, because a loopback listener outside the
 * token gate would expose `stopProxy` / `logout` / `shutdown` to anything on
 * the box. The panel token is therefore the only way in.
 *
 * `serve` starts the proxy eagerly, so `serverRef` is pre-filled and the
 * start/stop commands only matter for restarts (including the
 * `stop_proxy_first` rule before setConfig).
 *
 * Two behaviours are panel-only and stay out of the shared control layer: the
 * `shutdown` command unwinds the whole process (through the same path as the
 * signals, so it works after the proxy was stopped from the page), and a
 * logout/login re-syncs the live credential — see `handleControl` below.
 */
async function startServePanel(
  settings: PanelSettings,
  ctx: {
    config: ProxyConfig;
    path: string;
    auth: AuthManager;
    serverRef: { current: ProxyServer | null };
    logBuffer: LogBuffer;
    /** Fleet router when accounts.enabled — mutated accounts re-sync immediately. */
    fleet: FleetRouter | null;
    /** Unwind the process; independent of whether the proxy is still running. */
    shutdown: () => void;
  },
): Promise<PanelServer> {
  const { config, path, auth, serverRef, logBuffer, shutdown, fleet } = ctx;

  // The panel can log out (or log in another account) while `serve` keeps
  // running, but AuthManager caches the credential in memory and auto-claim
  // prefers it over the store — so a disk-only change would leave `/v1` and
  // auto-claim serving the account that was just replaced (issue #58 review,
  // P2). Fingerprint the store and re-sync after every panel command: the
  // page polls `getLogs` every 2s, so a background login lands within one poll.
  let authFingerprint = JSON.stringify((await loadCredential().catch(() => null)) ?? null);

  async function syncAuthWithDisk(): Promise<void> {
    const onDisk = await loadCredential().catch(() => null);
    const fingerprint = JSON.stringify(onDisk ?? null);
    if (fingerprint === authFingerprint) return;
    authFingerprint = fingerprint;
    if (onDisk) {
      auth.setOAuthCredential(onDisk);
      console.log("auth: switched to the account now on disk");
    } else {
      auth.clearOAuthCredential();
      console.log("auth: credential cleared (logged out)");
    }
  }

  const controlState: ControlState = {
    provider: config.provider,
    plan: config.plan,
    proxyPort: serverRef.current?.port ?? 0,
  };

  async function startProxy(): Promise<{ ok: true; port: number } | { ok: false; error: string }> {
    if (serverRef.current) return { ok: false, error: "already_running" };
    const cred = await loadCredential().catch(() => null);
    if (!cred) return { ok: false, error: "not_logged_in" };
    auth.setOAuthCredential(cred);
    authFingerprint = JSON.stringify(cred);
    try {
      // Fleet re-resolved per start (mirrors the TUI): a hot-reload flip of
      // accounts.enabled applies on the next panel-side start/stop.
      const panelFleet = config.accounts?.enabled ? createFleetRouter(config) : null;
      if (panelFleet) await panelFleet.sync();
      const s = await startServer(buildServerOptions(config, auth, false, panelFleet ?? undefined));
      serverRef.current = s;
      console.log(`zcode-proxy listening on http://${s.hostname}:${s.port}`);
      return { ok: true, port: s.port };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async function stopProxy(): Promise<{ ok: true } | { ok: false; error: string }> {
    const s = serverRef.current;
    if (!s) return { ok: false, error: "not_running" };
    try {
      s.stop(false);
      serverRef.current = null;
      console.log("zcode-proxy stopped");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async function setConfig(changes: {
    provider?: ProviderId;
    plan?: "coding-plan" | "start-plan";
  }): Promise<{ ok: true; provider: ProviderId; plan: "coding-plan" | "start-plan" } | { ok: false; error: string }> {
    if (serverRef.current) return { ok: false, error: "stop_proxy_first" };
    if (changes.provider) config.provider = changes.provider;
    if (changes.plan) config.plan = changes.plan;
    updateConfigYaml(path, { provider: config.provider, plan: config.plan });
    console.log(`config updated: provider=${config.provider} plan=${config.plan}`);
    return { ok: true, provider: config.provider, plan: config.plan };
  }

  // Dispatched in-process: the panel already guards its own transport with a
  // token, so a second loopback listener would only add an unauthenticated way
  // to reach stopProxy / logout / shutdown (issue #58 review, P1) and a second
  // thing to clean up when the panel fails to start (P2, now structurally gone).
  const dispatchControl = createControlDispatcher(controlState, {
    logBuffer,
    onStartProxy: startProxy,
    onStopProxy: stopProxy,
    onSetConfig: setConfig,
    onQuota: () => collectQuotaSnapshot(config),
    onAccounts: async () => {
      // Pure snapshot, but re-sync from the store first so a panel login that
      // just added an account shows up on the next poll without waiting for
      // the fleet watcher's tick.
      if (fleet) await fleet.sync();
      else syncFleet(await loadAccounts().catch(() => []));
      return fleetSnapshot(config);
    },
    onAccountsMutate: async (op, ref) => {
      const manager = new AccountManager();
      const result = await manager.setEnabled(ref, op === "enable");
      if (!result.ok) return { ok: false, error: result.error ?? "unknown" };
      // Immediate effect: the router picks up the new enabled flags on its
      // next pickServing instead of waiting for the watcher tick.
      if (fleet) await fleet.sync();
      console.log(`panel: account "${result.account?.label ?? ref}" ${op}d`);
      return { ok: true };
    },
    onUsage: async (days) => summarizeUsage(readUsageDays(days), days),
  });

  /** Grace period for the `shutdown` reply before `process.exit()` runs. */
  const SHUTDOWN_REPLY_GRACE_MS = 50;

  /**
   * The panel's transport wrapper. Two panel-only responsibilities live here
   * rather than in the shared control layer:
   *
   * - `shutdown` answers first and unwinds afterwards. Exiting inside the
   *   command would truncate the reply the page is waiting for, and it unwinds
   *   through the same path as SIGTERM/SIGINT, so it works whether or not the
   *   proxy is still running (issue #58 review, P2).
   * - Every other successful command re-syncs the live credential with the
   *   store, and a logout while the proxy runs stops it. Otherwise `/v1` and
   *   auto-claim keep spending the account that was just logged out (issue #58
   *   review, P2).
   */
  const handleControl: ControlDispatcher = async (cmd) => {
    if (cmd.cmd === "shutdown") {
      setTimeout(shutdown, SHUTDOWN_REPLY_GRACE_MS);
      return { ok: true, event: "shuttingDown" };
    }
    const res = await dispatchControl(cmd);
    if (!res.ok) return res;
    await syncAuthWithDisk();
    if (cmd.cmd === "logout" && serverRef.current) {
      await stopProxy();
      controlState.proxyPort = 0;
      console.log("panel: logout cleared the live credential — proxy stopped");
    }
    return res;
  };

  const panel = await startPanelServer({
    port: settings.port,
    token: settings.token,
    handleControl,
  });
  console.log(`panel: http://${panel.hostname}:${panel.port} (token required)`);

  return panel;
}

/**
 * The start/stop-on-config background jobs of a serve process: captcha pool
 * warmup, auto-claim scheduler, plan auto-switch watcher. One instance owns
 * them from startup through shutdown and exposes the same handles to the
 * config hot reload (see config/watch.ts), so flipping `claim` or
 * `planAutoSwitch` in config.yaml starts or stops the job without a restart.
 * Shared by the serve and TUI entries; `jobLabels` adapts the
 * job log lines to each surface (the TUI indents them).
 */
export function createServeJobs(
  config: ProxyConfig,
  auth: AuthManager,
  jobLabels: { indent?: string; note?: string } = {},
  fleet?: FleetRouter | null,
): {
  startInitial(): void;
  handles: ConfigWatchHandles;
  stopForShutdown(cleared: string[]): void;
} {
  const indent = jobLabels.indent ?? "  ";
  const note = jobLabels.note ?? "";
  let claimScheduler: { stop: () => void } | null = null;
  let planWatcher: { stop: () => void } | null = null;
  let fleetWatcher: { stop: () => void } | null = null;
  let fleetRouter: FleetRouter | null = fleet ?? null;
  let captchaModule: { shutdownCaptcha: () => void } | null = null;
  // The dynamic imports resolve asynchronously; the pending flags keep a
  // config reload racing the first start from double-starting a job.
  let claimPending = false;
  let planPending = false;
  let fleetPending = false;
  let captchaPoolStarted = false;

  const startClaimJob = (): void => {
    stopClaimJob(); // restart-safe: a dirty claim block re-runs this with the new fields
    claimPending = true;
    import("./claim/runtime.js")
      .then((m) => {
        claimPending = false;
        claimScheduler = m.startAutoClaim(config, auth);
        console.log(`${indent}claim: auto ON (poll ${formatDuration(config.claim.pollIntervalSec * 1000)}${note})`);
      })
      .catch((err) => {
        claimPending = false;
        console.error(`[claim] scheduler failed to start: ${(err as Error).message}`);
      });
  };
  const stopClaimJob = (): void => {
    claimPending = false;
    if (!claimScheduler) return;
    claimScheduler.stop();
    claimScheduler = null;
    console.log(`${indent}claim: auto OFF`);
  };
  const startPlanWatcherJob = (): void => {
    stopPlanWatcherJob();
    planPending = true;
    import("./plan/auto.js")
      .then((m) => {
        planPending = false;
        planWatcher = m.startPlanAutoWatcher(config);
        console.log(`${indent}plan auto-switch: ON (priority ${m.planPriorityOf(config).join(" > ")}; poll ${formatDuration(m.planPollIntervalMsOf(config))}${note})`);
      })
      .catch((err) => {
        planPending = false;
        console.error(`[plan] auto-switch watcher failed to start: ${(err as Error).message}`);
      });
  };
  const stopPlanWatcherJob = (): void => {
    planPending = false;
    if (!planWatcher) return;
    planWatcher.stop();
    planWatcher = null;
    console.log(`${indent}plan auto-switch: OFF`);
  };
  const startFleetJob = (): void => {
    stopFleetJob(); // restart-safe: a dirty accounts block re-runs this with the new fields
    fleetPending = true;
    import("./accounts/router.js")
      .then((m) => {
        fleetPending = false;
        if (!fleetRouter) fleetRouter = m.createFleetRouter(config);
        fleetWatcher = fleetRouter.startWatcher();
        console.log(`${indent}fleet router: ON (strategy ${config.accounts?.strategy ?? "priority"}, poll ${formatDuration((config.accounts?.pollIntervalSec ?? 60) * 1000)}${note})`);
      })
      .catch((err) => {
        fleetPending = false;
        console.error(`[fleet] watcher failed to start: ${(err as Error).message}`);
      });
  };
  const stopFleetJob = (): void => {
    fleetPending = false;
    if (!fleetWatcher) return;
    fleetWatcher.stop();
    fleetWatcher = null;
    console.log(`${indent}fleet router: OFF`);
  };
  const warmCaptchaPoolJob = (): void => {
    if (captchaPoolStarted || config.plan !== "start-plan") return;
    // Pre-solve the captcha token pool in the background so first requests
    // don't pay the full solve latency (in-process happy-dom backend).
    captchaPoolStarted = true;
    import("./proxy/captcha.js")
      .then(async (m) => {
        captchaModule = m;
        await m.startCaptchaPool(config.identity.appVersion);
      })
      .catch((err) => {
        captchaPoolStarted = false;
        console.error(`[captcha] pool warmup failed: ${(err as Error).message}`);
      });
  };

  return {
    startInitial() {
      if (config.plan === "start-plan") warmCaptchaPoolJob();
      if (config.claim.enabled && config.claim.auto) startClaimJob();
      if (config.accounts?.enabled) {
        // Fleet mode: the (account × plan) chain failover subsumes the
        // single-account plan auto-switch — running both would double-poll.
        startFleetJob();
      } else if (config.planAutoSwitch) {
        startPlanWatcherJob();
      }
    },
    handles: {
      claimRunning: () => claimScheduler !== null || claimPending,
      startClaim: startClaimJob,
      stopClaim: stopClaimJob,
      planWatcherRunning: () => planWatcher !== null || planPending,
      startPlanWatcher: startPlanWatcherJob,
      stopPlanWatcher: stopPlanWatcherJob,
      fleetRunning: () => fleetWatcher !== null || fleetPending,
      startFleet: startFleetJob,
      stopFleet: stopFleetJob,
      warmCaptchaPool: warmCaptchaPoolJob,
    },
    stopForShutdown(cleared) {
      if (fleetWatcher) {
        try {
          fleetWatcher.stop();
          cleared.push("fleet router");
        } catch {
          /* already stopped */
        }
        fleetWatcher = null;
      }
      if (planWatcher) {
        try {
          planWatcher.stop();
          cleared.push("plan auto-switch");
        } catch {
          /* already stopped */
        }
        planWatcher = null;
      }
      if (claimScheduler) {
        try {
          claimScheduler.stop();
          cleared.push("auto-claim");
        } catch {
          /* already stopped */
        }
        claimScheduler = null;
      }
      if (captchaModule) {
        try {
          captchaModule.shutdownCaptcha();
          cleared.push("captcha pool");
        } catch {
          /* pool never started */
        }
        captchaModule = null;
      }
    },
  };
}

async function serve(configPath: string | undefined, debug: boolean): Promise<void> {
  const path = configPath ?? process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (ensureConfigFile(path)) {
    ensureDeviceMidInConfig(path);
    console.log(`Created ${path} from bundled template.`);
    console.log(`Run: zcode-proxy auth login <zai|bigmodel>\n`);
  }
  const config = loadConfig(path);
  configureNotify(config);

  // Optional web panel (issue #58). Resolved early so console output from the
  // startup path below is already captured for the panel's Logs card.
  const panelSettings = resolvePanelSettings();
  const panelLogBuffer = panelSettings ? installLogTee() : null;

  const auth = new AuthManager();
  const cred = await loadCredential();
  if (!cred) {
    console.error("Not logged in. Run: zcode-proxy auth login " + config.provider);
    process.exit(1);
  }
  auth.setOAuthCredential(cred);

  // Fleet router (accounts.enabled): sync the snapshot BEFORE the server
  // starts so the very first request has a serving pick available.
  const fleet = config.accounts?.enabled ? createFleetRouter(config) : null;
  if (fleet) await fleet.sync();

  if (debug) printDebugBanner(config, path, cred);

  const server = await startServer(buildServerOptions(config, auth, debug, fleet ?? undefined));
  // The optional panel can stop and restart the proxy, so the signal handlers
  // and the lifecycle hooks go through this ref rather than the initial handle.
  const serverRef: { current: ProxyServer | null } = { current: server };
  const url = `http://${server.hostname}:${server.port}`;
  console.log(`zcode-proxy listening on ${url}`);
  // Handles for the background timers started below, so `shutdown` can clear
  // them without the proxy handle being involved (issue #58 review, P2).
  const jobs = createServeJobs(config, auth, {}, fleet);
  jobs.startInitial();

  // Hot reload: edits to config.yaml apply in place without a restart
  // (see config/watch.ts). `server` (port/host) still needs a restart.
  const configWatcher = watchConfigFile(path, config, jobs.handles);
  console.log(`  provider: ${config.provider}`);
  console.log(`  plan: ${config.plan}${config.planAutoSwitch ? ` (auto-switch on: priority ${(config.planPriority ?? ["start-plan", "coding-plan"]).join(" > ")})` : ""}`);
  console.log(`  models: ${config.models.length} available`);
  if (config.responses.enabled) console.log(`  /v1/responses: ON`);
  if (config.async.enabled) {
    console.log(config.plan === "coding-plan" ? `  /async/v1/*: ON` : `  /async/v1/*: OFF (requires plan "coding-plan")`);
  }
  if (debug) console.log(`  debug: ON`);

  // Update notice (issue #60): fire-and-forget — a slow or blocked GitHub must
  // never delay startup, and every failure mode is silent (see update/check.ts).
  // In a container the hint is the compose command: the image cannot self-update.
  void checkForUpdate(VERSION).then((result) => {
    if (result.kind === "update") console.log(`  update: ${result.notice.text}`);
  });

  let panelRuntime: PanelServer | null = null;

  const closePanel = (): void => {
    if (!panelRuntime) return;
    void panelRuntime.close().catch(() => {});
  };

  // Single shutdown path, shared by the signals and the panel's `shutdown`
  // command. It must not depend on `serverRef`: the page can stop the proxy,
  // and the timers below keep the event loop alive, so "the proxy is already
  // stopped" is not the same as "there is nothing left to do" — without this,
  // SIGTERM/SIGINT and `docker stop` hung until the kill timeout after a
  // panel-side Stop proxy (issue #58 review, P2).
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    closePanel();
    configWatcher.stop();
    const cleared: string[] = [];
    jobs.stopForShutdown(cleared);
    if (cleared.length > 0) console.log(`shutdown: cleared ${cleared.join(" + ")} timers`);
    if (serverRef.current) {
      // Closes the listener and exits the process (`stop(true)`).
      serverRef.current.stop(true);
      return;
    }
    console.log("shutdown: proxy already stopped — exiting");
    process.exit(0);
  };

  if (panelSettings && panelLogBuffer) {
    try {
      panelRuntime = await startServePanel(panelSettings, {
        config,
        path,
        auth,
        serverRef,
        logBuffer: panelLogBuffer,
        fleet,
        shutdown,
      });
    } catch (err) {
      // The panel is a convenience layer; it must never take the proxy down.
      console.error(`[panel] failed to start: ${(err as Error).message}`);
    }
  }

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    shutdown();
  });
  process.on("SIGTERM", () => {
    shutdown();
  });
}

function printDebugBanner(config: ProxyConfig, path: string, cred: Credential | null): void {
  const credShape = cred
    ? `${cred.apiKey.slice(0, 6)}...${cred.apiKey.slice(-4)} (${cred.apiKey.length} chars)`
    : "(none)";
  const active = config.providers[config.provider];
  console.log("=== zcode-proxy DEBUG MODE ===");
  console.log(`  config file: ${path}`);
  console.log(`  server: ${config.server.host}:${config.server.port}`);
  console.log(`  proxy api key: ${config.auth.proxyApiKey ? "required" : "open (no client auth)"}`);
  console.log(`  provider: ${config.provider}`);
  console.log(`  plan: ${config.plan}`);
  console.log(`  identity: appVersion=${config.identity.appVersion} sourceTitle=${config.identity.sourceTitle} referer=${config.identity.refererOrigin}`);
  console.log(`  client identity: mode=${config.clientIdentity.mode} ttl=${config.clientIdentity.ttlSeconds}s max=${config.clientIdentity.maxSessions}`);
  console.log(`  anthropic base: ${active.anthropicBase}`);
  console.log(`  openai base:    ${active.openaiBase}`);
  console.log(`  credential: ${credShape}`);
  console.log(`  models (${config.models.length}): ${config.models.join(", ")}`);
  console.log(`  log level: ${config.logging.level}`);
  console.log("===============================");
}

function authCommand(args: string[]): void {
  const sub = args[0];

  if (sub === "login") {
    authLogin(args.slice(1));
  } else if (sub === "logout") {
    void authLogout();
  } else if (sub === "status") {
    void authStatus();
  } else {
    console.error("Usage: zcode-proxy auth <login|logout|status>");
    console.error("Account fleet management: zcode-proxy accounts <list|remove|enable|disable|rename>");
    process.exit(1);
  }
}

/**
 * `keys` subcommand — manage virtual API keys (per-tool attribution, caps,
 * model allowlists). The full key is printed ONCE at creation; the store keeps
 * only a hash.
 */
async function keysCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? "list";

  if (sub === "add") {
    const label = args[1];
    if (!label) {
      console.error("Usage: zcode-proxy keys add <label> [--requests-per-day N] [--tokens-per-day N] [--models m1,m2]");
      process.exit(1);
    }
    const flagValue = (name: string): number | undefined => {
      const at = args.indexOf(name);
      if (at < 0) return undefined;
      const n = parseInt(args[at + 1] ?? "", 10);
      if (!Number.isInteger(n) || n < 1) {
        console.error(`${name} must be a positive integer`);
        process.exit(1);
      }
      return n;
    };
    const requestsPerDay = flagValue("--requests-per-day");
    const tokensPerDay = flagValue("--tokens-per-day");
    const modelsAt = args.indexOf("--models");
    const models = modelsAt >= 0 ? (args[modelsAt + 1] ?? "").split(",").map((m) => m.trim()).filter(Boolean) : undefined;

    const result = addKey({ label, ...(requestsPerDay !== undefined ? { requestsPerDay } : {}), ...(tokensPerDay !== undefined ? { tokensPerDay } : {}), ...(models && models.length > 0 ? { models } : {}) });
    if (!result.ok) {
      console.error(`keys: ${result.error}`);
      process.exit(1);
    }
    console.log(`Virtual key "${label}" created. Store it in your tool NOW — it is shown once:`);
    console.log(`\n  ${result.issued.fullKey}\n`);
    if (result.issued.entry.caps) {
      const caps = result.issued.entry.caps;
      const bits = [
        caps.requestsPerDay !== undefined ? `${caps.requestsPerDay} requests/day` : null,
        caps.tokensPerDay !== undefined ? `${caps.tokensPerDay} tokens/day` : null,
      ].filter(Boolean);
      console.log(`  Caps: ${bits.join(", ")}`);
    }
    if (result.issued.entry.models) console.log(`  Models: ${result.issued.entry.models.join(", ")}`);
    console.log(`  Store:  ${getKeysStorePath()}`);
    return;
  }

  if (sub === "list") {
    const keys = listKeys();
    if (keys.length === 0) {
      console.log("No virtual keys. Add one: zcode-proxy keys add <label>");
      return;
    }
    console.log(`Virtual keys (${keys.length}):`);
    for (const k of keys) {
      const caps = k.caps
        ? ` caps: ${[k.caps.requestsPerDay !== undefined ? `${k.caps.requestsPerDay}r/d` : null, k.caps.tokensPerDay !== undefined ? `${k.caps.tokensPerDay}tok/d` : null].filter(Boolean).join(", ")}`
        : "";
      const models = k.models ? ` models: ${k.models.join(",")}` : "";
      const state = k.disabled ? " [disabled]" : "";
      console.log(`  ${k.label}${state} — ${k.prefix}…${caps}${models}`);
    }
    return;
  }

  if (sub === "remove" || sub === "enable" || sub === "disable") {
    const ref = args[1];
    if (!ref) {
      console.error(`Usage: zcode-proxy keys ${sub} <label>`);
      process.exit(1);
    }
    const result = sub === "remove" ? removeKey(ref) : setKeyDisabled(ref, sub === "disable");
    if (!result.ok) {
      console.error(`keys: ${result.error}`);
      process.exit(1);
    }
    console.log(sub === "remove" ? `Removed key "${result.label}".` : `Key "${result.label}" is now ${sub}d.`);
    return;
  }

  console.error("Usage: zcode-proxy keys <add|list|remove|enable|disable>");
  process.exit(1);
}

/**
 * `usage [days]` — print the local usage ledger aggregates: per day, tool
 * (User-Agent), fleet account, model and virtual key. Reads only the local
 * file — no upstream calls.
 */
async function usageCommand(args: string[]): Promise<void> {
  const days = Math.min(365, Math.max(1, parseInt(args[0] ?? "7", 10) || 7));
  const entries = readUsageDays(days);
  if (entries.length === 0) {
    console.log(`No usage recorded in the last ${days} day${days === 1 ? "" : "s"} (ledger: ${usageLogPath()}).`);
    return;
  }
  const summary = summarizeUsage(entries, days);
  console.log(`Usage — last ${days} day${days === 1 ? "" : "s"}: ${summary.totalRequests.toLocaleString("en-US")} requests, ${summary.totalTokens.toLocaleString("en-US")} tokens, ${summary.failedRequests} failed`);
  printUsageTotals("By day", summary.byDay);
  printUsageTotals("By tool", summary.byTool);
  printUsageTotals("By account", summary.byAccount);
  printUsageTotals("By model", summary.byModel);
  printUsageTotals("By key", summary.byKey);
  console.log(`  Ledger: ${usageLogPath()}`);
}

function printUsageTotals(title: string, totals: { name: string; requests: number; tokens: number }[]): void {
  console.log(`  ${title}:`);
  for (const t of totals) {
    console.log(`    ${t.name.padEnd(28)} ${String(t.requests).padStart(6)} req  ${t.tokens.toLocaleString("en-US").padStart(14)} tok`);
  }
}

/**
 * `accounts` subcommand — manage the account fleet. Store order IS serving
 * priority: the first enabled account serves (`(active)` marker in `list`).
 */
async function accountsCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? "list";
  const manager = new AccountManager();
  const labelArg = args[1];

  if (sub === "list") {
    await printAccountList(manager);
    return;
  }

  if (sub === "remove" || sub === "enable" || sub === "disable" || sub === "rename") {
    if (!labelArg || (sub === "rename" && !args[2])) {
      console.error(`Usage: zcode-proxy accounts ${sub} ${sub === "rename" ? "<old-label> <new-label>" : "<label>"}`);
      process.exit(1);
    }
  } else {
    console.error("Usage: zcode-proxy accounts <list|remove|enable|disable|rename>");
    process.exit(1);
  }

  const result = sub === "rename"
    ? await manager.rename(labelArg, args[2]!)
    : sub === "remove"
      ? await manager.remove(labelArg)
      : await manager.setEnabled(labelArg, sub === "enable");

  if (!result.ok) {
    console.error(`accounts: ${result.error}`);
    process.exit(1);
  }
  const label = result.account?.label ?? labelArg;
  if (sub === "remove") {
    console.log(`Removed account "${label}" (${result.total} left).`);
  } else if (sub === "rename") {
    console.log(`Renamed to "${label}".`);
  } else {
    console.log(`Account "${label}" is now ${sub === "enable" ? "enabled" : "disabled"} (serving skipped).`);
  }
  await printAccountList(manager);
}

/** Shared `accounts list` / `auth status` rendering: the fleet, active first-marked. */
async function printAccountList(manager: AccountManager): Promise<void> {
  const accounts = await manager.list();
  if (accounts.length === 0) {
    console.log("No accounts. Add one: zcode-proxy auth login <zai|bigmodel>");
    return;
  }
  const active = await manager.getActive();
  console.log(`Accounts (order = serving priority, ${accounts.length} total):`);
  for (const a of accounts) {
    const marker = active && a.id === active.id ? " (active)" : "";
    const state = a.enabled ? "" : " [disabled]";
    console.log(`  ${a.label}${state}${marker} — ${a.provider}, key ${a.credential.apiKey.slice(0, 8)}…`);
  }
  console.log(`  Store: ${getAccountsStorePath()}`);
}

async function claimCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? "now";
  if (sub !== "list" && sub !== "now") {
    console.error("Usage: zcode-proxy claim [list|now]");
    process.exit(1);
  }
  const path = process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (!existsSync(path)) {
    console.error(`Config file not found: ${path} (run serve once or create it).`);
    process.exit(1);
  }
  // The billing gateway requires a stable X-Device-Mid — self-heal configs
  // created before the deviceMid feature (idempotent: reuses existing value).
  ensureDeviceMidInConfig(path);
  const config = loadConfig(path);
  try {
    const { runClaimCli } = await import("./claim/runtime.js");
    await runClaimCli(config, sub);
  } catch (err) {
    console.error(`claim failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

/**
 * `quota` subcommand — print the live quota snapshot: per-model credit buckets
 * (billing plane) and coding-plan usage windows (monitor plane). Reuses
 * collectQuotaSnapshot (same path GET /quota serves).
 */
async function quotaCommand(): Promise<void> {
  const path = process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (!existsSync(path)) {
    console.error(`Config file not found: ${path} (run serve once or create it).`);
    process.exit(1);
  }
  ensureDeviceMidInConfig(path);
  const config = loadConfig(path);
  try {
    const { collectQuotaSnapshot } = await import("./server/routes-quota.js");
    const snap = await collectQuotaSnapshot(config);
    if (snap.balances.length === 0) {
      console.log("No balance windows reported by the billing endpoint.");
    }
    for (const b of snap.balances) {
      const exp = b.expiresAt ? ` · expires ${fmtQuotaExpiry(b.expiresAt)}` : "";
      console.log(`  ${b.showName || "(unnamed)"}: ${b.remainingUnits.toLocaleString("en-US")} / ${b.totalUnits.toLocaleString("en-US")} units${exp}`);
    }
    if (snap.codingPlan) {
      const { level, limits } = snap.codingPlan;
      if (limits.length === 0) {
        console.log("No coding-plan usage windows reported by the monitor endpoint.");
      }
      for (const l of limits) {
        const tier = level ? ` (${level})` : "";
        // Mirror of the official panel: remaining only — upstream `number` is
        // not a comparable total (live TIME_LIMIT row: remaining=3894, number=1).
        const amount =
          l.remaining !== undefined
            ? `${l.remaining.toLocaleString("en-US")}${l.unit ? ` ${l.unit}` : ""} remaining`
            : "no usage numbers reported";
        const reset = l.nextResetTime !== undefined ? ` · resets ${fmtQuotaExpiry(l.nextResetTime)}` : "";
        console.log(`  coding-plan${tier}: [${l.type}] ${amount}${reset}`);
      }
    }
    for (const plan of snap.claimablePlans) {
      const grants = plan.entitlements
        .map((e) => `${e.showName || plan.name}: ${(e.grantUnits ?? 0).toLocaleString("en-US")} ${e.unitType}`)
        .join("; ");
      console.log(`  claimable: ${plan.name}${grants ? ` (${grants})` : ""}`);
    }
    for (const err of snap.errors) console.error(`  ⚠ ${err}`);
    if (snap.errors.length > 0) process.exitCode = 1;
  } catch (err) {
    console.error(`quota query failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

/** `YYYY-MM-DD HH:mm` local time; `expiresAt` may be seconds or milliseconds. */
function fmtQuotaExpiry(expiresAt: number): string {
  const d = new Date(expiresAt > 1e12 ? expiresAt : expiresAt * 1000);
  if (Number.isNaN(d.getTime())) return String(expiresAt);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function authLogin(args: string[]): Promise<void> {
  const provider = args[0] as ProviderId | undefined;
  const importMode = args.includes("--import");
  // Headless paste login: --paste flag or ZCODE_OAUTH_PASTE=1 (docker-friendly).
  const pasteMode =
    args.includes("--paste") || /^(1|true|yes)$/i.test(process.env.ZCODE_OAUTH_PASTE ?? "");

  if (!provider || (provider !== "zai" && provider !== "bigmodel")) {
    console.error("Usage: zcode-proxy auth login <zai|bigmodel> [--import] [--paste]");
    process.exit(1);
  }
  if (pasteMode && provider !== "bigmodel") {
    console.error("--paste applies to the bigmodel auth-code flow only.");
    console.error("zai login is server-mediated (no localhost callback) and already works headless.");
    process.exit(1);
  }

  ensureConfigWithDeviceMid();

  const mode = importMode ? "(import)" : pasteMode ? "(OAuth, paste)" : "(OAuth)";
  console.log(`Logging in: ${provider} ${mode}\n`);

  let cred: Credential;

  if (importMode) {
    cred = importFromZCodeConfig(provider);
  } else {
    const { accessToken, userId, jwt } = await runOAuth(provider, pasteMode);
    console.log("\nResolving API key...");
    const resolver = new KeyResolver();
    cred = await resolver.resolveCodingPlanCredential(accessToken, provider, userId);
    if (jwt) cred.jwt = jwt;
  }

  // Fleet semantics: a NEW login appends an account; re-logging the SAME
  // upstream account (same user id / API key) refreshes it in place.
  const manager = new AccountManager();
  const { account, updatedExisting, total } = await manager.add(cred);
  console.log(
    updatedExisting
      ? `\nRefreshed existing account "${account.label}" (${total} account${total === 1 ? "" : "s"} stored).`
      : `\nAdded account "${account.label}" (${total} account${total === 1 ? "" : "s"} stored).`,
  );
  console.log(`  Provider: ${cred.provider}`);
  console.log(`  API Key:  ${cred.apiKey.substring(0, 12)}...`);
  if (cred.userId) console.log(`  User ID:  ${cred.userId}`);
  console.log(`  Store:    ${getAccountsStorePath()}`);
}

/**
 * Ensure config.yaml exists and carries a stable `identity.deviceMid`.
 * Creates the file from the bundled template when missing; a
 * `ZCODE_IDENTITY_DEVICE_MID` env var takes precedence when set.
 * Returns the mid (existing or freshly generated).
 */
function ensureConfigWithDeviceMid(): string {
  const path = process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (ensureConfigFile(path)) {
    console.log(`Created ${path} from bundled template.`);
  }
  return ensureDeviceMidInConfig(path);
}

/**
 * Generate-or-reuse `identity.deviceMid` in a YAML config via targeted line
 * edit (comments preserved): fills an empty `deviceMid:` value, inserts one
 * under a block-style `identity:` key, or appends a new `identity:` block when
 * the key is absent entirely. Idempotent — an existing non-empty value is
 * returned untouched. The regexes are function-local on purpose: `main()` runs
 * synchronously at module top (before later top-level statements initialize),
 * so any module-level const this function touches would still be undefined on
 * the boot-time `serve` path.
 */
export function ensureDeviceMidInConfig(path: string): string {
  const deviceMidLine = /^(\s*)deviceMid:\s*(.*)$/m;
  const identityBlockLine = /^identity:\s*$/m;
  const raw = readFileSync(path, "utf-8");

  const existing = deviceMidLine.exec(raw);
  if (existing) {
    const value = existing[2].trim().replace(/^"|"$/g, "");
    if (value.length > 0) return value;
  }

  const mid = randomUUID();
  let updated: string;
  if (existing) {
    updated = raw.replace(deviceMidLine, `${existing[1]}deviceMid: "${mid}"`);
  } else if (identityBlockLine.test(raw)) {
    updated = raw.replace(identityBlockLine, `identity:\n  deviceMid: "${mid}"`);
  } else {
    const block = `identity:\n  deviceMid: "${mid}"\n`;
    updated = raw.endsWith("\n") || raw.length === 0 ? raw + block : raw + "\n" + block;
  }
  writeFileSync(path, updated, "utf-8");
  console.log(`Device identity generated: ${mid.slice(0, 8)}… (stored in ${path})`);
  return mid;
}

/**
 * `auth logout` — removes the ACTIVE account. With a fleet stored, the next
 * enabled account takes over as active (and starts serving on next boot);
 * with the pre-fleet single credential this is exactly the old full logout.
 */
async function authLogout(): Promise<void> {
  const manager = new AccountManager();
  const before = await manager.list();
  if (before.length === 0 && !existsSync(getStorePath())) {
    console.log("Not logged in.");
    return;
  }

  const result = await manager.removeActive();
  if (!result.ok) {
    // No enabled account in the store, but a legacy credential may remain.
    clearCredential();
    console.log("Logged out. Credentials removed.");
    return;
  }

  const label = result.account?.label ?? "(unknown)";
  if (result.total === 0) {
    console.log(`Logged out of "${label}". No accounts remain — run: zcode-proxy auth login <zai|bigmodel>`);
    return;
  }
  const next = await manager.getActive();
  console.log(`Logged out of "${label}". ${result.total} account${result.total === 1 ? "" : "s"} remain, active is now "${next?.label ?? "none"}".`);
}

async function authStatus(): Promise<void> {
  const manager = new AccountManager();
  const accounts = await manager.list();
  if (accounts.length === 0 && !existsSync(getStorePath())) {
    console.log("Not logged in.");
    console.log("Run: zcode-proxy auth login <zai|bigmodel>");
    return;
  }
  await printAccountList(manager);
}

async function runOAuth(provider: ProviderId, pasteMode: boolean): Promise<OAuthResult> {
  if (provider === "bigmodel" && pasteMode) {
    const oauth = new BigmodelOAuthClient();
    return runPasteLogin(oauth);
  }

  // Both providers use the server-mediated poll login (ZCode 3.12.3 default):
  // the browser never calls back here — open the URL on ANY device and the
  // flow completes server-side while we poll.
  const oauth = provider === "bigmodel" ? new BigmodelPollOAuthClient() : new ZaiOAuthClient();
  const result = await oauth.authorize((url) => {
    console.log("Open this URL to authorize (any device/browser works):\n");
    console.log(`  ${url}\n`);
    console.log("Waiting for authorization... (expires in 300s)\n");
    console.log(
      "After you authorize, the browser may report it cannot open a zcode:// link —\n" +
        "that is expected and safe to ignore; the login completes here automatically.\n",
    );
    openBrowser(url);
  });
  return result;
}

/**
 * Headless bigmodel login (`auth login bigmodel --paste`): the localhost
 * callback server is still bound — it defines the redirect port and the
 * browser can never reach it from inside a container anyway — but instead of
 * waiting on it, the user pastes the redirected URL back. The exact
 * `started.callbackUrl` string is used BOTH as the authorize `redirect` param
 * and as the exchange `redirect_uri` (the token endpoint requires them to
 * match), so the pair stays consistent by construction.
 */
async function runPasteLogin(oauth: BigmodelOAuthClient): Promise<OAuthResult> {
  const started = await oauth.start();
  try {
    console.log(pasteLoginInstructions(started.authorizeUrl, started.callbackUrl, LOGIN_TIMEOUT_MS));
    openBrowser(started.authorizeUrl);
    process.stdout.write("\n" + boldIfTTY("Paste the FULL redirected URL here, then press Enter:") + "\n> ");
    const pasted = await readPastedLine(LOGIN_TIMEOUT_MS);
    const code = parsePastedCallbackUrl(pasted, started.state);
    console.log("\nExchanging authorization code...");
    const tokens = await oauth.exchangeCode(code, started.callbackUrl, started.state);
    return { accessToken: tokens.accessToken, provider: "bigmodel", userId: tokens.userId, jwt: tokens.jwt };
  } finally {
    await oauth.close();
  }
}

function importFromZCodeConfig(provider: ProviderId): Credential {
  const configPath = join(homedir(), ".zcode", "v2", "config.json");
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    console.error(`Cannot read ${configPath}.`);
    console.error("Make sure ZCode is installed and you've logged in at least once.");
    process.exit(1);
  }

  const config = JSON.parse(raw) as {
    provider?: Record<string, { options?: { apiKey?: string }; enabled?: boolean }>;
  };

  const providerKey = `builtin:${provider}-coding-plan`;
  const entry = config.provider?.[providerKey];
  const apiKey = entry?.options?.apiKey?.trim();

  if (!apiKey) {
    console.error(`No API key for ${providerKey} in ZCode config.`);
    process.exit(1);
  }

  const startPlanKey = `builtin:${provider}-start-plan`;
  const jwt = config.provider?.[startPlanKey]?.options?.apiKey?.trim() || undefined;

  console.log(`Imported from ${configPath}`);
  if (jwt) console.log(`  Start-plan JWT: ${jwt.slice(0, 12)}...`);
  return { apiKey, provider, jwt };
}
