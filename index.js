import express from "express";
import { parse as parseUrl } from "node:url";

const app = express();

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
  const parsed = parseUrl(req.url, true);
  if (typeof parsed.query.path === "string") {
    const { path, ...rest } = parsed.query;
    const search = new URLSearchParams(rest).toString();
    req.url = "/" + path + (search ? `?${search}` : "");
  }
  // If "path" isn't present (e.g. local dev via `node api/index.js`,
  // where no Vercel rewrite is involved), leave req.url untouched.
  next();
});

app.use(express.json({ limit: "25mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
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
// "system_prompt" and "system_suffix" entries are confirmed against
// NVIDIA's own docs (docs.nvidia.com/nim/large-language-models). "kwargs"
// entries (DeepSeek V4, the omni-reasoning Nemotron) are sourced from
// community tooling rather than NVIDIA's official docs, since NVIDIA
// doesn't document those specific parameters directly — treat those two
// as best-effort and check GET /v1/models if one starts erroring.
const MODEL_CONFIGS = {
  // Official NVIDIA docs: literal system-prompt strings toggle reasoning.
  "nemotron-49b": {
    id: "nvidia/llama-3.3-nemotron-super-49b-v1",
    mode: "system_prompt",
    on: "detailed thinking on",
    off: "detailed thinking off",
  },
  "nemotron-49b-thinking": {
    id: "nvidia/llama-3.3-nemotron-super-49b-v1",
    mode: "system_prompt",
    forceThinking: true,
    on: "detailed thinking on",
  },

  // Official NVIDIA docs: /think or /no_think suffix on the system prompt.
  "nemotron-nano-9b": {
    id: "nvidia/nvidia-nemotron-nano-9b-v2",
    mode: "system_suffix",
    on: " /think",
    off: " /no_think",
  },
  "nemotron-nano-9b-thinking": {
    id: "nvidia/nvidia-nemotron-nano-9b-v2",
    mode: "system_suffix",
    forceThinking: true,
    on: " /think",
  },

  // Community-sourced (chat_template_kwargs) — this checkpoint is
  // reasoning-only, so there's no "thinking off" variant.
  "nemotron-omni-30b-thinking": {
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: { chat_template_kwargs: { enable_thinking: true }, reasoning_budget: 16384 },
  },

  // Community-sourced (chat_template_kwargs) — flag as best-effort.
  "deepseek-v4-flash": {
    id: "deepseek-ai/deepseek-v4-flash",
    mode: "kwargs",
    kwargsOn: { chat_template_kwargs: { thinking: true } },
    kwargsOff: { chat_template_kwargs: { thinking: false } },
  },
  "deepseek-v4-flash-thinking": {
    id: "deepseek-ai/deepseek-v4-flash",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: { chat_template_kwargs: { thinking: true } },
  },

  // GLM-5.2 is deprecated on NIM as of this update — replaced with
  // DeepSeek V4 Flash 0731. Unlike GLM-5.2, this parameter shape is taken
  // directly from NVIDIA's own official sample code at
  // build.nvidia.com/deepseek-ai/deepseek-v4-flash-0731, not guessed —
  // their sample explicitly checks for reasoning under either
  // `.reasoning` or `.reasoning_content`, confirming the broadened
  // field-detection in mergeReasoningNonStreaming/streaming below.
  // Caveat (unrelated to config correctness): several NVIDIA developer
  // forum threads report this specific model hallucinating more than the
  // model it replaced — worth knowing, not something a proxy can fix.
  "deepseek-v4-flash-0731": {
    id: "deepseek-ai/deepseek-v4-flash-0731",
    mode: "kwargs",
    kwargsOn: { chat_template_kwargs: { thinking: true, reasoning_effort: "high" } },
    kwargsOff: { chat_template_kwargs: { thinking: false } },
  },
  "deepseek-v4-flash-0731-thinking": {
    id: "deepseek-ai/deepseek-v4-flash-0731",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: { chat_template_kwargs: { thinking: true, reasoning_effort: "high" } },
  },

  // DeepSeek-V4-Pro-0813 — confirmed real on NIM directly against
  // NVIDIA's own API reference (docs.api.nvidia.com/nim/reference/
  // deepseek-ai-deepseek-v4-pro-0813). The larger sibling of Flash-0731:
  // 1.6T total / 49B active params, native 1M-token context window (no
  // special parameter needed for that — it's just the model's built-in
  // limit, same as any other model's context size). Three reasoning
  // levels: Non-think, Think High, Think Max.
  //
  // Set to "max" (most thorough) by request. Known tradeoff: "max" on
  // this 1.6T model previously exceeded Vercel's 60s function timeout in
  // practice, surfacing to Janitor AI as a generic "Failed to fetch" with
  // no error body (Vercel kills the function before any response is
  // sent). If that recurs, either switch this back to "high" or use
  // deepseek-v4-pro-0813 (thinking off) instead.
  "deepseek-v4-pro-0813-thinking": {
    id: "deepseek-ai/deepseek-v4-pro-0813",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: { chat_template_kwargs: { thinking: true, reasoning_effort: "max" } },
  },
  // Identical to the default above now that it's also "max" — kept as an
  // explicit alias in case the default gets switched back to "high" later.
  "deepseek-v4-pro-0813-max": {
    id: "deepseek-ai/deepseek-v4-pro-0813",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: { chat_template_kwargs: { thinking: true, reasoning_effort: "max" } },
  },
  "deepseek-v4-pro-0813": {
    id: "deepseek-ai/deepseek-v4-pro-0813",
    mode: "kwargs",
    kwargsOn: { chat_template_kwargs: { thinking: true, reasoning_effort: "max" } },
    kwargsOff: { chat_template_kwargs: { thinking: false } },
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
};

const DEFAULT_MODEL = "nemotron-49b-thinking";

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
    const delayMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 1000 * (attempt + 1);

    console.warn(`[nim rate-limited] attempt ${attempt + 1}/${maxRetries + 1}, retrying in ${delayMs}ms`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return lastResponse;
}

app.post("/v1/chat/completions", async (req, res) => {
  if (!NIM_KEY) {
    return res.status(500).json({ error: { message: "Proxy misconfigured: NVIDIA_API_KEY env var is not set." } });
  }

  const reqBody = req.body || {};
  const config = resolveModel(reqBody.model);
  const nimBody = buildNimBody(config, reqBody);
  const streaming = !!nimBody.stream;

  try {
    const upstream = await fetchWithRetry(`${NIM_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${NIM_KEY}` },
      body: JSON.stringify(nimBody),
    });

    if (!streaming) {
      const data = await upstream.json();
      return res.status(upstream.status).json(upstream.ok ? mergeReasoningNonStreaming(data) : data);
    }

    // Streaming: NIM sends reasoning_content and content as separate delta
    // fields across SSE chunks. We rewrite each chunk so reasoning deltas
    // become normal content deltas wrapped in <think>...</think>, and
    // insert the closing tag right before real content starts — so from
    // Janitor AI's side it's just one continuous text stream.
    res.status(upstream.status);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      res.write(`data: ${JSON.stringify({ error: { message: text || `NIM returned ${upstream.status}` } })}\n\n`);
      return res.end();
    }

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
    if (!res.headersSent) {
      res.status(502).json({ error: { message: `Failed to reach NVIDIA NIM: ${err.message}` } });
    } else {
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
