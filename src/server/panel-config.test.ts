/**
 * Tests for the `panel:` config section (PLAN §8.1) and the YAML-aware
 * resolvePanelSettings (§8.2): env-over-YAML precedence, port validation,
 * and the unchanged refuse-without-token contract in BOTH modes.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { resolvePanelSettings } from "./panel.js";
import { loadConfig } from "../config/loader.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_KEYS = ["ZCODE_PANEL_ENABLED", "ZCODE_PANEL_TOKEN", "ZCODE_PANEL_PORT"] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

function configFromYaml(yaml: string): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(join(tmpdir(), "panel-config-test-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, yaml, "utf-8");
  try {
    return loadConfig(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("panel: config section (loader)", () => {
  it("parses enabled/token/port from YAML", () => {
    const config = configFromYaml("panel:\n  enabled: true\n  token: sec\n  port: 9001\n");
    expect(config.panel).toEqual({ enabled: true, token: "sec", port: 9001 });
  });

  it("defaults to disabled with no section", () => {
    const config = configFromYaml("provider: zai\n");
    expect(config.panel).toEqual({ enabled: false });
  });

  it("env vars win over YAML", () => {
    process.env.ZCODE_PANEL_ENABLED = "0";
    process.env.ZCODE_PANEL_TOKEN = "env-token";
    const config = configFromYaml("panel:\n  enabled: true\n  token: yaml-token\n  port: 9001\n");
    expect(config.panel!.enabled).toBe(false);
    expect(config.panel!.token).toBe("env-token");
    expect(config.panel!.port).toBe(9001); // no env port → yaml port stands
  });

  it("an out-of-range port throws", () => {
    expect(() => configFromYaml("panel:\n  enabled: true\n  port: 99999\n")).toThrow(/panel.port/);
  });
});

describe("resolvePanelSettings — YAML-aware (§8.2)", () => {
  it("yaml-only enablement starts the panel", () => {
    const settings = resolvePanelSettings({}, { enabled: true, token: "yaml-secret", port: 9002 });
    expect(settings).toEqual({ token: "yaml-secret", port: 9002 });
  });

  it("env token wins over yaml; env disable wins over yaml enable", () => {
    process.env.ZCODE_PANEL_TOKEN = "env-secret";
    const withEnvToken = resolvePanelSettings(process.env, { enabled: true, token: "yaml-secret" });
    expect(withEnvToken!.token).toBe("env-secret");

    process.env.ZCODE_PANEL_ENABLED = "0";
    expect(resolvePanelSettings(process.env, { enabled: true, token: "x" })).toBeNull();
  });

  it("enabled without ANY token → null in both modes (unchanged contract)", () => {
    expect(resolvePanelSettings({ ZCODE_PANEL_ENABLED: "1" }, undefined)).toBeNull();
    expect(resolvePanelSettings({}, { enabled: true })).toBeNull();
  });

  it("default port is 8090 when neither source sets one", () => {
    expect(resolvePanelSettings({}, { enabled: true, token: "t" })!.port).toBe(8090);
  });
});
