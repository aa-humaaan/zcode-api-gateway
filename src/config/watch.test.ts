/**
 * Tests for config.yaml hot reload: in-place apply of per-request fields,
 * restart-only fields reported but not applied, broken files keeping the
 * running config (and the watcher alive), and claim/plan-watcher reconciliation.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./loader.js";
import { watchConfigFile, type ConfigWatcher, type ConfigWatchHandles } from "./watch.js";
import { captureConsoleLog } from "../proxy/handler-debug.test.js";

// Explicit claim disable: the defaults turn auto-claim ON, so a bare config
// would already reconcile a running claim job.
const BASE_YAML = "provider: zai\nplan: coding-plan\nclaim:\n  enabled: false\n";

let dir: string;
const watchers: ConfigWatcher[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfgwatch-"));
});

afterEach(() => {
  for (const w of watchers) w.stop();
  watchers.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

function configPath(): string {
  return join(dir, "config.yaml");
}

function startWatcher(
  current: ReturnType<typeof loadConfig>,
  handles: Partial<ConfigWatchHandles> = {},
): ConfigWatcher {
  const w = watchConfigFile(
    configPath(),
    current,
    {
      claimRunning: () => false,
      startClaim: () => {},
      stopClaim: () => {},
      planWatcherRunning: () => false,
      startPlanWatcher: () => {},
      stopPlanWatcher: () => {},
      fleetRunning: () => false,
      startFleet: () => {},
      stopFleet: () => {},
      warmCaptchaPool: () => {},
      ...handles,
    },
    50,
  );
  watchers.push(w);
  return w;
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("watchConfigFile", () => {
  it("applies a per-request field change in place", async () => {
    writeFileSync(configPath(), BASE_YAML);
    const current = loadConfig(configPath());
    startWatcher(current);
    writeFileSync(configPath(), `${BASE_YAML}batchAsStream: false\n`);
    await waitFor(() => current.batchAsStream === false);
    expect(current.plan).toBe("coding-plan");
  });

  it("reports restart-only fields without applying them", async () => {
    writeFileSync(configPath(), BASE_YAML);
    const current = loadConfig(configPath());
    const portBefore = current.server.port;
    const lines = await captureConsoleLog(async () => {
      startWatcher(current);
      // Same write also flips a hot field, giving the reload an observable effect.
      writeFileSync(configPath(), `server:\n  port: 9999\n  host: 0.0.0.0\n${BASE_YAML}batchAsStream: false\n`);
      await waitFor(() => current.batchAsStream === false);
    });
    expect(current.server.port).toBe(portBefore);
    expect(lines.some((l) => l.includes("restart to apply"))).toBe(true);
  });

  it("keeps the running config on a broken file and stays watching", async () => {
    writeFileSync(configPath(), BASE_YAML);
    const current = loadConfig(configPath());
    startWatcher(current);
    writeFileSync(configPath(), "::: not yaml [");
    await new Promise((r) => setTimeout(r, 200));
    expect(current.plan).toBe("coding-plan");
    expect(current.batchAsStream).not.toBe(false);
    writeFileSync(configPath(), `${BASE_YAML}batchAsStream: false\n`);
    await waitFor(() => current.batchAsStream === false);
  });

  it("starts and stops the claim scheduler with the config toggle", async () => {
    writeFileSync(configPath(), BASE_YAML);
    const current = loadConfig(configPath());
    const calls: string[] = [];
    startWatcher(current, {
      claimRunning: () => calls.length > 0 && calls[calls.length - 1] === "start",
      startClaim: () => calls.push("start"),
      stopClaim: () => calls.push("stop"),
    });
    writeFileSync(configPath(), `${BASE_YAML.replace("enabled: false", "enabled: true")}  auto: true\n`);
    await waitFor(() => calls.includes("start"));
    writeFileSync(configPath(), BASE_YAML);
    await waitFor(() => calls.includes("stop"));
  });

  it("starts the plan watcher with the toggle and restarts it on a poll-interval change", async () => {
    writeFileSync(configPath(), BASE_YAML);
    const current = loadConfig(configPath());
    const calls: string[] = [];
    startWatcher(current, {
      planWatcherRunning: () => calls.length > 0 && calls[calls.length - 1] === "start",
      startPlanWatcher: () => calls.push("start"),
      stopPlanWatcher: () => calls.push("stop"),
    });
    writeFileSync(configPath(), `${BASE_YAML}planAutoSwitch: true\n`);
    await waitFor(() => calls.includes("start"));
    // A dirty planPollIntervalSec must restart the running watcher so the new
    // cadence reaches the timer (claim-block pattern).
    writeFileSync(configPath(), `${BASE_YAML}planAutoSwitch: true\nplanPollIntervalSec: 5\n`);
    await waitFor(() => calls.filter((c) => c === "start").length === 2);
  });
});
