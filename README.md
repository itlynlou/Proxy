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
| `deepseek-v4-flash-thinking` | always on | best-effort — see caveat below |
| `deepseek-v4-flash` | off | best-effort — see caveat below |
| `deepseek-v4-flash-0731-thinking` | always on | newer checkpoint; request shape confirmed against NVIDIA's own official sample code |
| `deepseek-v4-flash-0731` | off | see hallucination caveat below |

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
- **`nemotron-omni-30b-thinking`, `deepseek-v4-flash*`,
  `deepseek-v4-flash-0731*`** — a `chat_template_kwargs` /
  `reasoning_effort` parameter in the request body. The `-0731` variant's
  request shape is confirmed directly from NVIDIA's own official sample
  code at build.nvidia.com/deepseek-ai/deepseek-v4-flash-0731 — the other
  two are community-sourced and best-effort. **Caveat for
  `deepseek-v4-flash-0731` specifically:** several recent NVIDIA developer
  forum threads report this checkpoint hallucinating more than the model
  it replaced — worth knowing going in, not something a proxy can fix.
  If a model in this group stops showing a `<think>` block, check
  `GET /v1/models` on your proxy and the model's own page at
  build.nvidia.com — the exact parameter name may have changed.

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
`nemotron-49b-thinking`) — the omni-30b model is reasoning-only, so
there's no way to turn it off for that one specifically.

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
