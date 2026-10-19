import express from "express";

const app = express();

// Reads the query string of a request URL with the standard URLSearchParams
// (instead of Node's legacy URL parser, which is deprecated). It deliberately
// parses only the part after "?" rather than building a full URL, so a
// request path that starts with "//" can never be mistaken for a hostname.
function queryOf(url) {
  const i = url.indexOf("?");
  return new URLSearchParams(i === -1 ? "" : url.slice(i + 1));
}

// The vercel.json rewrite forwards every request to this single function
// as "/api?path=<real-path>", passing the actual requested path through
// as a query parameter rather than relying on Vercel to preserve it in
// req.url directly (that assumption produced a reliable "Cannot POST
// /api" error in practice — see vercel.json's comment for why).
// Reconstruct the real req.url from that query param here, before
// anything else runs, so every route below can stay defined exactly as
// Janitor AI would request it (e.g. "/v1/chat/completions"). Any other
// original query params (e.g. our own "?all=1" on /v1/models) are
// preserved alongside the reconstructed path.
app.use((req, res, next) => {
  const params = queryOf(req.url);
  const path = params.get("path");
  if (path !== null) {
    params.delete("path");
    const search = params.toString();
    req.url = "/" + path + (search ? `?${search}` : "");
  }
  // If "path" isn't present (e.g. local dev via `node api/index.js`,
  // where no Vercel rewrite is involved), leave req.url untouched.
  next();
});

app.use(express.json({ limit: "25mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*, Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const NIM_BASE = "https://integrate.api.nvidia.com/v1";

// Get this free at https://build.nvidia.com (click any model -> Get API
// Key). Rate-limited but no daily cap as of writing. Janitor AI never
// needs this — it stays server-side.
const NIM_KEY = process.env.NVIDIA_API_KEY;

if (!NIM_KEY) {
  console.warn(
    "[warn] NVIDIA_API_KEY is not set. Get a free key at https://build.nvidia.com " +
      "and set it as an environment variable."
  );
}

// NVIDIA NIM has no single standard way to toggle reasoning — each model
// family uses a different mechanism. This maps friendly model names
// (what you'll put in Janitor AI) to the real NIM model id and how to
// switch its thinking mode on/off.
//
// NVIDIA retires NIM models without much notice (a retired id answers
// HTTP 410 Gone), and a model can be listed in /v1/models while still
// failing. Use GET /status on this proxy to see which of these actually
// answer right now. If a curated model returns 404/410, the proxy
// automatically tries the next one in FALLBACK_MODELS (see below).
const MODEL_CONFIGS = {
  // REMOVED: nemotron-49b*, nemotron-nano-9b*. NVIDIA retired
  // nvidia/llama-3.3-nemotron-super-49b-v1 (and v1.5) and
  // nvidia/nvidia-nemotron-nano-9b-v2 around 2026-08-26 — they now answer
  // HTTP 410 Gone on every request. These used to be this proxy's default
  // and its recommended "safe" models.

  // Community-sourced (chat_template_kwargs) — this checkpoint is
  // reasoning-only, so there's no "thinking off" variant.
  "nemotron-omni-30b-thinking": {
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: { chat_template_kwargs: { enable_thinking: true }, reasoning_budget: 16384 },
  },

  // DeepSeek-V4.1-Flash — replaces ALL prior DeepSeek entries
  // (deepseek-v4-flash, deepseek-v4-flash-0731, deepseek-v4-pro-0813) as
  // of this update. Confirmed real and free on NIM directly against
  // NVIDIA's own API reference (docs.api.nvidia.com/nim/reference/
  // nvidia-deepseek-v4_1-flash). 552B MoE, 8B/16B active, multimodal
  // (text + image in, text out), native 1M-token context.
  //
  // Reasoning is a CONTINUOUS 1-100 dial on this model, not discrete
  // tiers — a real architectural change from every other DeepSeek model
  // in this file. reasoning_effort accepts either a number (1-100) or
  // "none" to disable entirely. Also: the "thinking" field on this
  // specific model is a plain BOOLEAN (confirmed from vLLM's own official
  // serving recipe for this model), unlike GLM-5.3's nested
  // {type:"enabled"} object — don't copy that shape here, it's wrong for
  // this model and was deliberately NOT reused.
  //
  // Real operational gotcha, confirmed in vLLM's own docs for this exact
  // model: if NEITHER thinking nor reasoning_effort is set, it defaults
  // to thinking ON at effort 50 — and a small max_tokens can then get
  // entirely consumed by the reasoning trace, returning EMPTY actual
  // content with finish_reason=length (looks like a broken model, isn't
  // one). Every entry below explicitly sets both fields for exactly this
  // reason — never leave both unset.
  "deepseek-v4.1-flash-thinking": {
    id: "deepseek-ai/deepseek-v4.1-flash",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: {
      reasoning_effort: 50,
      chat_template_kwargs: { thinking: true, enable_thinking: true, reasoning_effort: 50 },
    },
  },
  // Max reasoning effort. This model is much smaller than DeepSeek-V4-
  // Pro-0813 (552B vs 1.6T total params), so the Vercel-timeout risk
  // that forced -0813 to default away from "max" is less likely here —
  // but it's a new model on this proxy, untested at this setting in
  // practice. Worth testing with the curl command below before relying
  // on it in a live Janitor AI conversation.
  "deepseek-v4.1-flash-max": {
    id: "deepseek-ai/deepseek-v4.1-flash",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: {
      reasoning_effort: 100,
      chat_template_kwargs: { thinking: true, enable_thinking: true, reasoning_effort: 100 },
    },
  },
  "deepseek-v4.1-flash-fast": {
    id: "deepseek-ai/deepseek-v4.1-flash",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: {
      reasoning_effort: 25,
      chat_template_kwargs: { thinking: true, enable_thinking: true, reasoning_effort: 25 },
    },
  },
  "deepseek-v4.1-flash": {
    id: "deepseek-ai/deepseek-v4.1-flash",
    mode: "kwargs",
    kwargsOn: {
      reasoning_effort: 50,
      chat_template_kwargs: { thinking: true, enable_thinking: true, reasoning_effort: 50 },
    },
    kwargsOff: {
      reasoning_effort: "none",
      chat_template_kwargs: { thinking: false, enable_thinking: false },
    },
  },

  // Kimi K3 (Moonshot AI) — confirmed real and free on NIM directly
  // against NVIDIA's own API reference (docs.api.nvidia.com/nim/reference/
  // moonshotai-kimi-k3) and Kimi's own docs. 2.8T total / 104B active
  // params, native 1M-token context. Unlike the DeepSeek/GLM models
  // above, thinking CANNOT be turned off — it's a thinking-only model —
  // but reasoning depth is tunable via a top-level reasoning_effort field
  // ("low"/"high"/"max", officially defaults to "max").
  //
  // Default here is "high", not "max" — Kimi's own docs note "max" on a
  // model this size can take roughly a minute per response even on
  // dedicated GPU clusters, which risks the exact Vercel-timeout failure
  // mode DeepSeek-V4-Pro-0813 hit earlier. "low" is also offered for
  // quick/simple messages where deep reasoning isn't needed.
  //
  // Known limitation, not fixable at the proxy level: Kimi K3 expects its
  // own prior reasoning_content echoed back on every turn for best
  // multi-turn quality. Janitor AI's client only stores/sends back plain
  // `content`, with no concept of `reasoning_content` — so multi-turn
  // conversations through Janitor AI will not get this optimization, and
  // reasoning quality may drift over a long roleplay session. This is a
  // limitation of Janitor AI's client shape, not something this proxy
  // can transparently work around.
  "kimi-k3-thinking": {
    id: "moonshotai/kimi-k3",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: { reasoning_effort: "high" },
  },
  "kimi-k3-max": {
    id: "moonshotai/kimi-k3",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: { reasoning_effort: "max" },
  },
  "kimi-k3-fast": {
    id: "moonshotai/kimi-k3",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: { reasoning_effort: "low" },
  },

  // GLM-5.3 (Z.ai) — confirmed real and free on NIM directly against
  // NVIDIA's own API reference (docs.api.nvidia.com/nim/reference/
  // z-ai-glm-5-3) and Z.ai's own docs. 753B-parameter MoE, 1M-token
  // context. Like Kimi K3, thinking CANNOT be disabled — Z.ai's own
  // migration notes call this a breaking change from GLM-5.2, which did
  // allow disabling it. Three reasoning_effort levels: low, high, max
  // (default max per Z.ai's docs).
  //
  // After GLM-5.2's "thinking on by default" claim turning out false on
  // NIM's actual endpoint, this sends MULTIPLE redundant parameter
  // conventions at once rather than trusting any single documented shape:
  // Z.ai's own native format (top-level `thinking: {type: "enabled"}` +
  // top-level `reasoning_effort`) AND the chat_template_kwargs shape NIM
  // uses for DeepSeek, in case NIM's hosted deployment expects that
  // instead.
  //
  // Default is "high", not "max" — this is another ~750B-class model,
  // and "max" reasoning effort on DeepSeek-V4-Pro-0813 (a similar size)
  // already reliably blew past Vercel's 60s timeout once. Not repeating
  // that by default here; "max" is still available as an explicit
  // opt-in below.
  "glm-5.3-thinking": {
    id: "z-ai/glm-5.3",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: {
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      chat_template_kwargs: { thinking: true, enable_thinking: true, reasoning_effort: "high" },
    },
  },
  "glm-5.3-max": {
    id: "z-ai/glm-5.3",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: {
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      chat_template_kwargs: { thinking: true, enable_thinking: true, reasoning_effort: "max" },
    },
  },
  "glm-5.3-fast": {
    id: "z-ai/glm-5.3",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: {
      thinking: { type: "enabled" },
      reasoning_effort: "low",
      chat_template_kwargs: { thinking: true, enable_thinking: true, reasoning_effort: "low" },
    },
  },

  // GLM-5.3-Flash (Z.ai) — confirmed in NIM's live catalog for this key
  // (z-ai/glm-5.3-flash) and documented on NVIDIA's own API reference.
  // 320B total / 18B active, natively multimodal, 1M context. Thinking is
  // always on and cannot be disabled. NVIDIA's card and the vLLM recipe for
  // this exact model say reasoning depth is controlled by reasoning_effort
  // (low / high / max, default max), passed either top-level or inside
  // chat_template_kwargs — so both are sent. NVIDIA's card also says chat
  // use should pass clear_thinking=true (Janitor AI never echoes prior
  // reasoning back, so there is nothing to preserve).
  //
  // Deliberately NOT sending GLM-5.3's nested `thinking: {type: "enabled"}`
  // object here: the documented shape for this model is the reasoning_effort
  // field, and extra unrecognized fields are just more things that can go
  // wrong. Default is "high", not "max", for the same latency reason as the
  // other large reasoning models on this proxy.
  "glm-5.3-flash-thinking": {
    id: "z-ai/glm-5.3-flash",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: {
      reasoning_effort: "high",
      chat_template_kwargs: { reasoning_effort: "high", clear_thinking: true },
    },
  },
  // Bare alias so typing just "glm-5.3-flash" doesn't silently fall back to
  // the default model.
  "glm-5.3-flash": {
    id: "z-ai/glm-5.3-flash",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: {
      reasoning_effort: "high",
      chat_template_kwargs: { reasoning_effort: "high", clear_thinking: true },
    },
  },
  "glm-5.3-flash-max": {
    id: "z-ai/glm-5.3-flash",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: {
      reasoning_effort: "max",
      chat_template_kwargs: { reasoning_effort: "max", clear_thinking: true },
    },
  },
  "glm-5.3-flash-fast": {
    id: "z-ai/glm-5.3-flash",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: {
      reasoning_effort: "low",
      chat_template_kwargs: { reasoning_effort: "low", clear_thinking: true },
    },
  },
};

// Used when the requested name isn't recognized (e.g. an old alias saved in
// Janitor AI). Must be a model that is actually being served.
const DEFAULT_MODEL = "deepseek-v4.1-flash-thinking";

// If a curated model answers 404 or 410 (retired / not served for this
// account), the proxy retries with these, in order, instead of failing the
// chat. Raw "vendor/model" ids typed by hand are NOT substituted — if you
// ask for a specific id you get that id or its real error. Override with a
// comma-separated list of alias names in the NIM_FALLBACK_MODELS env var.
const MODEL_UNAVAILABLE_STATUSES = new Set([404, 410]);
const FALLBACK_MODELS = (
  process.env.NIM_FALLBACK_MODELS
    ? process.env.NIM_FALLBACK_MODELS.split(",").map((k) => k.trim())
    : ["deepseek-v4.1-flash-thinking", "glm-5.3-flash-thinking", "nemotron-omni-30b-thinking", "kimi-k3-thinking"]
).filter((key) => MODEL_CONFIGS[key]);

// Any model NOT in MODEL_CONFIGS is treated as a raw NIM model id and
// passed straight through with no thinking-mode manipulation (harmless —
// mergeReasoning still applies if the model happens to return
// reasoning_content anyway). This is what makes "all of the other free
// models" work without hardcoding NIM's full 100+ model catalog: any
// valid id from https://build.nvidia.com or GET /v1/models on this proxy
// just works, e.g. "qwen/qwen3-235b-a22b", "meta/llama-3.1-70b-instruct",
// "mistralai/mistral-large-2-instruct".
function resolveModel(requested) {
  const key = (requested || DEFAULT_MODEL).trim();
  if (MODEL_CONFIGS[key]) return { key, ...MODEL_CONFIGS[key] };
  if (key.includes("/")) return { key, id: key, mode: "passthrough" };
  return { key, ...MODEL_CONFIGS[DEFAULT_MODEL] };
}

// Builds the actual outbound NIM request body: sets the real model id and
// applies whichever thinking-toggle mechanism that model uses.
function buildNimBody(config, body) {
  // Our own on/off control flag is read from the caller's body as
  // "thinking", but that field name collides with some models' own real
  // API parameter of the same name (GLM-5.3 requires a top-level
  // `thinking: {type: "enabled"}` object). Strip our internal flag from
  // the incoming body BEFORE constructing the outbound request, so a
  // model's own legitimate "thinking" field (set via kwargsOn below)
  // never gets clobbered by cleanup logic afterward.
  const { thinking: internalThinkingFlag, ...bodyWithoutOurFlag } = body;
  const out = { ...bodyWithoutOurFlag, model: config.id };
  const wantThinking = config.forceThinking || internalThinkingFlag !== false;

  if (config.mode === "system_prompt") {
    const text = wantThinking ? config.on : config.off;
    const messages = [...(out.messages || [])];
    if (messages[0]?.role === "system") {
      messages[0] = { ...messages[0], content: text };
    } else {
      messages.unshift({ role: "system", content: text });
    }
    out.messages = messages;
  } else if (config.mode === "system_suffix") {
    const suffix = wantThinking ? config.on : config.off;
    const messages = [...(out.messages || [])];
    if (messages[0]?.role === "system") {
      messages[0] = { ...messages[0], content: `${messages[0].content}${suffix}` };
    } else {
      messages.unshift({ role: "system", content: suffix.trim() });
    }
    out.messages = messages;
  } else if (config.mode === "kwargs") {
    Object.assign(out, wantThinking ? config.kwargsOn : config.kwargsOff || {});
  }

  return out;
}

// Merges NIM's separate reasoning field into the visible message so
// Janitor AI (which just renders `content`) actually shows the thinking
// trace, wrapped in <think> tags — the same convention DeepSeek-R1-style
// UIs use, so it reads naturally as "the model thinking out loud."
// Different model families on NIM don't all use the same field name for
// this, so we check the common variants rather than just one.
function extractReasoning(obj) {
  return obj?.reasoning_content || obj?.reasoning || obj?.thinking || null;
}

function mergeReasoningNonStreaming(data) {
  const msg = data?.choices?.[0]?.message;
  const reasoning = extractReasoning(msg);
  if (reasoning) {
    msg.content = `<think>\n${reasoning}\n</think>\n\n${msg.content || ""}`;
    delete msg.reasoning_content;
    delete msg.reasoning;
    delete msg.thinking;
  }
  return data;
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Janitor AI <-> NVIDIA NIM proxy is running",
    default_model: DEFAULT_MODEL,
    check_what_works_now: "/status",
    models: Object.keys(MODEL_CONFIGS),
  });
});

app.get("/v1/models", async (req, res) => {
  const curated = Object.keys(MODEL_CONFIGS).map((id) => ({
    id,
    object: "model",
    owned_by: "nvidia-nim-proxy-curated",
  }));

  if (!NIM_KEY) {
    // Can't reach NIM's live catalog without a key, but the curated
    // aliases still work once one is set.
    return res.json({ object: "list", data: curated });
  }

  try {
    const upstream = await fetch(`${NIM_BASE}/models`, {
      headers: { Authorization: `Bearer ${NIM_KEY}` },
    });
    const data = await upstream.json();
    const live = Array.isArray(data?.data) ? data.data : [];
    // Curated aliases first (these get the thinking-mode normalization),
    // then every other model NIM's catalog actually offers, passthrough-able.
    const liveIds = new Set(curated.map((m) => m.id));
    const merged = [...curated, ...live.filter((m) => !liveIds.has(m.id))];
    res.json({ object: "list", data: merged });
  } catch (err) {
    // NIM's catalog endpoint failed — still return the curated list rather
    // than erroring outright.
    res.json({ object: "list", data: curated, warning: `Could not reach NIM's live catalog: ${err.message}` });
  }
});

// ---- GET /status ---------------------------------------------------------
// "Is it in the catalog?" is not the same as "does it answer?" — NVIDIA
// retires models (HTTP 410 Gone) and some listed models fail for specific
// accounts (404). This sends one tiny real request per distinct upstream
// model and reports what actually came back. Cached for 5 minutes (each
// check spends a little of your NVIDIA quota); add ?fresh=1 to re-check.
const STATUS_TTL_MS = 5 * 60 * 1000;
let statusCache = { at: 0, data: null };

function summarizeUpstreamError(text) {
  if (!text) return "empty response body";
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.detail || parsed?.error?.message || parsed?.message || parsed?.title;
    if (message) return String(message).slice(0, 200);
  } catch {
    // not JSON — fall through
  }
  return text.slice(0, 200);
}

app.get("/status", async (req, res) => {
  if (!NIM_KEY) {
    return res.status(500).json({ error: { message: "Proxy misconfigured: NVIDIA_API_KEY env var is not set." } });
  }
  const fresh = queryOf(req.url).get("fresh") === "1";
  if (!fresh && statusCache.data && Date.now() - statusCache.at < STATUS_TTL_MS) {
    return res.json({ ...statusCache.data, cached: true });
  }

  // One probe per distinct upstream model id, not per alias.
  const probes = new Map();
  for (const [alias, cfg] of Object.entries(MODEL_CONFIGS)) {
    if (!probes.has(cfg.id)) probes.set(cfg.id, { cfg, aliases: [] });
    probes.get(cfg.id).aliases.push(alias);
  }

  const results = await Promise.all(
    [...probes.entries()].map(async ([id, { cfg, aliases }]) => {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const body = buildNimBody(cfg, { messages: [{ role: "user", content: "hi" }], max_tokens: 8 });
        const r = await fetch(`${NIM_BASE}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${NIM_KEY}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await r.text().catch(() => "");
        return {
          model: id,
          aliases,
          status: r.status,
          ok: r.ok,
          detail: r.ok ? "answers" : summarizeUpstreamError(text),
          ms: Date.now() - started,
        };
      } catch (err) {
        return {
          model: id,
          aliases,
          status: 0,
          ok: false,
          detail: err.name === "AbortError" ? "no answer within 20s" : err.message,
          ms: Date.now() - started,
        };
      } finally {
        clearTimeout(timer);
      }
    })
  );

  const data = {
    checked_at: new Date().toISOString(),
    working_aliases: results.filter((r) => r.ok).flatMap((r) => r.aliases),
    not_working: results.filter((r) => !r.ok).map((r) => ({ model: r.model, status: r.status, detail: r.detail })),
    results,
  };
  statusCache = { at: Date.now(), data };
  res.json({ ...data, cached: false });
});

// NVIDIA NIM's free tier is rate-limited per-minute (not just a daily
// cap), so a burst of messages in an active chat can trip a 429 that
// clears within seconds. Rather than failing the message outright, retry
// a couple of times with backoff — honoring NIM's Retry-After header if
// it sends one, otherwise a short fixed delay.
async function fetchWithRetry(url, options, maxRetries = 2) {
  let lastResponse;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, options);
    if (response.status !== 429) return response;

    lastResponse = response;
    if (attempt === maxRetries) break; // out of retries, return the 429 as-is

    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
    const requestedDelayMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 1000 * (attempt + 1);
    // Cap the wait: sleeping through a long Retry-After would run into
    // Vercel's function timeout, and the caller would see a dropped
    // connection instead of a clean 429.
    const delayMs = Math.min(requestedDelayMs, 8000);

    console.warn(`[nim rate-limited] attempt ${attempt + 1}/${maxRetries + 1}, retrying in ${delayMs}ms`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return lastResponse;
}

// Builds a JSON error body from an upstream (NIM) error response, whether
// or not NIM actually sent JSON — it doesn't always (an empty body was
// observed on a real 404).
function buildErrorPayload(status, rawText) {
  if (rawText) {
    try {
      const parsed = JSON.parse(rawText);
      if (parsed) return parsed;
    } catch {
      // not JSON — fall through to the wrapped message below
    }
  }
  return {
    error: {
      message:
        `NIM returned ${status} with a non-JSON body` +
        (rawText ? `: ${rawText.slice(0, 300)}` : " (empty)"),
    },
  };
}

app.post("/v1/chat/completions", async (req, res) => {
  if (!NIM_KEY) {
    return res.status(500).json({ error: { message: "Proxy misconfigured: NVIDIA_API_KEY env var is not set." } });
  }

  const reqBody = req.body || {};
  const config = resolveModel(reqBody.model);
  const streaming = !!reqBody.stream;

  // Candidate models, in order. A hand-typed raw "vendor/model" id gets just
  // itself; a curated alias (or an unrecognized name that fell back to the
  // default) is followed by the fallback chain, deduplicated by upstream id.
  const candidates = [config];
  if (config.mode !== "passthrough") {
    const seenIds = new Set([config.id]);
    for (const key of FALLBACK_MODELS) {
      const candidate = { key, ...MODEL_CONFIGS[key] };
      if (!seenIds.has(candidate.id)) {
        seenIds.add(candidate.id);
        candidates.push(candidate);
      }
    }
    candidates.length = Math.min(candidates.length, 4);
  }

  // --- Connection handling -------------------------------------------
  // Callers like Lorebary (and Janitor's own backend) sit between the user
  // and this proxy, and they drop connections that stay silent too long,
  // reported to the user as "upstream_transport_error". Large reasoning
  // models can take a while before NIM answers at all, so:
  //  - if NIM hasn't responded within 5s on a streaming request, open the
  //    SSE stream early and send ": keep-alive" comment lines (valid SSE,
  //    ignored by clients; OpenRouter does the same) every 10s until it does;
  //  - if the caller hangs up first, cancel the NIM request instead of
  //    leaving it running.
  const abort = new AbortController();
  let clientGone = false;
  let heartbeat = null;
  let sseStarted = false;

  const stopHeartbeat = () => {
    if (heartbeat) {
      clearTimeout(heartbeat);
      heartbeat = null;
    }
  };

  res.on("close", () => {
    stopHeartbeat();
    if (!res.writableFinished) {
      clientGone = true;
      abort.abort();
    }
  });

  const startSse = () => {
    if (sseStarted) return;
    sseStarted = true;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
  };

  if (streaming) {
    const beat = () => {
      startSse();
      res.write(": keep-alive\n\n");
      heartbeat = setTimeout(beat, 10000);
    };
    heartbeat = setTimeout(beat, 5000);
  }

  try {
    // Try each candidate until one is not "model unavailable" (404/410).
    // Other failures (429, 5xx, auth) are returned as-is: they say nothing
    // about whether the model itself exists.
    let upstream = null;
    let used = null;
    let firstUnavailable = null;
    for (const candidate of candidates) {
      const response = await fetchWithRetry(`${NIM_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${NIM_KEY}` },
        body: JSON.stringify(buildNimBody(candidate, reqBody)),
        signal: abort.signal,
      });
      if (response.ok || !MODEL_UNAVAILABLE_STATUSES.has(response.status)) {
        upstream = response;
        used = candidate;
        break;
      }
      console.warn(`[model unavailable] ${candidate.id} -> HTTP ${response.status}`);
      if (!firstUnavailable) firstUnavailable = { response, candidate };
      else await response.body?.cancel?.().catch(() => {});
    }
    if (!upstream) {
      // Everything was unavailable: report the FIRST model's real error, not
      // the last fallback's, since that's the one that was actually asked for.
      upstream = firstUnavailable.response;
      used = firstUnavailable.candidate;
    } else if (firstUnavailable) {
      await firstUnavailable.response.body?.cancel?.().catch(() => {});
      console.warn(`[fallback] ${firstUnavailable.candidate.id} unavailable, answered by ${used.id}`);
    }
    stopHeartbeat();
    if (!res.headersSent) {
      res.setHeader("x-nim-model-used", used.id);
      if (used !== candidates[0]) res.setHeader("x-proxy-fallback-from", candidates[0].id);
    }

    if (!streaming) {
      const rawText = await upstream.text();
      if (!upstream.ok) {
        return res.status(upstream.status).json(buildErrorPayload(upstream.status, rawText));
      }
      let data;
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        return res.status(502).json({
          error: { message: `NIM returned 200 with an unparseable body: ${rawText.slice(0, 300)}` },
        });
      }
      return res.status(upstream.status).json(mergeReasoningNonStreaming(data));
    }

    if (!upstream.ok) {
      const rawText = await upstream.text().catch(() => "");
      const payload = buildErrorPayload(upstream.status, rawText);
      // Normal case: nothing sent yet, so return the real HTTP status.
      if (!sseStarted) return res.status(upstream.status).json(payload);
      // We already committed to a 200 stream (to keep the connection
      // alive), so report the failure inside the stream instead.
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    // Streaming: NIM sends reasoning_content and content as separate delta
    // fields across SSE chunks. We rewrite each chunk so reasoning deltas
    // become normal content deltas wrapped in <think>...</think>, and
    // insert the closing tag right before real content starts — so from
    // Janitor AI's side it's just one continuous text stream.
    startSse();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sentOpenTag = false;
    let sentCloseTag = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep the last, possibly incomplete line

      for (const line of lines) {
        if (!line.startsWith("data: ")) {
          res.write(line + "\n");
          continue;
        }
        const payload = line.slice(6);
        if (payload === "[DONE]") {
          res.write(`data: [DONE]\n\n`);
          continue;
        }
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          res.write(line + "\n");
          continue;
        }

        const delta = chunk.choices?.[0]?.delta;
        if (delta) {
          const reasoningPiece = delta.reasoning_content || delta.reasoning || delta.thinking;
          if (reasoningPiece) {
            let text = reasoningPiece;
            if (!sentOpenTag) {
              text = "<think>\n" + text;
              sentOpenTag = true;
            }
            delta.content = text;
            delete delta.reasoning_content;
            delete delta.reasoning;
            delete delta.thinking;
          } else if (delta.content && sentOpenTag && !sentCloseTag) {
            delta.content = "\n</think>\n\n" + delta.content;
            sentCloseTag = true;
          }
        }

        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    }
    res.end();
  } catch (err) {
    stopHeartbeat();
    if (clientGone) return; // the caller hung up; nobody left to tell
    if (!res.headersSent) {
      res.status(502).json({ error: { message: `Failed to reach NVIDIA NIM: ${err.message}` } });
    } else {
      // Mid-stream failure: tell the client instead of silently cutting off.
      try {
        res.write(`data: ${JSON.stringify({ error: { message: `Stream interrupted: ${err.message}` } })}\n\n`);
        res.write("data: [DONE]\n\n");
      } catch {
        // connection already gone
      }
      res.end();
    }
  }
});

app.use((err, req, res, next) => {
  console.error("[proxy error]", err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: { message: `Proxy error: ${err.message || "unknown error"}` } });
});

export default app;

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Proxy listening on http://localhost:${PORT}`);
    console.log(`Point Janitor AI's custom proxy at: http://<your-public-url>:${PORT}/v1`);
  });
}
