/**
 * Bundled config template — inlined as a string constant so it compiles into
 * the single-file binary (`bun build --compile`) without requiring a sidecar
 * `config.example.yaml` file at runtime.
 *
 * Source of truth: config.example.yaml at repo root. When editing the schema,
 * update BOTH this file AND config.example.yaml to keep them in sync.
 */

export const EXAMPLE_CONFIG_YAML: string = `server:
  port: 8080
  host: "0.0.0.0"

auth:
  # Key that clients must provide to use the proxy.
  # Set to null/omit to disable client auth.
  proxyApiKey: "your-proxy-secret"

  # Upstream credentials come from the OAuth login flow — run this first:
  #   bun run src/index.ts auth login <zai|bigmodel>
  # Parsed but currently not honored — the credential store path is fixed at
  # ~/.zcode-proxy/credentials.json:
  # oauthCredentialsPath: "~/.zcode-proxy/credentials.json"

# Which upstream provider to use: "zai" or "bigmodel"
provider: zai

# Which plan tier to use:
#   "coding-plan" (default) — direct upstream endpoints, permanent API key
#   "start-plan"            — routes through zcode.z.ai with JWT auth (requires \`auth login\`)
plan: coding-plan

# Hybrid plan auto-switch: while on, the watcher keeps traffic on the first
# plan in \`planPriority\` whose watched signals still have quota, and a
# request a plan rejects falls to the next plan for that one request. The
# \`plan\` key above then only applies while this is off. Flag off = no
# auto-switching and no fallback at all.
# Env override: ZCODE_PLAN_AUTO_SWITCH
planAutoSwitch: false

# Plan preference order for the auto-switch: the first plan with quota
# serves every request. Defaults to [start-plan, coding-plan] (prefer the
# trial). Coding-first example below: the coding plan serves until its 5-hour
# (TIME_LIMIT) or weekly (WEEK_LIMIT) window empties, then start-plan takes
# over. Env override: ZCODE_PLAN_PRIORITY (comma-separated).
# planPriority:
#   - coding-plan
#   - start-plan

# Which signals make each plan "not enough" for the switch (the first plan
# in planPriority whose watched signals still have quota serves). coding-plan
# rows are monitor-plane window types (TIME_LIMIT = 5h, WEEK_LIMIT = weekly);
# start-plan watches the trial BALANCE. Omitted plan = watch every signal.
# planSwitchRules:
#   coding-plan:
#     limits: ["TIME_LIMIT", "WEEK_LIMIT"]
#   start-plan:
#     limits: ["BALANCE"]

# Auto-switch poll interval in seconds (default 30; a change applies live).
# Env override: ZCODE_PLAN_POLL_INTERVAL_SEC
# planPollIntervalSec: 30

# Fleet router (multi-account): log in several accounts (repeat \`auth login\`)
# and the gateway routes around the ones that run dry. While off, the ACTIVE
# account (first enabled in the accounts store) serves exactly as before.
# Env overrides: ZCODE_ACCOUNTS_ENABLED / ZCODE_ACCOUNTS_STRATEGY /
# ZCODE_ACCOUNTS_POLL_INTERVAL_SEC
# accounts:
#   enabled: true
#   # How to pick the serving account while several still have quota:
#   #   priority    — drain accounts in store order (accounts list), top-down
#   #   round-robin — spread requests evenly across usable accounts
#   #   least-used  — the account with the most remaining quota headroom
#   strategy: priority
#   # Fleet quota-probe cadence in seconds (probes are staggered per account
#   # so the fleet never hammers the quota endpoints). Applies live.
#   pollIntervalSec: 60
#   # Pre-switch (0 = off): when an account projects empty within this many
#   # minutes (burn-rate slope over recent probes), new traffic steers to the
#   # next account BEFORE the hard 429. Try 10.
#   preSwitchMinutes: 0

# Local event notifications (both sinks opt-in; events deduped per kind).
# Env overrides: ZCODE_NOTIFY_WEBHOOK / ZCODE_NOTIFY_NTFY
# notifications:
#   webhook: ""            # receives {service, event, message, ts} JSON POSTs
#   ntfy: ""               # e.g. https://ntfy.sh/your-private-topic (phone push)
#   cooldownSec: 300       # min seconds between repeats of the same event

providers:
  zai:
    anthropicBase: "https://api.z.ai/api/anthropic"
    openaiBase: "https://api.z.ai/api/coding/paas/v4"
  bigmodel:
    anthropicBase: "https://open.bigmodel.cn/api/anthropic"
    openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4"

defaultModel: glm-4.6

models:
  - glm-4.5-air
  - glm-4.6
  - glm-4.6v
  - glm-4.7
  - glm-5
  - glm-5-turbo
  - glm-5v-turbo
  - glm-5.1
  - glm-5.2
  - glm-5.3
  - glm-5.3-flash

# Configurable identity headers injected on every upstream request to mimic the
# ZCode desktop client (User-Agent, X-ZCode-App-Version, X-Title,
# X-ZCode-Agent, HTTP-Referer). Runtime platform headers (X-Platform,
# X-Os-Category, X-Os-Version) are detected dynamically and are not configured
# here. All fields below are optional; env vars override YAML, which overrides
# defaults.
identity:
  # Mirrors process.env.ZCODE_APP_VERSION in the ZCode bundle.
  # Must be printable ASCII; non-conforming values fall back to the default.
  # Default: "3.14.0" (current ZCode release). Override to match your real client.
  appVersion: "3.14.0"
  # X-Title suffix → "Z Code@{sourceTitle}". Default "cli".
  sourceTitle: "cli"
  # HTTP-Referer URL. Default "https://zcode.z.ai".
  refererOrigin: "https://zcode.z.ai"
  # Device identity (X-Device-Mid) — random UUIDv4, generated ONCE and reused
  # forever (mirrors ZCode's telemetry deviceMid; no hardware values involved).
  # Auto-generated into this file at first \`auth login\` or config creation.
  # Leave empty when ZCODE_IDENTITY_DEVICE_MID supplies the mid via env instead.
  deviceMid: ""

# Local client-session inference for cache-affinity experiments.
# "observe" (default) logs inferred sessions in debug mode but does not change
# upstream x-session-id. "enforce" reuses a stable x-session-id for inferred
# coding-plan sessions. "off" disables inference entirely.
clientIdentity:
  mode: observe
  ttlSeconds: 900
  maxSessions: 1024

# Server-controlled upstream URL remapping (mirrors the ZCode client's
# ProviderEndpointRoutingService). The proxy periodically fetches
# {origin}/api/v1/agent/configs and rewrites matching upstream URLs per the
# returned proxyEndpoint.mapping table (currently the coding-plan Anthropic
# endpoints -> zcode.z.ai ultra endpoints). Fail-open: any fetch/parse error
# keeps the original URLs. Env override: ZCODE_ENDPOINT_ROUTING=false.
endpointRouting:
  enabled: true
  origin: "https://zcode.z.ai"

# Client request signing V4 (mirrors the ZCode 3.9.1 ClientRequestSigningV4Signer).
# When enabled, the proxy probes {origin}/api/v1/agent/configs (cached 1h) and,
# only if the server sets data.codingPlanSignature.enable=true, signs coding-plan
# requests: handshake against {provider}/api/paas/c1f3a7e2/v2/client, Ed25519
# signature + proof-of-work headers on every request, fail-open retry ladder
# (two 401 VERIFY rejections -> permanent unsigned bypass). Start-plan and
# off-peak paths are never signed. Env override: ZCODE_CLIENT_SIGNING=false.
clientSigning:
  enabled: true
  origin: "https://zcode.z.ai"

logging:
  level: info
`;
