---
name: apimodels-image
description: Generate and edit images through apimodels.app — one API key for GPT Image 2, Gemini 3 Pro Image, Qwen Image 3.0, Seedream, Kling and Grok Imagine. Use when the user wants to create an image, edit or restyle an existing image, fuse several reference images, or upscale a photo. Also use when they ask which image model to pick or what a generation will cost.
homepage: https://apimodels.app
metadata:
  emoji: "🖼️"
  requires:
    bins: ["node"]
  primaryEnv: "APIMODELS_API_KEY"
---

# apimodels.app — image generation

One key, 24 image models from OpenAI, Google, Alibaba, ByteDance, xAI and Kuaishou,
all behind one endpoint. Switching models is a one-field change.

## Rules

1. **Never invent a model name.** Every model you may use is listed in
   `data/models.json`. If the user asks for something not in that file, say so and
   offer the closest listed model — do not guess a name and do not pass an
   unlisted string to the API. A wrong model name is a hard 400, and a *plausible*
   wrong name is worse: it teaches the user something false about this platform.
2. **Read `data/models.json` before choosing.** It carries the live model ids,
   prices and doc links. Do not answer pricing questions from memory.
3. **Always run `scripts/generate.mjs`.** Do not hand-roll curl or fetch calls —
   the script handles auth, async polling, R2 download and error shapes that are
   easy to get wrong (this API returns HTTP 200 with a `code` field for some
   failures).
4. **State the cost before a batch.** For a single image just generate. For
   anything ≥5 images, tell the user the total first and let them confirm.
5. **Tell the user what you picked and why**, in one line. "Using gpt-image-2 at
   2K ($0.03) because your poster has small text" beats silently choosing.
6. **Results expire in 7 days.** Whenever you hand back a URL, say so once. If the
   user needs it longer, offer to save the file locally with `--out`.
7. **Do not expose internal channel names.** The API returns clean model names;
   never mention upstream providers or routing slugs even if you see them.
8. **Failures are never charged.** If a generation fails, say so plainly and offer
   a retry or a different model — do not imply the user paid for it.

## Setup

The key comes from https://apimodels.app → Console → API Keys.

```bash
export APIMODELS_API_KEY=sk_...
node scripts/generate.mjs --check      # verifies the key and prints the balance
```

If `APIMODELS_API_KEY` is unset, stop and ask the user for a key. Do not proceed
with a placeholder.

## Choosing a model

Read `data/models.json` for the full list. This table is the decision shortcut —
when a request clearly matches a row, take it; otherwise show the user 2-3
candidates with prices and let them choose.

| The user wants | Model | Why |
|---|---|---|
| A general image, good all-rounder | `gpt-image-2` | Native 1K/2K/4K, best general in-image text, 16 reference images |
| Cheapest usable draft | `sparkpix-image` ($0.008) or `gpt-image-2-lite` ($0.008) | For iterating before a final render |
| **Text-heavy layout** — poster, menu, infographic, UI mock | `qwen3-image` | 10px small text, 12 languages, 20+ fonts; 1K and 2K same price |
| Same, but photoreal detail matters | `qwen3-image-pro` | Slower (median 121s, 10% over 324s) — allow 8 minutes |
| Realistic portrait / highest fidelity | `gemini-3-pro-image` | Gemini 3 Pro Image |
| Fast cheap Gemini | `gemini-3.1-flash-image` or `gemini-2.5-flash-image` ($0.02) | |
| E-commerce product shots, 4K | `doubao-seedream-5-0-pro` | Seedream, 1K/2K/4K |
| Edit / restyle an existing image | any model above + `--image <url>` | Passing a reference switches the same model to edit mode |
| Fuse several references | `gpt-image-2` (up to 16) or `kling-multi-image` | |
| Enlarge / upscale a photo | `real-esrgan` ($0.004) | Pure upscaler, not a generator |
| Extend/outpaint a photo's canvas | `kling-expand` | |

**When the user has no preference and the prompt has no text in the image:**
default to `gpt-image-2`. It is the safest all-rounder here.

**Rules of thumb worth saying out loud:**
- Text in the image → Qwen Image 3.0. It is the one that reliably renders small type.
- 4K needed → `gpt-image-2` or Seedream. Qwen tops out at 2K.
- Nobody needs Pro tiers for drafts. Iterate cheap, render final expensive.

## Generating

```bash
# Text to image
node scripts/generate.mjs --model gpt-image-2 --prompt "a red bicycle on a wet street at night"

# Common options
#   --resolution 1K|2K|4K        (model-dependent; see data/models.json)
#   --aspect 1:1|16:9|9:16|4:3|3:4|3:2|2:3|21:9
#   --image <url>                reference image; repeat for several
#   --out ./picture.png          also download the result next to you
#   --json                       machine-readable output

# Edit an existing image
node scripts/generate.mjs --model qwen3-image --image https://example.com/a.jpg \
  --prompt "keep the subject, change to soft evening light"

# Upscale
node scripts/generate.mjs --model real-esrgan --image https://example.com/small.jpg
```

The script creates the task, polls until it finishes, and prints the result URL
(plus a local path when `--out` is given). It exits non-zero on failure.

### Long generations

Most images land in 30-120 seconds; some models are slower (Qwen Pro has a long
tail past 5 minutes). **Before running anything you expect to exceed ~30 seconds,
tell the user it is running** — do not leave them watching a silent terminal.
The script prints progress as it polls.

## Reference images

- Pass public HTTPS URLs. Local paths are not uploaded by this script.
- Limits differ per model — `gpt-image-2` takes 16, `qwen3-image` takes 3. The
  API rejects an over-limit request at creation rather than silently dropping
  extras, so you will get a clear error.
- Extra references usually cost extra (Qwen: $0.004 each). Mention it when it
  changes the total meaningfully.

## Errors

The script normalises these; surface them in plain language:

| What you see | What it means | What to do |
|---|---|---|
| `401` | Bad or missing API key | Ask the user to re-copy it from the console |
| `402` | Not enough balance | Tell them the shortfall; link https://apimodels.app/console/credits |
| `400 Invalid model` | Name not in the catalog | Re-read `data/models.json`, pick a listed one |
| `CONTENT_MODERATION` | Prompt or reference was refused | Reword; retrying the same input will not help |
| `UPSTREAM_BUSY` | Model is loaded | Retry, or switch model — not charged |
| `TIMEOUT` | Took too long upstream | Retry; not charged |

## What this platform does NOT do

Say so directly rather than improvising:

- No mask-based inpainting. Region edits are done by passing the original as a
  reference and describing the change in words.
- No local file upload from this script — references must already be URLs.
- Results are not permanent; 7 days then deleted.
