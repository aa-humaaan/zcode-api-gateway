# Project Plan — From Proxy to Quota Gateway

> **Working title:** `zcode-gateway` (naming is a decision point — see §7)
> Status: DRAFT v1 — written 2026-10-06 after a full read of the codebase.
> This is our plan, not upstream's. Read it, tweak it, then we build.
>
> **Progress:** Phase 1 foundations LANDED (2026-10-06) — multi-account store
> with legacy migration (`src/accounts/store.ts`), account manager with events
> (`src/accounts/manager.ts`), shared crypto (`src/auth/crypto.ts`), account
> CLI (`accounts list|remove|enable|disable|rename`, fleet-aware
> `auth login/logout/status`).
>
> **Fleet router LANDED (2026-10-06, same session)** — `src/accounts/router.ts`:
> (account × plan) failover chain, staggered quota watcher (fail-open matrix,
> probe-success clears cooldowns), strategies `priority` / `round-robin` /
> `least-used`, per-entry cooldowns (10 min quota rejections, 30 min
> coding-plan key refusals), per-request chain walk in both the Anthropic/OpenAI
> handler and /v1/responses, clean 429s on exhaustion (with the tried-list) and
> while the whole fleet cools down. Config `accounts:` section + env overrides,
> hot-reload start/stop, fleet subsumes the single-account plan auto-switch.
> End-to-end verified against a local mock upstream (two accounts → full chain
> walk → clean 429). 1161 tests pass, typecheck clean.
>
> **Fleet UX LANDED (2026-10-07)** — `fleetSnapshot()` read-only status API;
> TUI **Fleet card** (rows with serving marker ◉, per-plan state chips ✓/✗/⏳/·,
> ratio percents, click-to-enable/disable, 15s refresh — no upstream calls);
> web panel **Fleet section** + control protocol `accounts` / `accountsMutate`
> (toggle applies live via immediate router re-sync); **fleet-wide auto-claim**
> (one scheduler per enabled JWT-holding account, fresh JWT per poll). 1169
> tests pass, typecheck clean, panel protocol verified end-to-end.
>
> **§3 COMPLETE (2026-10-07)** — remaining §3 items LANDED:
> • **/v1/responses** got the usage-ledger hook (batch + stream completions,
>   fleet-exhausted + key-refusal rows) AND virtual-key admission — the Codex
>   route can no longer bypass a key's caps/allowlist.
> • **Notifications** (`src/notify/notify.ts`, config `notifications:`):
>   generic webhook JSON + ntfy push, per-event dedupe (cooldownSec, default
>   300s), fire-and-forget with warn-once. Events: fleet_exhausted,
>   entry_cooldown, account_empty, pre_switch, key_cap, claim (scheduler got
>   an onEvent hook).
> • **Burn-rate projection + pre-switch (§3.3)**: the watcher keeps a probe
>   history of remaining-ratio readings per (account, plane); the slope
>   projects time-to-empty WITHOUT needing window capacity (refills reset the
>   history). `accounts.preSwitchMinutes` (0 = off, default): an account
>   projecting empty within the threshold stops receiving steady-state traffic
>   — the next account takes over BEFORE the 429 — while still serving as a
>   failover target; the fleet log line prints `burn projects empty in ~N`.
> 1195 tests pass, typecheck clean; responses-hook + webhook verified live.
> **Phase 1–3 of the plan are now fully built.**
>
> **§8 Panel-alongside-the-TUI LANDED (2026-10-07)** — `panel:` config section
> (env still wins; refuse-without-token unchanged), TUI starts the panel with
> lifecycle hooks delegating to the TUI's own start/stop/setConfig (phone and
> desktop are one source of truth), live proxyPort via serverRef getter,
> log tee into the panel buffer, panel closed on quit. 1207 tests green;
> config-only panel boot verified live. Milestone pushed: d1cd9e6 + fe14a37.
> **§7 Usage Dashboard LANDED (2026-10-07)** — control command `{"cmd":"usage","days"}`
> (clamped 1-365), ledger read-cache (stat-based, append-invalidated), panel
> **Usage card** (window switcher 1d/7d/30d persisted, by-day bars, 2×2
> tool/model/account/key breakdown with mini bars, 30s poll, mobile-collapse).
> Verified live: panel token → usage JSON with key+tool attribution.
> Fleet verified LIVE with two real accounts + opencode as the first real
> client (virtual key `opencode`, usage attributed end-to-end).
> **Test-isolation lesson:** server/async/mcp tests now isolate the virtual-key
> store (ZCODE_PROXY_STORE_DIR) — with real keys configured, the auth gate
> would 401 every keyless test request. Remaining ideas: multi-machine
> sync (§4), admin REST API, upstream health tracking/circuit breaker.

---

## 1. The Idea (what we're actually building)

Today this project is a **translator** — it takes your one ZCode login and speaks
OpenAI/Anthropic back to your tools. Useful, but it's a pipe.

We're evolving it into a **quota gateway**: one local endpoint in front of a
*fleet* of your own accounts that never lets a tool see "quota empty" again.

**The three sentences that define the product:**

1. **Fleet** — log into as many accounts as you own; when one runs dry, the
   next one serves the request automatically, mid-stream of your workday.
2. **Visibility** — one dashboard that answers "how much quota is left across
   everything, and which tool/agent is eating it?" (the official panels can't).
3. **Control** — give every tool its own virtual key, watch its spend, cap it
   if it misbehaves.

A tool (Claude Code, Codex, an agent swarm) points at `127.0.0.1:8080` once and
never knows or cares which account, plan, or provider is actually serving it.

---

## 2. Where the code is today (grounded facts)

What we inherit, verified by reading the source:

| Area | Current state |
|---|---|
| Credential storage | **One** credential in `~/.zcode-proxy/credentials.json`, AES-GCM encrypted (`src/auth/store.ts`) |
| Credential in memory | **One** slot in `AuthManager`; every subsystem calls `auth.getCredential()` (`src/auth/manager.ts`) |
| Login | OAuth device-style flow (browser link + poll), works headless; bigmodel also has paste mode (`src/auth/oauth.ts`) |
| Plan failover | `planAutoSwitch`: polls quota on both plan tiers of **the one account**, switches `start-plan` ↔ `coding-plan`, per-request fallback on 401/402/403/429/502/504 + 10-min cooldown (`src/plan/auto.ts`) |
| Quota probing | Two planes: trial points bucket (`billing/balance`) and coding-plan usage windows (5h / weekly) (`src/server/routes-quota.ts`) |
| Auto-claim | Background scheduler auto-claims free trial plans when the vendor drops them (`src/claim/`) |
| Idle channel | Off-peak ticket-queue bridge for free overnight compute (`src/async/`) |
| UI | Terminal panel (TUI) + optional web panel + web chat (`src/tui/`, `src/server/panel.ts`) |
| Ops | Hot-reloading YAML config, Docker, single-binary builds, 68 test files, error ledger (`errors.log`) |

**The key insight:** `planAutoSwitch` already solved the hard problem — watching
quota signals and failing over per-request with cooldowns — it just does it
across 2 plans of 1 account. We generalize that engine from
`plan → plan` to `account × plan → account × plan`. Everything else (storage,
login, UI) grows a list where it had a slot.

**Ground rules while we build:**
- Zero-config upgrade: one account in the store = today's exact behavior.
- Keep the fork mergeable — new code lives in new modules where possible
  (`src/accounts/`), existing files get surgical changes.
- Every phase lands with tests (the repo's 68 test files set the bar).

---

## 3. Phase 1 — Multi-Account Core (the headline)

**Goal: log into N accounts; the gateway routes around dead ones. CLI-first,
UI comes in Phase 2.**

### 1.1 Multi-account store → `src/accounts/store.ts`
- New file `~/.zcode-proxy/accounts.json`: a list of accounts, each =
  `{ id, label, provider, enabled, credential, addedAt }`.
- Same AES-GCM encryption, per-account, same secret derivation as today.
- **One-way migration:** existing `credentials.json` becomes account #1
  (label `default`) on first boot; old file untouched for a version, then
  optionally removed.
- `id` = stable random; `label` = human name ("work", "burner2"…).

### 1.2 Account manager → `src/accounts/manager.ts`
- Replaces the single-slot `AuthManager` (which stays as a thin adapter so
  existing call sites don't all change at once).
- `list() / add(cred) / remove(id) / get(id) / enabledIds()`; emits events
  (`added/removed/changed`) so watchers and UIs refresh themselves.
- Login flow unchanged — each `auth login` run resolves and **adds** an
  account instead of overwriting. Second login = second account.

### 1.3 CLI account commands
```
zk auth login [zai|bigmodel]     # add an account (existing flow)
zk accounts list                 # id, label, provider, plan, quota summary
zk accounts remove <label>
zk accounts enable|disable <label>
zk accounts rename <old> <new>
```

### 1.4 The fleet router → `src/accounts/router.ts` (the heart)
- Generalizes `src/plan/auto.ts`: the unit of routing becomes
  `(account, plan)` pairs — the **failover chain**.
- **Watcher:** polls quota for every enabled account × plan, staggered and
  rate-limit-aware (upstream throttles frequent quota calls; N accounts must
  not mean N× the hammering). Builds a live matrix:
  `account → { start-plan: usable?, coding-plan: usable? }`.
- **Selection strategies** (config `accounts.strategy`):
  - `priority` (default) — drain accounts in your order, top-down.
  - `round-robin` — spread load evenly across usable accounts.
  - `least-used` — route to the account with the most remaining headroom
    (needs Phase 3's ledger to be truly smart; until then approximates via
    quota planes).
- **Per-request failover:** reuse the existing rejection-signal table
  (start-plan: 401/402/403/429/502/504 + 200-with-error-envelope sniffing;
  coding-plan: 429). A rejected request retries down the whole chain —
  account 1's start-plan → account 1's coding-plan → account 2's start-plan → …
  — before the client ever sees an error.
- **Cooldowns per (account, plan),** not global: one dead account doesn't
  freeze the fleet; a 401 (dead token) flags the account itself and skips it
  until re-auth.
- **Exhaustion UX:** when the *entire* chain is dry, the client gets today's
  clean 429 — but the gateway logs which accounts were tried and why each
  refused, and (Phase 3) notifies you before it ever gets there.

### 1.5 Config
```yaml
accounts:
  strategy: priority          # priority | round-robin | least-used
  pollIntervalSec: 60         # fleet-wide quota probe cadence
  order: [work, burner2]      # labels; absent = store order
```
Single account + no `accounts:` section = today's behavior, byte for byte.

**Phase 1 exit test (the demo):** two accounts logged in, drain account 1
mid-request-stream, watch the very next request transparently served by
account 2. `zk accounts list` shows both with live quota.

---

## 4. Phase 2 — Fleet UX (make it visible)

**Goal: you can see and drive the fleet from the panel, phone included.**

### 2.1 TUI
- New **Accounts card**: one row per account — label, provider, plan in use,
  quota bar (per plane), `(active)` marker, `(cooldown)` / `(disabled)` states.
- Keys: `l` = add account (new login), `1–9` = inspect/switch focus,
  `d` = toggle disable, `r` = refresh all quotas.
- The existing plan-usage card becomes the *focused account's* detail.

### 2.2 Web panel
- Accounts page: cards/table with the same info, per-account login (the flow
  already works via link-on-any-device), logout, enable/disable.
- Live "fleet status" strip on the main page: which account is serving, chain
  health at a glance. Reachable from your phone → manage a homelab box.

### 2.3 Claim & async go fleet-wide
- Auto-claim runs for **every enabled account** (config: cap which accounts
  claim — maybe you only want trials on some).
- Off-peak `/async` submits across accounts: more tickets in flight = more
  free overnight compute.

---

## 5. Phase 3 — Visibility & Control (the "not just a proxy" phase)

**Goal: answer questions the official panels can't, and enforce limits they
don't have. This is the differentiator.**

### 3.1 Local usage ledger → `src/ledger/`
- Append-only JSONL (rotated, same pattern as `errors.log`): per request —
  timestamp, virtual key, tool/client, account, plan, model, tokens in/out,
  cache read/write, duration, outcome.
- Query layer + dashboard endpoints: totals by day / model / account / tool.
- **"Which agent ate my quota?"** — answered with a number, not a guess.

### 3.2 Virtual API keys → `src/keys/`
- `zk keys add claude-code` → issues a local key; tools auth with *their* key.
- Per-key labeling, usage attribution (from the ledger), optional spend caps
  (requests/day, tokens/day) and per-key model allowlists.
- Kill switch: revoke a key instantly without touching account credentials.
- Anonymous local use (no keys configured) stays exactly as open as today.

### 3.3 Burn-rate projection
- Ledger history × quota windows → "coding-plan 5h window empties in ~2h 10m
  at current pace."
- **Pre-switch:** the router starts warming the next account *before* the hard
  429, not after. Threshold configurable.

### 3.4 Notifications
- Events: account empty / token expired / trial claimed / fleet dry /
  key hit its cap / upstream outage.
- Sinks: system toast, Discord/Slack webhook, ntfy.sh (phone push). All
  opt-in, all local config, no telemetry leaves the machine by default.

---

## 6. Phase 4 — Reliability & Scale (polish that compounds)

- **Upstream health tracking:** rolling per-endpoint latency + error rates;
  circuit breaker per endpoint; the failover chain learns to deprioritize a
  flaky region before it 504s.
- **Provider failover:** fleet spans zai *and* bigmodel accounts
  (providers are already abstracted — this mostly falls out of Phase 1).
- **Admin API:** everything the web panel can do, exposed as clean REST, so
  power users can script the gateway from other tools.
- **Multi-machine sync (optional, last):** export/import an encrypted account
  bundle + ledger merge. Explicit, manual, never silent.

---

## 7. Feature plan — Usage Dashboard in the Web Panel

> Status: **LANDED (2026-10-07)** — all four build steps shipped, 1199 tests green.
> This completes the §3.1 promise ("query layer + dashboard endpoints") and the
> Phase-2 UX story: the panel becomes the one-stop dashboard, phone-visible.

### 10.1 Goal

Answer, from a phone or any browser, the question the ledger was built for —
**"which tool ate which account's quota, on which model, when?"** — without
touching a terminal. The data already exists (`usage.log` + `summarizeUsage`
+ `GET /usage`); this plan renders it where the operator already is: the web
panel.

### 10.2 UX spec

A new **Usage** card in `panel-page.txt`, placed between the Fleet section and
Logs. Pure HTML/CSS/JS — no chart library, no build step, same styling family
as the existing cards (`.bar` track/fill pattern, `--ok/--warn/--danger`
palette). Layout:

```
┌ Usage ───────────────── [1d] [7d] [30d] · updated 14:32:08 ┐
│ 7 days: 342 requests · 1.8M tokens · 2 failed ⚠            │
│                                                            │
│ By day       ████████░░░░░░░░░░  62 req · 412K tok         │
│              ██████████████████  81 req · 503K tok         │
│                                                            │
│ By tool                By model                            │
│  claude-cli  301 ▓▓▓▓▓▓▓   glm-5.3    210 ▓▓▓▓▓            │
│  opencode     41 ▓▓        glm-4.6    132 ▓▓▓              │
│                                                            │
│ By account             By key                              │
│  work        250 ▓▓▓▓▓▓▓   claude-code 301 ▓▓▓▓▓▓▓         │
│  trial        92 ▓▓▓       opencode      41 ▓▓             │
└────────────────────────────────────────────────────────────┘
```

Behavior:

- **Window selector** — `1d / 7d / 30d` buttons; choice persists in
  `localStorage` (`zcode.panel.usageDays`); selection re-fetches immediately.
- **Totals row** — requests, tokens (compact units: `1.8M`, `412K`), failed
  count with a red badge only when > 0.
- **By-day bars** — chronological, one bar per day; fill width = day's
  requests relative to the busiest day (tokens shown as text, so one busy
  token-heavy day doesn't visually flatten the request trend).
- **Top lists** — by tool / model / account / key in a 2×2 grid; each row
  shows name, request count, and a mini bar for its share of total requests.
  Lists capped at 6 rows with an `+N more` footer (the CLI `usage` command
  remains the full-precision view).
- **Refresh** — auto-poll every **30s** (a local-file read, cheap — unlike
  Quota, which stays manual because the billing gateway rate-limits), plus a
  manual refresh button; `updated HH:MM:SS` caption like the Quota card.
- **Empty state** — "No usage recorded yet — serve some requests first."
- **Mobile** — the 2×2 grid collapses to a single column under 600px
  (one media query, consistent with the panel's responsive header).

### 10.3 Data flow (no new auth surface)

The panel keeps its existing security model: browser → `POST /api/control`
(panel token) → in-process dispatcher. It NEVER calls the proxy port (8080)
from the panel page — that would need a second credential in the browser and
a CORS conversation. One new control command mirrors `quota`:

```
{ cmd: "usage", days?: number }
  → { ok: true, event: "usage", usage: UsageSummary }
```

- `control.ts`: extend `ControlCommand` / `ControlOk`; `HandlerContext` gains
  `onUsage?: (days: number) => Promise<UsageSummary>`.
- `index.ts` (`startServePanel`): wire
  `onUsage: (days) => summarizeUsage(readUsageDays(days), days)` — pure local
  file read, no upstream calls, cannot fail serving.
- `days` clamps to 1–365 (same rule as `GET /usage`).

### 10.4 Backend polish (small, included)

1. **mtime cache in the ledger read** — `readUsageDays` memoizes
   `(path, mtime, size)` and re-parses only when the file actually changed;
   makes the 30s poll ~free even on a multi-MB ledger. Cache invalidates on
   `__resetUsageLogForTests`.
2. No schema changes: shares/percentages are computed client-side from
   `totalRequests` / `totalTokens`, so `summarizeUsage` stays untouched.

### 10.5 Edge cases

- **Empty ledger** → empty state card (no JS errors on zero-length arrays).
- **Malformed ledger lines** — already skipped by `parseLine`; dashboard must
  tolerate a summary with empty `byDay` (never happened ≠ 0 days).
- **Rotation mid-window** — `readUsage` reads `usage.log.1` + `usage.log`, so
  a 30d window spanning a rotation stays complete (already handled).
- **Tokens = 0 rows** (cap-refused / 401 requests) — they count as requests,
  show zero tokens; no division by zero when totals are 0 (bar width 0).
- **Clock skew** — `day` is the operator's local date (ledger semantics);
  nothing new to solve, just documented behavior for the by-day axis.

### 10.6 Tests

| Test | Asserts |
|---|---|
| control dispatcher: `usage` command | Returns `event: "usage"` with a summary; unknown/absent hook → `usage_unavailable` error envelope |
| control dispatcher: `days` clamp | `days: 0 / -5 / 99999` → clamped to 1 / 1 / 365 before the hook runs |
| ledger: mtime cache | Second `readUsageDays` with unchanged file returns the cached parse (spy on file reads or assert via append → new data visible) |
| ledger: cache invalidation | Append → next read sees the new line; `__resetUsageLogForTests` clears the cache |
| panel smoke (end-to-end) | Boot serve + mock upstream, fire 3 requests, `POST /api/control {"cmd":"usage","days":1}` with the panel token → JSON totals match; without token → 401 |

### 10.7 Exit test

Open the panel on a phone, switch 1d ↔ 7d ↔ 30d, and answer in five seconds:
which tool consumed today's quota, from which account, on which model —
without opening a terminal.

### 10.8 Effort & order

| # | Piece | Size |
|---|---|---|
| 1 | Control command + hook wiring + dispatcher tests | S |
| 2 | Ledger mtime cache + tests | S |
| 3 | Panel section: HTML + renderer JS + polling | M (the bulk) |
| 4 | End-to-end smoke + PLAN.md progress update | S |

One session of work. Nothing here changes serving behavior, the TUI, or any
auth surface — strictly additive to the panel and the control protocol.

### 10.9 Deliberately out of scope (revisit later if wanted)

- Per-request drill-down table (the raw JSONL rows) — the ledger file and
  `--cli usage` cover auditing; a filterable request table is a bigger UI.
- Token *input* vs *output* split — the ledger records output tokens today;
  input tracking would need SSE usage taps per route (a ledger v2 topic).
- Charts in the TUI — TUI stays quota/fleet focused; the panel is the
  dashboard surface.

---

## 8. Feature plan — Panel alongside the TUI (+ `panel:` in config.yaml)

> Status: **LANDED (2026-10-07)** — both parts shipped; TUI wiring needs the operator's manual exit test (TTY).
> Motivation (live, 2026-10-07): the operator launched the TUI, opened
> `127.0.0.1:8090` on a phone and got ERR_CONNECTION_REFUSED — the panel is
> serve-mode-only today, so the dashboard requires giving up the TUI.

### 8.1 Goal

One process, both surfaces: the **TUI on the desktop screen** and the **web
panel on a phone**, showing the SAME state (proxy running/stopped, fleet,
usage, logs) with no env-var-per-terminal-session dance. Plus `panel:` as a
first-class config.yaml section so enabling the panel is a one-time setting.

### 8.2 Part 1 — `panel:` config section (small)

Today the panel resolves from env only (`ZCODE_PANEL_ENABLED` /
`ZCODE_PANEL_TOKEN` / `ZCODE_PANEL_PORT` in server/panel.ts). Add YAML:

```yaml
panel:
  enabled: true
  token: "pick-a-long-secret"   # mandatory when enabled (unchanged contract)
  port: 8090                    # loopback only (unchanged)
```

- `config/types.ts`: `PanelConfig { enabled: boolean; token?: string; port?: number }`;
  `ProxyConfig.panel?` (loader always sets it, fixtures may omit).
- `loader.ts`: `resolvePanelConfig` — env wins over YAML (existing convention).
- `server/panel.ts`: `resolvePanelSettings(env)` gains an optional YAML input —
  resolution order: env > yaml > default, the CONTRACT is unchanged: no
  non-empty token, no panel (loud warn, never a silent unauthenticated panel).
- Template + config.example.yaml: commented `panel:` block.
- Works in BOTH modes from then on (serve behavior unchanged; TUI picks it up
  in Part 2).

### 8.3 Part 2 — TUI starts the panel when enabled (the bulk)

The TUI already holds everything the serve panel needs (config, path, auth,
`serverRef`). The work is bridging state, not building UI:

1. **Export `startServePanel`** from index.ts (it is module-private today) and
   make its ctx work for the TUI: same `config / path / auth / serverRef /
   fleet / shutdown` shape.
2. **Log tee bridge**: the TUI routes every console line into its `LogPane`
   (log-pane.ts); the panel's Logs card reads a `LogBuffer` (control.ts).
   The TUI's `emit()` pushes into BOTH — one extra call, zero duplication of
   log content.
3. **Single source of truth for the proxy state**: the panel's
   `startProxy` / `stopProxy` / `setConfig` hooks call the TUI's own
   lifecycle functions (which update `state.serverStatus` and render), so a
   stop from the phone flips the desktop TUI card to `○ stopped` on the next
   frame — and vice versa. The dispatcher's `controlState.proxyPort` is
   updated by the same hooks.
4. **`shutdown` from the panel routes through the TUI's `quit()`** (terminal
   restore + clean exit), not the bare serve shutdown path.
5. Panel lifecycle: started once alongside the TUI boot (after config load,
   before the first render so the URL line lands in the logs); a failed panel
   start warns and continues — the TUI must never die because the panel
   could not bind (same rule as serve).

### 8.4 Edge cases

- **Token missing while enabled** → loud warn in the TUI logs, no panel (the
  existing refuse-to-start contract, unchanged).
- **Port already bound** (second gateway instance) → warn-and-continue, the
  TUI keeps running.
- **Panel stopProxy while a stream is in flight** → identical semantics to
  the serve panel today (server stop closes in-flight streams) — the phone is
  the operator, by definition.
- **Serve mode** must remain byte-for-byte identical; Part 2 touches only the
  TUI boot path.

### 8.5 Security (unchanged)

Loopback bind only; token mandatory and compared constant-time; the panel
never exposes `/v1/*` credentials. YAML just moves WHERE the token lives, not
whether it is required.

### 8.6 Tests

| Test | Asserts |
|---|---|
| loader: `panel:` section | YAML parse, env-over-YAML precedence, invalid values throw |
| panel.ts: `resolvePanelSettings` with YAML input | enabled+token from YAML; env overrides; token missing → null (+ warn) in both modes |
| control hooks | already covered by panel.test.ts (dispatcher is shared) |
| TUI wiring | manual exit test (TTY) — no synthetic TUI harness; the wiring is 4 hook functions |

### 8.7 Exit test

Start the TUI (panel enabled in config.yaml), open the phone, and: the
dashboard shows the proxy as running; press Stop on the phone; the desktop
TUI card flips to `○ stopped` within one frame; press Start on the phone; the
TUI flips back. Usage and Fleet on the phone reflect the same two real
accounts.

### 8.8 Effort & order

| # | Piece | Size |
|---|---|---|
| 1 | `panel:` config section + loader + template + tests | S |
| 2 | `startServePanel` export + hook-based ctx refactor | S |
| 3 | TUI wiring: log tee bridge + lifecycle hooks + boot/shutdown | M |
| 4 | Smoke + PLAN.md progress update | S |

---

## 9. Decision points (where I want your tweaks)

1. **Name & identity.** Repo says `zcode-api-gateway`. Binary/package name,
   TUI branding — pick something ownable or keep this. (Needs deciding by
   Phase 2.)
2. **Default strategy.** I propose `priority` (you order accounts, we drain
   top-down) because it matches "use the trial first, save the paid one."
   Say the word if you want `round-robin` default instead.
3. **Phase 3 scope.** Virtual keys + ledger is real work. If you want the
   MVP sooner, we can ship Phase 1+2 and decide Phase 3 after dogfooding.
4. **Claim policy per account** — all accounts claim trials, or opt-in list?
5. **One thing I won't compromise on:** keeping single-account behavior
   perfect. It's the upgrade path for every existing user of the fork.

## 10. Risks & honesty corner

- **Multi-account vs. vendor ToS.** Running several *own* accounts through one
  local client is a gray zone with any vendor. This stays a local tool for
  your own accounts; no sharing/relay features will be built. If the vendor
  tightens enforcement we adapt, but I won't build detection-evasion —
  this is the same traffic the official client makes, just scheduled smarter.
- **Quota-poll rate limits.** Upstream throttles quota endpoints; fleet
  polling must stagger (planned in 1.4) or the watcher itself gets 429'd.
- **Fork drift.** Upstream moves fast (reverse-engineered protocol shifts).
  Mitigation: new modules over edits, monthly upstream merge ritual, the
  protocol-touching files (`oauth.ts`, `resolver.ts`, signing) get minimal
  changes so merges stay boring.

## 11. Build order & rough effort

| # | Deliverable | Size |
|---|---|---|
| 1 | Accounts store + migration + manager (1.1–1.3) | S–M |
| 2 | Fleet router + watcher + failover chain (1.4–1.5) | **M–L (the heart)** |
| 3 | TUI + panel fleet views (Phase 2) | M |
| 4 | Ledger + virtual keys (3.1–3.2) | M |
| 5 | Projections + notifications (3.3–3.4) | S–M |
| 6 | Health tracking + provider failover (Phase 4) | M |

Each step lands green: tests + a working binary. We dogfood every step on your
real accounts before moving on.

---

*Next action once you've tweaked this: Phase 1, step 1 — the accounts store
with migration. Everything else hangs off it.*
