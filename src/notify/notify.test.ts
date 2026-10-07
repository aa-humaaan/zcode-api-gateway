/**
 * Tests for the notification module: sink delivery shapes, dedupe window,
 * silence when unconfigured, fire-and-forget failure isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { notify, configureNotify, __resetNotifyForTests } from "./notify.js";
import type { ProxyConfig } from "../config/types.js";

let calls: Array<{ url: string; init: RequestInit }> = [];
let failUrls: Set<string> = new Set();

// bun-types' fetch carries a `preconnect` member the fake doesn't need.
const fakeFetch = ((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  calls.push({ url: String(url), init: init ?? {} });
  if (failUrls.has(String(url))) return Promise.reject(new Error("boom"));
  return Promise.resolve(new Response(null, { status: 200 }));
}) as unknown as typeof fetch;

function configWith(opts: { webhook?: string; ntfy?: string; cooldownSec?: number }): ProxyConfig {
  return {
    notifications: opts,
  } as unknown as ProxyConfig;
}

beforeEach(() => {
  __resetNotifyForTests();
  calls = [];
  failUrls = new Set();
});

afterEach(() => {
  __resetNotifyForTests();
});

describe("notify", () => {
  it("is silent when no sinks are configured", () => {
    configureNotify({} as ProxyConfig);
    notify("fleet_exhausted", "msg");
    expect(calls.length).toBe(0);
  });

  it("delivers webhook JSON and ntfy body with title headers", () => {
    configureNotify(configWith({ webhook: "https://hooks.example/x", ntfy: "https://ntfy.sh/topic" }));
    notify("key_cap", "cap hit", { fetchImpl: fakeFetch });
    expect(calls.length).toBe(2);
    const webhook = calls.find((c) => c.url.includes("hooks.example"))!;
    const body = JSON.parse(String(webhook.init.body));
    expect(body.service).toBe("zcode-proxy");
    expect(body.event).toBe("key_cap");
    expect(body.message).toBe("cap hit");
    expect(typeof body.ts).toBe("string");

    const ntfy = calls.find((c) => c.url.includes("ntfy.sh"))!;
    expect(ntfy.init.body).toBe("cap hit");
    expect((ntfy.init.headers as Record<string, string>).Title).toContain("key_cap");
  });

  it("dedupes the same event within the cooldown window, different events pass", () => {
    configureNotify(configWith({ webhook: "https://hooks.example/x", cooldownSec: 300 }));
    notify("fleet_exhausted", "one", { fetchImpl: fakeFetch });
    notify("fleet_exhausted", "two", { fetchImpl: fakeFetch });
    notify("key_cap", "three", { fetchImpl: fakeFetch });
    expect(calls.length).toBe(2); // exhausted + key_cap; the repeat was dropped
  });

  it("a send failure never throws and never blocks the caller", () => {
    configureNotify(configWith({ webhook: "https://hooks.example/fail" }));
    failUrls.add("https://hooks.example/fail");
    expect(() => notify("claim", "x", { fetchImpl: fakeFetch })).not.toThrow();
  });

  it("a broken URL config never crashes configureNotify-adjacent code paths", () => {
    // Loader validates URLs; this guards direct programmatic config anyway.
    configureNotify(configWith({ webhook: "notaurl" }));
    expect(() => notify("claim", "x")).not.toThrow();
  });
});
