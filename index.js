import express from "express";

const app = express();
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

  // Confirmed real and free on NIM (build.nvidia.com/z-ai/glm-5.2). Per
  // its own vLLM docs, thinking is ON BY DEFAULT — no extra parameter
  // needed, so this is a plain passthrough. reasoning_effort can be set
  // to "high" (faster, less thorough) instead of the default "max".
  "glm-5.2": {
    id: "z-ai/glm-5.2",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: {},
  },
  "glm-5.2-fast": {
    id: "z-ai/glm-5.2",
    mode: "kwargs",
    forceThinking: true,
    kwargsOn: { chat_template_kwargs: { reasoning_effort: "high" } },
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
  const out = { ...body, model: config.id };
  const wantThinking = config.forceThinking || body.thinking !== false;

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

  delete out.thinking; // our own flag, not a real NIM/OpenAI param
  return out;
}

// Merges NIM's separate reasoning_content into the visible message so
// Janitor AI (which just renders `content`) actually shows the thinking
// trace, wrapped in <think> tags — the same convention DeepSeek-R1-style
// UIs use, so it reads naturally as "the model thinking out loud."
function mergeReasoningNonStreaming(data) {
  const choice = data?.choices?.[0];
  const msg = choice?.message;
  if (msg?.reasoning_content) {
    msg.content = `<think>\n${msg.reasoning_content}\n</think>\n\n${msg.content || ""}`;
    delete msg.reasoning_content;
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

app.post("/v1/chat/completions", async (req, res) => {
  if (!NIM_KEY) {
    return res.status(500).json({ error: { message: "Proxy misconfigured: NVIDIA_API_KEY env var is not set." } });
  }

  const reqBody = req.body || {};
  const config = resolveModel(reqBody.model);
  const nimBody = buildNimBody(config, reqBody);
  const streaming = !!nimBody.stream;

  try {
    const upstream = await fetch(`${NIM_BASE}/chat/completions`, {
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
          if (delta.reasoning_content) {
            let text = delta.reasoning_content;
            if (!sentOpenTag) {
              text = "<think>\n" + text;
              sentOpenTag = true;
            }
            delta.content = text;
            delete delta.reasoning_content;
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
