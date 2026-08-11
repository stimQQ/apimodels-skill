# apimodels-skill

**Agent Skills** for [apimodels.app](https://apimodels.app) — let Claude Code,
Cursor and other coding agents call 120+ AI models through a single API key.

| Skill | Status | Covers |
|---|---|---|
| [`image/`](image/) | ✅ available | 24 image models — generate, edit, fuse references, upscale |
| `video/` | planned | Seedance, Kling, VEO, MiniMax Hailuo, Grok Video |
| `audio/` | planned | ElevenLabs, MiniMax, Suno, Kling TTS |

---

## `image` — generation and editing

**24 image models from OpenAI, Google, Alibaba, ByteDance, xAI and Kuaishou
behind one API key.**

Ask your agent for a picture; it picks a sensible model, tells you what it will
cost, generates, and hands back the file.

```
You:  make me a poster for a coffee shop opening, vertical, with a bold title
Agent: Using qwen3-image ($0.035) — it renders small text reliably.
       ▸ generating…
       ✓ done in 71s → coffee-poster.png
```

## Install

**In Claude Code / OpenClaw / any agent that reads skills:**

```
Install the apimodels image skill from https://github.com/stimQQ/apimodels-skill
```

**Manually:**

```bash
git clone https://github.com/stimQQ/apimodels-skill
cp -r apimodels-skill/image ~/.claude/skills/apimodels-image   # the skill is image/, not the repo root
export APIMODELS_API_KEY=sk_...                                 # from https://apimodels.app/console/api-keys
```

**Claude desktop / claude.ai** install a skill from a `.zip` instead
(Settings → Capabilities → enable *Code execution*, then Customize → Skills →
`+ Create skill`). Zip the `image/` directory so that it is the root of the
archive:

```bash
cd apimodels-skill && zip -r apimodels-image.zip image -x '*.DS_Store'
```

**No shell?** (claude.ai, Claude desktop — the sandbox has no access to your
environment, and Claude has no per-skill credential store today.) Just paste the
key when the agent asks. It saves it to `~/.apimodels/credentials` (mode 0600)
and will not ask again. The key is never echoed back and never passed as a
command argument.

Verify:

```bash
node image/scripts/generate.mjs --check
```

Requires Node 18+ (for built-in `fetch`). No npm install, no dependencies.

## What you get

| | |
|---|---|
| **One key** | Every model below, plus video, LLM and audio on the same key |
| **Text-heavy layouts** | Qwen Image 3.0 renders 10px type, 12 languages, 20+ fonts |
| **Native 4K** | GPT Image 2 and Seedream |
| **Editing** | Pass a reference URL to any model — same endpoint, no mode switch |
| **From $0.008/image** | Iterate cheap, render final expensive |
| **Failures are free** | Only successful generations are charged |

Full catalog with live prices: [`image/data/models.json`](image/data/models.json) — 24 models
including `gpt-image-2`, `gemini-3-pro-image`, `qwen3-image`, `qwen3-image-pro`,
`doubao-seedream-5-0-pro`, `grok-imagine-image`, `kling-image-o1`, `real-esrgan`.

## Direct use (no agent)

```bash
# Text to image
node image/scripts/generate.mjs --model gpt-image-2 --prompt "a red bicycle at night" --resolution 2K

# Edit an existing image
node image/scripts/generate.mjs --model qwen3-image \
  --image https://example.com/photo.jpg \
  --prompt "keep the subject, change the background to a quiet library" \
  --out edited.png

# Upscale
node image/scripts/generate.mjs --model real-esrgan --image https://example.com/small.jpg --out big.png
```

## How it is put together

```
image/
├── SKILL.md              routing table, model-choice rules, error handling
├── scripts/
│   ├── generate.mjs      create → poll → download. Zero dependencies, Node 18+.
│   └── build_catalog.mjs checks data/models.json against what the API accepts
└── data/models.json      model ids, prices, doc links
```

Paths inside `SKILL.md` are relative to `image/`, which is what an agent loads as
the skill root. The `image/` prefix in this README is for running the scripts
directly from the repository root.

`SKILL.md` tells the agent to **never invent a model name** — the catalog is the
only allowed source. That matters more than it sounds: a plausible-but-wrong model
name teaches the user something false about the platform, and language models are
very good at producing plausible-but-wrong names.

## Notes

- Result URLs expire after **7 days**. Use `--out` to keep the file.
- Reference images must be public HTTPS URLs; this script does not upload local files.
- There is no mask-based inpainting — region edits are done by passing the
  original as a reference and describing the change in words.

## Licence

Apache-2.0
