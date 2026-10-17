# Janitor AI ↔ NVIDIA NIM proxy (with thinking mode)

OpenAI-compatible proxy for Janitor AI backed by [NVIDIA NIM](https://build.nvidia.com)'s
free model catalog, with reasoning ("thinking") mode normalized across
models that each expose it differently.

## Get a free key

Go to https://build.nvidia.com, click any model, then "Get API Key" (no
credit card required). Rate-limited but with no daily cap as of writing.

## Deploy (no command line needed)

1. Create a new empty repo at https://github.com/new.
2. On the repo page, click **"uploading an existing file"** and drag in
   every file here — including the `api` folder.
3. Commit to `main`.
4. Go to https://vercel.com/new, sign in with GitHub, **Import** the repo.
5. Before clicking Deploy, expand **Environment Variables** and add
   `NVIDIA_API_KEY` = your key from above.
6. Click **Deploy**.

Open your `.vercel.app` URL in a browser — you should see
`{"status":"ok",...}` with a `models` array.

**How routing works here, and why:** all requests get forwarded to this
single function as `/api?path=<real-path>` (see `vercel.json`), and the
function reconstructs the real path from that query parameter itself
before Express does any route matching. This is a deliberate choice —
an earlier version relied on Vercel preserving the original path
automatically when rewriting to a fixed destination, which reliably
produced a `Cannot POST /api` error in practice (Express receiving
literally `/api` as the path, no matter what was actually requested).
Passing the path through as a query parameter sidesteps that ambiguity
entirely, since query strings are unambiguously preserved by any
rewrite. If you ever see `Cannot POST /api` again after this fix, the
`?path=` parameter itself likely isn't reaching the function — check
`vercel.json`'s rewrite is deployed correctly.

## Configure Janitor AI

- **Endpoint:** `https://your-project-name.vercel.app/v1`
- **API Key:** anything — e.g. `not-needed`
- **Model:** one of:

| Model | Thinking | Notes |
|---|---|---|
| `nemotron-49b-thinking` | always on | 49B, reliable, official NVIDIA reasoning docs |
| `nemotron-49b` | off | same model, concise answers |
| `nemotron-nano-9b-thinking` | always on | smaller/faster |
| `nemotron-nano-9b` | off | smaller/faster |
| `nemotron-omni-30b-thinking` | always on (reasoning-only checkpoint) | no non-thinking variant exists |
| `deepseek-v4.1-flash-thinking` | always on, effort 50/100 | 552B MoE, 8B/16B active, multimodal (text+image in), 1M context — replaces all prior DeepSeek models |
| `deepseek-v4.1-flash-max` | always on, effort 100 | most thorough — untested at this setting in practice, see caveat below |
| `deepseek-v4.1-flash-fast` | always on, effort 25 | quickest option |
| `deepseek-v4.1-flash` | effort 50 by default, respects `thinking:false` override | same model, can be fully disabled unlike the other variants |
| `kimi-k3-thinking` | always on, `reasoning_effort: high` (can't be disabled) | 2.8T/104B active, 1M context — see multi-turn caveat below |
| `kimi-k3-max` | always on, `reasoning_effort: max` | most thorough, risks the same Vercel timeout DeepSeek-Pro-max hit |
| `kimi-k3-fast` | always on, `reasoning_effort: low` | quickest option for simple messages |
| `glm-5.3-thinking` | always on, `reasoning_effort: high` (can't be disabled) | 753B MoE, 1M context. NIM has been returning an empty 404 for this model (NVIDIA-side, not a proxy bug) |
| `glm-5.3-max` | always on, `reasoning_effort: max` | most thorough — may hit the same Vercel timeout risk as DeepSeek-Pro-max |
| `glm-5.3-fast` | always on, `reasoning_effort: low` | quickest option |
| `glm-5.3-flash-thinking` (also just `glm-5.3-flash`) | always on, `reasoning_effort: high` (can't be disabled) | 320B MoE / 18B active, natively multimodal, 1M context. A separate deployment from `glm-5.3`, so it may work when `glm-5.3` 404s (not guaranteed) |
| `glm-5.3-flash-max` | always on, `reasoning_effort: max` | most thorough, slowest |
| `glm-5.3-flash-fast` | always on, `reasoning_effort: low` | quickest option |

**Any other NVIDIA NIM model works too** — just send its real model id (the
kind with a `/` in it, e.g. `qwen/qwen3-235b-a22b`,
`meta/llama-3.1-70b-instruct`, `mistralai/mistral-large-2-instruct`). The
proxy passes these straight through with no thinking-mode handling (since
NIM has 100+ models and each family's mechanism differs — only the
models above get that normalization). See the full live catalog:

```bash
curl https://your-project-name.vercel.app/v1/models
```

Default if you send an unrecognized model name: `nemotron-49b-thinking`.

## How thinking mode actually works here

NVIDIA NIM has no single standard way to toggle reasoning — each model
family does it differently:

- **`nemotron-49b*`** — a literal system-prompt string, `"detailed
  thinking on"` / `"detailed thinking off"`. Confirmed in NVIDIA's own
  docs.
- **`nemotron-nano-9b*`** — a `/think` or `/no_think` suffix appended to
  the system prompt. Also confirmed in NVIDIA's own docs.
- **`nemotron-omni-30b-thinking`** — a `chat_template_kwargs` parameter,
  community-sourced and best-effort (not in NVIDIA's own docs directly).
- **`deepseek-v4.1-flash*`** — unlike every other DeepSeek model this
  proxy has used, reasoning here is a **continuous 1–100 dial**
  (`reasoning_effort`), not discrete tiers — confirmed from vLLM's own
  official serving recipe for this exact model
  (recipes.vllm.ai/deepseek-ai/DeepSeek-V4.1-Flash). `"none"` turns
  thinking off entirely. The `thinking` field on this model is a plain
  **boolean**, not an object — different from GLM-5.3's
  `{type: "enabled"}` shape, deliberately not reused here.
  **A real gotcha baked around, not just documented:** this model's own
  docs confirm that if neither `thinking` nor `reasoning_effort` is set,
  it defaults to thinking ON at effort 50 — and a small `max_tokens` can
  then get entirely consumed by the reasoning trace, returning **empty
  actual content** with `finish_reason=length` (looks like a broken
  model; isn't one). Every variant in this proxy explicitly sets both
  fields for exactly this reason, so this failure mode shouldn't be
  reachable through Janitor AI — if a reply does come back empty, that's
  the first thing to check.
  **`deepseek-v4.1-flash-max` is untested at full effort in practice** —
  this model is much smaller than the old DeepSeek-V4-Pro-0813 (552B vs
  1.6T total params), so the Vercel-timeout issue that forced `-0813`
  away from `"max"` by default is less likely here, but hasn't actually
  been confirmed fast enough. Worth testing with the curl command below
  before relying on it live.
- **`glm-5.3*`** — Z.ai's own format uses a top-level `thinking:
  {type: "enabled"}` object plus a top-level `reasoning_effort` field,
  different again from DeepSeek's `chat_template_kwargs` shape. This
  proxy sends both conventions at once (redundant, but robust to which
  one NIM's specific deployment actually honors) rather than betting on
  just one — the same lesson from GLM-5.2's default assumption failing
  applies here too. Thinking can't be disabled on this model at all
  (Z.ai's own migration notes call this a breaking change from GLM-5.2).
  **A bug this surfaced and fixed:** GLM-5.3's required `thinking` field
  has the same name as this proxy's own internal on/off control flag —
  an earlier version of the code unconditionally deleted any `thinking`
  key before sending the request (meant to strip the internal flag),
  which silently wiped out GLM-5.3's actual required parameter instead.
  Fixed by stripping the internal flag from the incoming request first,
  before any model-specific parameters get added — a model's own
  legitimately-named field can no longer collide with proxy-internal
  bookkeeping.

The proxy picks the right mechanism automatically based on which
`model_name` you send — you don't need to know any of this to use it,
this is just what's happening under the hood.

## Where the thinking trace shows up

NIM returns reasoning in a separate `reasoning_content` field, not inside
the normal reply text — but Janitor AI's chat UI only renders the regular
`content` field, so it would never see the reasoning at all. This proxy
merges the two: the reasoning trace gets wrapped in `<think>...</think>`
and prepended to the actual reply, so it shows up right in the chat
message, followed by the real answer. Works the same for both streamed
and non-streamed responses.

If you'd rather not see the reasoning trace inline in Janitor AI, use the
non-thinking variant of a model (e.g. `nemotron-49b` instead of
`nemotron-49b-thinking`) — the omni-30b and Kimi K3 models are
reasoning-only, so there's no way to turn thinking off for those.

## Kimi K3's multi-turn limitation (can't be fixed at the proxy level)

Kimi K3 is designed to receive its own previous `reasoning_content` back
on every turn of a conversation — without it, Moonshot's own docs note
reasoning quality degrades over a multi-turn session. Janitor AI's client
only ever sends and stores plain `content`; it has no concept of
`reasoning_content` at all, so it can't echo something it never receives
in a form it recognizes. This proxy strips reasoning into a visible
`<think>` block specifically so *you* can see it, but that's a display
choice — it doesn't reconstruct the original structured field Kimi wants
back. Practically: expect Kimi K3's reasoning quality in Janitor AI to
hold up fine for shorter exchanges, but potentially drift on very long
roleplay sessions. This is a limitation of what Janitor AI's client
sends, not something fixable by changing this proxy's code.

## Connection errors through Lorebary / the Janitor app (`upstream_transport_error`)

If you route Janitor AI → Lorebary → this proxy, the request passes through
more than one server. `upstream_transport_error` ("The AI provider could not
be reached") means a connection in that chain dropped or timed out before
any response arrived. It is not an error message from the model. The Play
Store app and the browser can behave differently here (for example in
timeouts or whether replies are streamed), which is why one can work while
the other fails.

What this version does about it:

- **Keep-alive on slow streams.** If NIM hasn't started answering within 5
  seconds, the proxy opens the stream anyway and sends `: keep-alive`
  comment lines every 10 seconds (valid SSE that clients ignore), so
  intermediaries don't treat the silence as a dead connection.
- **Capped 429 waiting.** The retry wait is capped at 8 seconds. Before, a
  long `Retry-After` could run into Vercel's 60s limit and the caller saw a
  dropped connection instead of a clean 429.
- **Hang-ups cancel the NIM request** instead of leaving it running.
- **Mid-stream failures are reported** inside the stream instead of the
  reply just cutting off.
- `Authorization` is now listed explicitly in the CORS headers (the bare
  `*` wildcard does not cover it in browsers).

What it can't fix:

- **Non-streaming requests** send nothing until the whole reply is done, so
  there is nothing to keep alive. If the app uses non-streaming and a reply
  takes longer than Vercel's 60s limit, the connection is cut. Use a faster
  variant (`-fast`, or a non-reasoning model), or turn streaming on if your
  Janitor settings allow it.
- **Lorebary or Janitor-side settings.** After changing a proxy URL or
  model, reload the Janitor page or app fully. The connection settings are
  read when the chat loads, so a saved but not reloaded change looks
  exactly like a broken proxy. Lorebary reportedly has a status page at
  status.lorebary.com worth checking if everything fails at once.

Quickest way to tell where the break is: watch your Vercel project's live
logs while sending a message from the app. If no request from Lorebary
appears at all, the problem is before this proxy (Lorebary URL/config, or
the app not reaching Lorebary). If requests appear but run long or time
out, it's a latency problem and the fixes above apply. Also try a fast
non-reasoning model (`nemotron-nano-9b`) in the app: if that works and the
big reasoning models don't, it's timeouts rather than a wrong URL.

## Quick manual test

```bash
curl -i https://your-project-name.vercel.app/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nemotron-49b-thinking",
    "messages": [{"role": "user", "content": "What is 17 * 24?"}]
  }'
```

You should see the reply's `content` field start with `<think>` followed
by the reasoning, then `</think>` and the actual answer.

## If something goes wrong

- **Test the endpoint directly first**, before Janitor AI — the curl
  command above, or open `/v1/models` in a browser.
- **Check Vercel's Deployments tab** for a red ✗ and its build/runtime log.
- **Confirm `NVIDIA_API_KEY`** is set for the Production environment in
  Vercel's project settings, and redeploy after any change to it.
- **"Cannot POST /api" or similar** — this project's routing config went
  through a few iterations before landing on the current one (a named
  `api/index.js` function plus a `vercel.json` rewrite pointing at it,
  rather than the special-cased `api/index.js`). If you still see this
  after deploying the current files, that's a genuine open question, not
  a known/expected failure mode — test directly with
  `curl -i https://your-project.vercel.app/v1/models` and share the exact
  output (status code and body) rather than just the error message, since
  that's what actually narrows down the cause.

## Notes

- NVIDIA's free tier is a "preview" offering — rate limits and available
  models can change without much notice. `GET /v1/models` on your proxy
  always reflects the current `MODEL_CONFIGS` in `api/index.js`; NVIDIA's
  own catalog is at https://build.nvidia.com.
- **429 "Too Many Requests"** means you've hit NVIDIA's real per-minute
  rate limit — this proxy automatically retries a request up to twice
  (honoring NVIDIA's `Retry-After` header when it sends one) before
  giving up, so brief bursts usually resolve on their own. If you still
  see a 429 after that, you're sending faster than the limit allows —
  wait a bit before the next message.
- This proxy adds no rate limiting or auth of its own beyond what NVIDIA
  enforces — anyone who finds your `.vercel.app` URL can use your quota.
