/**
 * POST /v1/responses request handler.
 *
 * Pipeline:
 *   1. Parse body + credential.
 *   2. Resolve `previous_response_id` via `ResponseStore` (prepend stored history).
 *   3. Translate Responses → Chat Completions (`responsesToChatCompletions`):
 *        - function / custom / namespace / tool_search tools → Chat tools.
 *        - web_search / web_search_preview / file_search / code_interpreter /
 *          computer_use / image_generation / mcp → stripped silently.
 *   4. Apply the standard body transform (stream_options, user_id, start-plan system).
 *   5. POST to the GLM Chat Completions upstream (reuse `buildUpstreamRequest`).
 *   6. Translate the Chat response → Responses (`chatCompletionsToResponses`
 *      or `chatChunkToResponsesEvents` for streaming).
 *   7. Store the new response under its id (unless `store:false`).
 *
 * State management: in-memory only (process restart clears the store); see
 * `responses/store.ts`.
 */
import { transformRequestBody } from "./body-transformer.js";
import { getProvider } from "../provider/providers.js";
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { buildUpstreamRequest, buildUpstreamHeaderPairs, type UpstreamHeaderPair } from "./upstream.js";
import { isCaptchaChallenged, retryOnCaptchaChallenge } from "./captcha-retry.js";
import { CLIENT_ABORTED_BEFORE_CONNECT, dispatchWithConnectRetry, retryOnGatewayError, withStreamEnabled, isEventStream, upstreamCodings, upstreamRequestId } from "./handler.js";
import { clientTraceFields } from "./client-session.js";
import { collectAnthropicMessage } from "./sse-collector.js";
import { appendErrorLog } from "./error-log.js";
import type * as CaptchaExports from "./captcha.js";

// Lazy, runtime-gated module load (exception to the static-import rule, same
// as handler.ts): pulling captcha.ts eagerly drags in the happy-dom solver, so
// only start-plan — the one plan whose upstream is captcha-gated — pays for it.
type CaptchaModule = typeof CaptchaExports;
let captchaModule: CaptchaModule | null = null;
async function loadCaptcha(): Promise<CaptchaModule> {
  if (!captchaModule) captchaModule = await import("./captcha.js");
  return captchaModule;
}
import { getDefaultEndpointRouting, type EndpointRoutingService } from "./endpoint-routing.js";
import { getDefaultClientSigning, sendWithClientSigning, type ClientSigningManager } from "./client-signing.js";
import { buildAnthropicMetadataUserId } from "./trace-headers.js";
import { credentialString, type Credential } from "../auth/types.js";
import { translateRequestOpenAIToAnthropic, translateResponseAnthropicToOpenAI } from "../translator/openai-to-anthropic.js";
import { anthropicSseToOpenaiSse, AnthropicStreamError } from "../translator/sse-translator.js";
import type { AnthropicMessagesRequest, AnthropicMessagesResponse } from "../translator/types.js";
import type { ProviderDef } from "../provider/types.js";
import {
  responsesToChatCompletions,
  ToolTranslationError,
} from "../translator/responses-to-chat.js";
import {
  chatCompletionsToResponses,
  chatChunkToResponsesEvents,
  finalizeResponsesStream,
  failResponsesStream,
  newResponsesStreamState,
  responsesEventToSse,
} from "../translator/chat-to-responses.js";
import {
  generateResponsesId,
  type ResponsesInputItem,
  type ResponsesRequest,
  type ResponsesResponse,
  type ResponsesStreamEvent,
  type ResponsesOutputItem,
} from "../translator/responses-types.js";
import { ResponseStore, type StoredResponse } from "../responses/store.js";
import { errorResponse, readBody, InflatedBodyTooLargeError, unreachableMessage } from "./handler.js";
import { activePlan, planPriorityOf, retryOnPlanExhausted, shouldFallbackPlan, sniffStartPlanRejection, type PlanTier } from "../plan/auto.js";
import { pickServing, credentialOf, walkFleetChain, evaluateFleetResponse, fleetChain, type FleetRouter, type ChainEntry } from "../accounts/router.js";
import { appendUsage } from "../ledger/ledger.js";
import { resolveRequestKey, admitRequest } from "../keys/keys.js";

export interface ResponsesHandlerOptions {
  config: ProxyConfig;
  auth: AuthManager;
  /** Response store; if absent, `previous_response_id` always 404s. */
  responseStore?: ResponseStore;
  /** DI seam for tests. */
  fetchImpl?: typeof fetch;
  /** Verbose per-request diagnostics. */
  debug?: boolean;
  /** Override the process-wide endpoint routing service (for testing). `null` disables. */
  endpointRouting?: EndpointRoutingService | null;
  /** Override the process-wide client signing manager (for testing). `null` disables. */
  clientSigning?: ClientSigningManager | null;
  /** Override the lazily-imported captcha module (for testing). */
  captcha?: CaptchaModule;
  /**
   * Fleet router (multi-account failover) when `accounts.enabled` is on —
   * mirrors handler.ts: strategy-aware pick, chain-walk failover, provider
   * rebuilds per target entry.
   */
  fleet?: FleetRouter;
}

/** Handle POST /v1/responses. */
export async function handleResponses(
  clientReq: Request,
  opts: ResponsesHandlerOptions,
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const debug = opts.debug === true;
  const start = Date.now();

  // ── 1. parse body ──
  let rawBody: string;
  try {
    rawBody = (await readBody(clientReq)) ?? "";
  } catch (err) {
    if (err instanceof InflatedBodyTooLargeError) {
      return errorResponse(413, "request_too_large", err.message);
    }
    return errorResponse(400, "invalid_request", `could not read request body: ${(err as Error).message}`);
  }
  let req: ResponsesRequest;
  try {
    req = JSON.parse(rawBody) as ResponsesRequest;
  } catch (err) {
    return errorResponse(400, "invalid_request", `request body is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof req.input !== "string" && !Array.isArray(req.input)) {
    return errorResponse(400, "invalid_request", "`input` must be a string or an array");
  }
  if (typeof req.model !== "string" || req.model.length === 0) {
    return errorResponse(400, "invalid_request", "`model` is required");
  }

  const stream = req.stream === true;
  // Client correlation ids for the error-log entries below (headers only).
  const traceFields = clientTraceFields(clientReq);

  // ── 2. resolve previous_response_id ──
  let historyItems: ResponsesInputItem[] = [];
  let prevId: string | undefined;
  if (typeof req.previous_response_id === "string" && req.previous_response_id.length > 0) {
    if (!opts.responseStore) {
      return errorResponse(404, "response_store_disabled", "`previous_response_id` was supplied but the response store is not configured");
    }
    const prev = opts.responseStore.get(req.previous_response_id);
    if (!prev) {
      return errorResponse(404, "response_not_found", `previous_response_id ${req.previous_response_id} not found (response store is in-memory; entries are lost on restart and after the TTL)`);
    }
    prevId = req.previous_response_id;
    historyItems = [...prev.input, ...outputItemsAsInputItems(prev.output)];
  }

  // ── 3. translate Responses → Chat Completions ──
  const input: ResponsesInputItem[] = typeof req.input === "string"
    ? [...historyItems, { type: "message", role: "user", content: req.input }]
    : [...historyItems, ...req.input];
  const reqWithHistory: ResponsesRequest = {
    ...req,
    input,
  };
  let translated;
  try {
    translated = responsesToChatCompletions(reqWithHistory);
  } catch (err) {
    if (err instanceof ToolTranslationError) {
      return errorResponse(400, "tool_translation_error", err.message);
    }
    throw err;
  }
  const { chatRequest, customToolNames, namespaceMap, hasToolSearch } = translated;

  // ── 3b. tool attribution + virtual-key admission (mirrors handler.ts) ──
  // The Codex route must not bypass a virtual key's caps/allowlist just
  // because it speaks Responses instead of chat/messages.
  const userAgent = clientReq.headers.get("user-agent");
  const tool = userAgent ? (userAgent.trim().length <= 40 ? userAgent.trim() : `${userAgent.trim().slice(0, 39)}…`) : undefined;
  const vkey = resolveRequestKey(clientReq);
  if (vkey) {
    // Attribute at presentation (ledger honesty), then enforce the policy.
    const admission = admitRequest(vkey, req.model);
    if (!admission.ok) {
      const status = admission.status ?? 401;
      appendUsage({
        reqId: "[responses]", format: "OAI", model: req.model, stream,
        status, tokens: 0, ttfbMs: Date.now() - start,
        keyId: vkey.id, keyLabel: vkey.label, ...(tool ? { tool } : {}),
      });
      return errorResponse(
        status,
        status === 429 ? "key_cap_reached" : status === 403 ? "model_not_allowed" : "key_disabled",
        admission.reason ?? "rejected by virtual key policy",
      );
    }
  }
  const keyFields = vkey ? { keyId: vkey.id, keyLabel: vkey.label } : {};

  // ── 4. credential + provider ──
  // Fleet mode mirrors handler.ts: the strategy pick decides the serving
  // (account, plan, provider); single account keeps the AuthManager path.
  const fleet = opts.fleet;
  let entry: ChainEntry | null = null;
  let cred: Credential;
  if (fleet) {
    entry = pickServing(opts.config);
    if (!entry) {
      // 429 while entries merely cool down; 503 only when nothing is enabled.
      const hasEnabled = fleetChain(opts.config).length > 0;
      const message = hasEnabled
        ? "every account/plan in the fleet is cooling down after rejections — retry shortly"
        : "no enabled account in the fleet — run: zcode-proxy auth login <zai|bigmodel> (or enable one: zcode-proxy accounts enable <label>)";
      return errorResponse(hasEnabled ? 429 : 503, hasEnabled ? "fleet_quota_exhausted" : "credential_unavailable", message);
    }
    const picked = credentialOf(entry);
    if (!picked) {
      return errorResponse(503, "credential_unavailable", `fleet account "${entry.label}" disappeared mid-pick`);
    }
    cred = picked;
  } else {
    try {
      cred = await opts.auth.getCredential();
    } catch (err) {
      return errorResponse(503, "credential_unavailable", (err as Error).message);
    }
  }
  let providerDef = resolveProviderDef(opts.config, entry?.provider);

  // ── 5. body transform (start-plan system / anthropic cache_control + user_id) ──
  // Both plans post Anthropic upstream (mirrors handler.ts): the start-plan
  // OpenAI gateway was retired server-side (404 as of 2026-08-28), so the
  // Responses → Chat → Anthropic translator chain runs unconditionally.
  // The plan auto-switch resolves ONCE per request, like handler.ts; in fleet
  // mode the picked entry decides the plan.
  let plan: PlanTier = entry ? entry.plan : activePlan(opts.config);
  // Serving-account attribution for the usage ledger; the fleet walk updates
  // it when the request actually lands on a later chain entry.
  let servingAccount: string | undefined = entry?.label;
  let startPlan = plan === "start-plan";
  const upstreamFormat: "openai" | "anthropic" = "anthropic";
  // userId mirrors handler.ts for BOTH plans: the bundle's `E2e` is
  // provider-kind gated only (never plan-gated), so start-plan carries the
  // same device/session blob as coding-plan. The /v1/responses path has no
  // client-session resolution — session_id falls back to "" (a legal `bnt`
  // output in the bundle).
  const metadataUserId = buildAnthropicMetadataUserId(opts.config.identity.deviceMid, undefined);
  let transformedBody: string;
  let anthropicJson: string;
  {
    let anthropicReq: AnthropicMessagesRequest;
    try {
      anthropicReq = translateRequestOpenAIToAnthropic(chatRequest);
    } catch (err) {
      return errorResponse(400, "translation_failed", `Chat→Anthropic translation failed: ${(err as Error).message}`);
    }
    // anthropicJson stays untouched by the plan-specific transform so the
    // plan-fallback below can re-transform it for the coding plan.
    anthropicJson = JSON.stringify(anthropicReq);
    // Batch-as-stream (mirrors handler.ts): the gateway kills silent
    // non-streaming requests past ~180s; stream instead and reassemble.
    if (opts.config.batchAsStream !== false && !stream) {
      anthropicJson = withStreamEnabled(anthropicJson);
    }
    transformedBody = transformRequestBody(anthropicJson, {
      format: "anthropic",
      metadataUserId,
      startPlan,
      provider: entry?.provider ?? opts.config.provider,
    }) ?? anthropicJson;
  }

  // ── 6. POST upstream ──
  // start-plan gates every upstream call behind an Aliyun captcha token. The
  // Anthropic/OpenAI routes mint one in handler.ts; /v1/responses did not, so
  // start-plan users got {"code":3007,"msg":"captcha verify failed"} surfaced
  // as HTTP 400 upstream_error on every request.
  let captchaHeaders: Record<string, string> | undefined;
  if (startPlan) {
    try {
      const captcha = opts.captcha ?? (await loadCaptcha());
      const token = await captcha.getCaptchaToken(opts.config.identity.appVersion);
      captchaHeaders = { [captcha.RETRY_HEADERS.PARAM]: token.verifyParam, [captcha.RETRY_HEADERS.REGION]: token.region };
    } catch {
      // Fall through: the 3007 retry below solves on demand.
    }
  }
  let upstreamHeaders = buildUpstreamHeaderPairs(clientReq, upstreamFormat, cred, opts.config.identity, plan, captchaHeaders, undefined);
  let upstreamReq = buildUpstreamRequest(clientReq, upstreamFormat, providerDef, cred, transformedBody, opts.config.identity, plan, captchaHeaders, undefined);
  if (debug) console.log(`[responses] → POST ${upstreamReq.url}`);

  const routing = opts.endpointRouting !== undefined ? opts.endpointRouting : getDefaultEndpointRouting(opts.config);
  const signer = opts.clientSigning !== undefined ? opts.clientSigning : getDefaultClientSigning(opts.config);
  const dispatch = async (pairs: UpstreamHeaderPair[]): Promise<Response> => {
    const routed = routing ? await routing.resolve(upstreamReq.url, credentialString(cred)) : null;
    const sendUrl = routed?.routed ? routed.url : upstreamReq.url;
    if (debug && routed?.routed) console.log(`[responses] endpoint routing: ${upstreamReq.url} -> ${sendUrl}`);
    // signing decisions run against the PRE-routing provider URL (mirrors the
    // client, whose signer wraps the routing transport). A gateway 502/504 is
    // a complete LB answer, not a connect error; retry it once here so every
    // dispatch (initial, plan fallback, captcha retry) gets a second chance.
    return retryOnGatewayError(
      () =>
        sendWithClientSigning(signer, {
          url: upstreamReq.url,
          headerPairs: pairs,
          credential: credentialString(cred),
          appVersion: opts.config.identity.appVersion,
          debug: debug ? (message) => console.log(`[responses] ${message}`) : undefined,
          send: (finalPairs) => {
            const req = new Request(sendUrl, {
              method: "POST",
              headers: Object.fromEntries(finalPairs),
              body: transformedBody ?? undefined,
            });
            return fetchImpl(req, { method: "POST", headers: Object.fromEntries(finalPairs), body: transformedBody ?? undefined, signal: clientReq.signal });
          },
        }),
      {
        isAborted: () => clientReq.signal.aborted,
        onRetry: (status, resp) => {
          console.log(`[responses] upstream gateway ${status}, retrying once`);
          appendErrorLog({ kind: "upstream_gateway_retry", reqId: "[responses]", status, upstreamRequestId: upstreamRequestId(resp), ...traceFields });
        },
        onAbort: (status, resp) => {
          console.log(`[responses] upstream gateway ${status}, client already gone, not retrying`);
          appendErrorLog({ kind: "upstream_gateway_skip_client_gone", reqId: "[responses]", status, upstreamRequestId: upstreamRequestId(resp), ...traceFields });
        },
      },
    );
  };

  let upstreamResp: Response;
  const dispatchStartedAt = Date.now();
  try {
    // Connect-retry ladder mirrors the chat hot path (handler.ts): 3 attempts,
    // fresh Request per dispatch (built inside `dispatch`), 500ms×attempt
    // backoff, no retry once the client aborted.
    upstreamResp = await dispatchWithConnectRetry(() => dispatch(upstreamHeaders), {
      isAborted: () => clientReq.signal.aborted,
    });
  } catch (err) {
    // Same silent-rethrow visibility as handler.ts: a postWrite transport
    // death and a client gone before the first connect produce a bare 502
    // otherwise.
    if ((err as { postWrite?: boolean }).postWrite) {
      console.log(`[responses] upstream connection lost after the request was written, not retried`);
      appendErrorLog({ kind: "upstream_postwrite_failure", reqId: "[responses]", error: (err as Error).message, ...traceFields });
    } else if ((err as Error).message === CLIENT_ABORTED_BEFORE_CONNECT) {
      console.log(`[responses] client gone before upstream connect, not retrying`);
      appendErrorLog({ kind: "client_gone_before_connect", reqId: "[responses]", ...traceFields });
    }
    return errorResponse(502, "upstream_unreachable", unreachableMessage(err));
  }
  const headersAt = Date.now();

  // Hybrid plan auto-switch (mirrors handler.ts, only while planAutoSwitch
  // is on — with it off, plan selection is entirely the operator's config):
  // on a rejected plan retry the SAME request once on the NEXT plan in
  // config.planPriority — body, headers and URL all rebuild with the target
  // plan (the start-plan system prompt and the JWT auth are both baked into
  // the start-plan variants). Runs before the captcha retry so a dead plan
  // never spends a pooled token. Rejection covers error statuses AND, on
  // start-plan, HTTP 200 with a JSON error envelope.
  // Fleet failover (mirrors handler.ts): walk the (account × plan) chain on
  // rejection — each hop rebuilds credential, provider and plan-specific body
  // — until one serves, else a clean 429. Subsumes the plan auto-switch.
  if (fleet && entry) {
    const evalFirst = await evaluateFleetResponse(upstreamResp, plan);
    upstreamResp = evalFirst.resp;
    if (evalFirst.rejected) {
      const outcome = await walkFleetChain({
        config: opts.config,
        from: entry,
        firstStatus: upstreamResp.status,
        onFallback: (message) => {
          console.log(`[responses] ${message}`);
          appendErrorLog({ kind: "fleet_fallback", reqId: "[responses]", message, ...traceFields });
        },
        dispatchEntry: (target) => {
          const targetCred = credentialOf(target);
          if (!targetCred) throw new Error(`fleet: account "${target.label}" disappeared mid-failover`);
          cred = targetCred;
          providerDef = resolveProviderDef(opts.config, target.provider);
          plan = target.plan;
          startPlan = plan === "start-plan";
          transformedBody = transformRequestBody(anthropicJson, {
            format: "anthropic",
            metadataUserId,
            startPlan,
            provider: target.provider,
          }) ?? anthropicJson;
          upstreamHeaders = buildUpstreamHeaderPairs(clientReq, upstreamFormat, cred, opts.config.identity, plan, undefined, undefined);
          upstreamReq = buildUpstreamRequest(clientReq, upstreamFormat, providerDef, cred, transformedBody, opts.config.identity, plan, undefined, undefined);
          return dispatch(upstreamHeaders);
        },
      });
      if (outcome.exhausted) {
        const tried = outcome.exhausted.tried.join(", ");
        appendErrorLog({ kind: "fleet_exhausted", reqId: "[responses]", message: `fleet exhausted: ${tried}`, ...traceFields });
        appendUsage({
          reqId: "[responses]", format: "OAI", model: req.model, plan,
          ...(servingAccount ? { account: servingAccount } : {}), ...(tool ? { tool } : {}), ...keyFields,
          stream, status: 429, tokens: 0, ttfbMs: headersAt - start, totalMs: Date.now() - start,
        });
        return errorResponse(429, "fleet_quota_exhausted", `the upstream rejected the request on every account/plan in the fleet (${tried})`);
      }
      if (outcome.served) {
        entry = outcome.served.entry;
        plan = entry.plan;
        startPlan = plan === "start-plan";
        servingAccount = entry.label;
        upstreamResp = outcome.served.resp;
      }
    }
  } else if (opts.config.planAutoSwitch === true) {
    let planRejected = shouldFallbackPlan(upstreamResp.status, plan);
    if (!planRejected && plan === "start-plan" && upstreamResp.status === 200) {
      const sniff = await sniffStartPlanRejection(upstreamResp);
      planRejected = sniff.rejected;
      upstreamResp = sniff.response;
    }
    {
      const outcome = await retryOnPlanExhausted({
        rejected: planRejected,
        plan,
        priority: planPriorityOf(opts.config),
        onFallback: (message) => {
          console.log(`[responses] ${message}`);
          appendErrorLog({ kind: "plan_fallback", reqId: "[responses]", message, ...traceFields });
        },
        rebuildAndDispatch: (target) => {
          transformedBody = transformRequestBody(anthropicJson, {
            format: "anthropic",
            metadataUserId,
            startPlan: target === "start-plan",
            provider: opts.config.provider,
          }) ?? anthropicJson;
          upstreamHeaders = buildUpstreamHeaderPairs(clientReq, upstreamFormat, cred, opts.config.identity, target, undefined, undefined);
          upstreamReq = buildUpstreamRequest(clientReq, upstreamFormat, providerDef, cred, transformedBody, opts.config.identity, target, undefined, undefined);
          return dispatch(upstreamHeaders);
        },
      });
      if (outcome.handled && outcome.resp) {
        plan = outcome.target ?? plan;
        startPlan = plan === "start-plan";
        upstreamResp = outcome.resp;
        // Mirror of handler.ts: the fallback's own answer gets the same sniff
        // when it landed on the start-plan gateway; with both plans exhausted
        // it comes back as a 200 quota envelope, and the client gets a clean
        // 429 instead of a fake 200.
        if (startPlan && upstreamResp.status === 200) {
          const sniff = await sniffStartPlanRejection(upstreamResp);
          if (sniff.rejected) {
            appendErrorLog({ kind: "plan_quota_exhausted", reqId: "[responses]", message: "fallback also rejected — both plans exhausted", ...traceFields });
            return errorResponse(429, "plan_quota_exhausted", "the upstream rejected the request on both plans (the fallback also got a quota envelope)");
          }
          upstreamResp = sniff.response;
        }
      }
    }
  }

  // Captcha challenge retry (mirrors handler.ts via the shared captcha-retry
  // seam): the gateway signals it either through the captcha response header
  // or as HTTP 400 with {"code":3007} in the body. The challenged token is
  // already spent, so retry once with a fresh pooled one.
  if (startPlan && !upstreamResp.ok) {
    const captcha = opts.captcha ?? (await loadCaptcha());
    if (await isCaptchaChallenged(upstreamResp, captcha)) {
      if (debug) console.log("[responses] captcha challenge — re-solving and retrying once");
      const outcome = await retryOnCaptchaChallenge({
        captcha,
        appVersion: opts.config.identity.appVersion,
        challengedResp: upstreamResp,
        debug: debug ? (message) => console.log(`[responses] ${message}`) : undefined,
        solveAndRetry: (retryHeaders) => dispatch(
          buildUpstreamHeaderPairs(clientReq, upstreamFormat, cred, opts.config.identity, plan, retryHeaders, undefined),
        ),
        mapError: (err, phase) =>
          phase === "solver"
            ? errorResponse(503, "captcha_solver_failed", err.message)
            : errorResponse(502, "upstream_unreachable", unreachableMessage(err)),
      });
      if (!outcome.ok) return outcome.resp;
      upstreamResp = outcome.resp;
    }
  }

  if (!upstreamResp.ok) {
    const errText = await upstreamResp.text().catch(() => "");
    return errorResponse(upstreamResp.status, "upstream_error", errText.slice(0, 500) || `upstream returned ${upstreamResp.status}`);
  }

  if (upstreamFormat === "anthropic") {
    // normalize the Anthropic upstream response into the OpenAI Chat shape the
    // downstream Responses translators already consume (SSE + batch)
    if (stream) {
      if (!upstreamResp.body) {
        return errorResponse(502, "translation_failed", "upstream returned no body for stream");
      }
      upstreamResp = new Response(anthropicSseToOpenaiSse(upstreamResp.body, req.model), {
        status: upstreamResp.status,
        headers: { "content-type": "text/event-stream" },
      });
    } else {
      let parsedAnthropic: AnthropicMessagesResponse;
      if (isEventStream(upstreamResp) && upstreamResp.body) {
        try {
          parsedAnthropic = await collectAnthropicMessage(upstreamResp.body, upstreamCodings(upstreamResp));
        } catch (err) {
          appendErrorLog({ kind: "stream_collect_failed", reqId: "[responses]", error: (err as Error).message, upstreamRequestId: upstreamRequestId(upstreamResp), ...traceFields });
          return errorResponse(502, "upstream_stream_failed", (err as Error).message);
        }
      } else {
        const rawAnthropic = await upstreamResp.text();
        try {
          parsedAnthropic = JSON.parse(rawAnthropic) as AnthropicMessagesResponse;
        } catch (err) {
          return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`);
        }
      }
      const openaiResp = translateResponseAnthropicToOpenAI(parsedAnthropic, req.model);
      upstreamResp = new Response(JSON.stringify(openaiResp), {
        status: upstreamResp.status,
        headers: { "content-type": "application/json" },
      });
    }
  }

  // ── 8. translate Chat → Responses ──
  const responseId = generateResponsesId();
  const meta = { customToolNames, namespaceMap, hasToolSearch };

  if (stream) {
    return streamResponse(upstreamResp, { responseId, model: req.model, meta, request: req, input, options: opts, ledger: {
      startedAt: start, headersAt, plan,
      ...(servingAccount ? { account: servingAccount } : {}), ...(tool ? { tool } : {}), ...keyFields,
    } });
  }

  const rawChatResp = await upstreamResp.text();
  let chatRespJson;
  try {
    chatRespJson = JSON.parse(rawChatResp);
  } catch (err) {
    return errorResponse(502, "translation_failed", `upstream returned non-JSON body: ${(err as Error).message}`);
  }
  const responsesResp = chatCompletionsToResponses(chatRespJson, req.model, {
    responseId,
    meta,
    ...(typeof req.instructions === "string" ? { instructions: req.instructions } : {}),
    ...(prevId ? { previousResponseId: prevId } : {}),
  });

  // ── 9. store the response (unless `store:false`) ──
  if (req.store !== false && opts.responseStore) {
    const stored = buildStoredResponse(responsesResp, input, req.instructions);
    opts.responseStore.set(stored);
  }

  if (debug) console.log(`[responses] ← ${responsesResp.status} (${Date.now() - start}ms)`);

  // Usage ledger (batch completion): tokens from the Responses usage block.
  appendUsage({
    reqId: "[responses]", format: "OAI", model: req.model, plan,
    ...(servingAccount ? { account: servingAccount } : {}), ...(tool ? { tool } : {}), ...keyFields,
    stream: false, status: 200, tokens: responsesResp.usage?.output_tokens ?? 0,
    ttfbMs: headersAt - start, totalMs: Date.now() - start,
  });

  return new Response(JSON.stringify(responsesResp), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ─────────────────────────────────────────────
// Streaming response
// ─────────────────────────────────────────────

interface StreamResponseContext {
  responseId: string;
  model: string;
  meta: { customToolNames: Set<string>; namespaceMap: Map<string, { namespace: string; name: string }>; hasToolSearch: boolean };
  request: ResponsesRequest;
  input: ResponsesInputItem[];
  options: ResponsesHandlerOptions;
  /** Usage-ledger attribution carried from handleResponses (stream completes async). */
  ledger: {
    startedAt: number;
    headersAt: number;
    plan?: PlanTier;
    account?: string;
    tool?: string;
    keyId?: string;
    keyLabel?: string;
  };
}

function streamResponse(upstreamResp: Response, context: StreamResponseContext): Response {
  if (!upstreamResp.body) {
    return errorResponse(502, "translation_failed", "upstream returned no body for stream");
  }
  const state = newResponsesStreamState(context.model, { meta: context.meta, responseId: context.responseId });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (evt: ResponsesStreamEvent) => controller.enqueue(encoder.encode(responsesEventToSse(evt)));
      try {
        const reader = upstreamResp.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let errored = false;
        for (;;) {
          if (errored) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE chunks are separated by `\n\n`; process complete frames.
          let nl: number;
          while ((nl = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            const dataLine = extractSseData(frame);
            if (!dataLine || dataLine === "[DONE]") continue;
            try {
              const chunk = JSON.parse(dataLine);
              for (const evt of chatChunkToResponsesEvents(chunk, state)) send(evt);
            } catch (err) {
              errored = true;
              // Release the upstream reader too — without the cancel the
              // upstream connection lingers until GC. Fire-and-forget so a
              // slow cancel never delays the client-visible error. The
              // errored-flag + early-return semantics (anti-pattern #24) are
              // unchanged: no further reads, no finalize, no close().
              reader.cancel().catch(() => {});
              controller.error(err);
              return;
            }
          }
        }
        const finalEvents = finalizeResponsesStream(state);
        for (const evt of finalEvents) send(evt);
        const finalEvent = finalEvents.find((evt) => evt.type === "response.completed" || evt.type === "response.incomplete");
        if (finalEvent && context.request.store !== false && context.options.responseStore) {
          context.options.responseStore.set(buildStoredResponse(finalEvent.response, context.input, context.request.instructions));
        }
        // Usage ledger (stream completion): tokens from the final Responses
        // usage block; the client saw HTTP 200 regardless of the event kind.
        appendUsage({
          reqId: "[responses]", format: "OAI", model: context.model,
          ...(context.ledger.plan ? { plan: context.ledger.plan } : {}),
          ...(context.ledger.account ? { account: context.ledger.account } : {}),
          ...(context.ledger.tool ? { tool: context.ledger.tool } : {}),
          ...(context.ledger.keyId ? { keyId: context.ledger.keyId } : {}),
          ...(context.ledger.keyLabel ? { keyLabel: context.ledger.keyLabel } : {}),
          stream: true, status: 200,
          tokens: finalEvent?.response.usage?.output_tokens ?? 0,
          ttfbMs: context.ledger.headersAt - context.ledger.startedAt,
          totalMs: Date.now() - context.ledger.startedAt,
        });
        try { controller.close(); } catch {}
      } catch (err) {
        try {
          for (const evt of failResponsesStream(state, {
            code: err instanceof AnthropicStreamError ? err.code : "upstream_error",
            message: err instanceof Error ? err.message : String(err),
          })) send(evt);
          controller.close();
        } catch { try { controller.error(err); } catch {} }
      }
    },
    cancel(reason) {
      context.options.debug === true && console.log(`[responses] stream cancelled: ${String(reason)}`);
      try { upstreamResp.body?.cancel(); } catch {}
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function extractSseData(frame: string): string | null {
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("data:")) return line.slice(5).replace(/^\s/, "");
  }
  return null;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function resolveProviderDef(config: ProxyConfig, providerId: ProxyConfig["provider"] = config.provider): ProviderDef & { openaiBaseURL: string; anthropicBaseURL: string } {
  const base = getProvider(providerId);
  const endpoints = config.providers[providerId];
  return {
    ...base,
    anthropicBaseURL: endpoints.anthropicBase,
    openaiBaseURL: endpoints.openaiBase,
  };
}

/**
 * Cast stored output items back into input items so the next turn's history is
 * a flat list the translator can walk. Responses output and input item shapes
 * overlap enough that a structural cast is sound (the fields we read — `type`,
 * `call_id`, `name`, `arguments`, `content`, `role` — are shared).
 */
function outputItemsAsInputItems(outputs: ResponsesOutputItem[]): ResponsesInputItem[] {
  return outputs as unknown as ResponsesInputItem[];
}

function buildStoredResponse(
  resp: ResponsesResponse,
  input: ResponsesInputItem[],
  instructions: string | undefined,
): StoredResponse {
  return {
    id: resp.id,
    model: resp.model,
    status: (resp.status === "completed" || resp.status === "incomplete" || resp.status === "failed" ? resp.status : "completed"),
    input,
    output: resp.output,
    usage: resp.usage,
    instructions,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  };
}
