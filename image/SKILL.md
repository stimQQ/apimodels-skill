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

## The API key

Run `node scripts/generate.mjs --check` first. It finds a key in this order:
`APIMODELS_API_KEY` in the environment, then `~/.apimodels/credentials`.

**If it reports no key, ask the user for one — do not proceed with a placeholder
and do not guess.** The rule that shapes everything below: **the key should never
appear in the conversation.** A key that enters the chat lives on in transcripts
and logs; the flows here exist to keep it out.

**First choice, wherever a browser exists — one click, nothing typed:**

```bash
node scripts/generate.mjs --login
```

Run it yourself, then hand the user the printed link (it opens automatically on
a desktop). They log in to apimodels.app if needed and click **Authorize** —
that's the whole flow. A dedicated key named "CLI · date" is minted and
delivered straight to `~/.apimodels/credentials` over HTTPS: it never appears
in this conversation, the shell history, or even the browser address bar (only
a single-use, 10-minute code transits the redirect). When the command prints
"saved", re-run `--check` and continue. If the user asks what the link is, say:
it authorizes this machine, and the key it creates can be revoked individually
from their console at any time.

**Fallback if `--login` cannot work** (no browser on this machine, or the user
prefers not to): do **not** ask them to paste the key into the chat. Hand them
ONE finished command instead — they should never have to know how environment
variables work, where this skill is installed, or what `read -s` does. You do
the knowing; they do one paste.

Build the command yourself, with the **absolute path** to this skill's
`scripts/generate.mjs` already substituted (you know your own base directory;
the user does not), then say this — all four sentences, they each prevent a
support question:

> I need an apimodels.app API key — create one free at
> https://apimodels.app/console/api-keys.
> Then open a **new terminal window** (not this chat) and paste this whole line:
>
> ```
> read -s KEY && printf %s "$KEY" | node /ABSOLUTE/PATH/TO/scripts/generate.mjs --save-key && unset KEY
> ```
>
> It will wait silently — paste your key there and press Enter. Nothing appears
> on screen: that's `read -s` doing its job, and it also keeps the key out of
> your shell history. Tell me when it says "saved".

Why a NEW terminal window, spelled out because it is not obvious: anything typed
into this chat — including `!`-prefixed shell commands in Claude Code — lands in
the conversation and gets sent to the model. A separate window is what keeps the
key local. And an `export` in that separate window would NOT work either: this
agent's shell does not inherit it. The `--save-key` file is the only handoff
that reliably reaches the skill from another window, which is why it is the
primary flow.

When they say done, re-run `node scripts/generate.mjs --check` and continue with
what they originally asked for. Do not make them repeat any of it.

Two alternatives, offered only if they fit:

- Users who already manage their own environment (dotfiles, CI, direnv) can set
  `APIMODELS_API_KEY` there instead — mention the variable name and move on;
  don't dictate their setup. (Skip suggesting `echo 'export ...=sk_x' >> ~/.zshrc`
  yourself: the pasted key would sit in shell history via the echo line.)
- On Windows without a POSIX shell, `read -s` won't run; the env-var route via
  System Settings, or pasting into the chat as the sandbox fallback below (with
  its mandatory rotation step), are the remaining options.

**Only if there is genuinely no terminal** (claude.ai web and desktop sandboxes —
the sandbox cannot see the user's shell, and there is no per-skill credential
store today): as a **last resort**, the user may paste the key into the chat.
If they do, both steps are mandatory:

1. Save it immediately so this never has to happen again:
   `printf %s 'sk_THEIR_KEY' | node scripts/generate.mjs --save-key`
2. Tell them — as a standard step, not a suggestion — that the key has now been
   in this conversation, so once they are done they should rotate it at
   https://apimodels.app/console/api-keys and set the replacement without
   pasting it into any chat.

**Handling their key — these are not optional:**

- **Never echo the key back**, not in a summary, not in a confirmation, not in a
  code block. `--save-key` prints only the last 4 characters for exactly this
  reason.
- **Never pass it as a command argument.** There is no `--key` flag on purpose:
  arguments land in the transcript and in process listings. It goes in on stdin.
- **Never write it into a file the user might commit** — no `.env` in their repo,
  no config in the project directory. `~/.apimodels/credentials` (mode 0600) is
  the only place.
- **Any key that has appeared in the conversation is a rotation case** — apply
  step 2 above whenever it happens, however it happened.

## Choosing a model

Read `data/models.json` for the full list. This table is the decision shortcut —
when a request clearly matches a row, take it; otherwise show the user 2-3
candidates with prices and let them choose.

| The user wants | Model | Why |
|---|---|---|
| A general image, good all-rounder | `gpt-image-2` | Native 1K/2K/4K, best general in-image text, 16 reference images |
| Cheapest usable draft | `sparkpix-image` ($0.008) or `gpt-image-2-lite` ($0.01, ~1.5 MP) | For iterating before a final render |
| Newest OpenAI image model, fast | `gpt-image-2.5-flare` | Price = resolution x quality ($0.008 1K-low … $0.30 4K-max); default medium. Pass `--quality` to pick the tier |
| Newest OpenAI image model, max precision | `gpt-image-2.5-sunburst` | Same price grid as Flare, ~1.6x slower, default high. For hero shots, packaging, print |
| Grok look, cheap | `grok-4.2-image` ($0.0075) | Budget tier of Grok Imagine Image |
| Grok Imagine newest | `grok-imagine-image-2.0` ($0.03–$0.06) | 1K/2K; `--quality low` or `medium` picks the price |
| **Text-heavy layout** — poster, menu, infographic, UI mock | `qwen3-image` | 10px small text, 12 languages, 20+ fonts; 1K and 2K same price |
| Same, but photoreal detail matters | `qwen3-image-pro` | Slower (median 121s, 10% over 324s) — allow 8 minutes |
| Realistic portrait / highest fidelity | `gemini-3-pro-image` | Gemini 3 Pro Image |
| Fast cheap Gemini | `gemini-3.1-flash-image` ($0.06 at 1K/2K) | `gemini-2.5-flash-image` is retired by Google on 2026-10-02 — do not start new work on it |
| Fast, cheap volume renders | `doubao-seedream-5-0-flash` ($0.03) | ~10–15 s, 1K and 2K same price, no 4K |
| Fastest, lowest-cost generation | `flux-2-klein-4b` ($0.006) | About 1-2 s; up to 3 reference images (+$0.0015 each); fixed ~2 MP, no resolution choice |
| Gemini 3 Pro on a budget | `gemini-3-pro-image-gemini` ($0.03 flat, incl. 4K) | Same model as `gemini-3-pro-image` at a lower flat price; pick the standard one when consistency matters most |
| Gemini Flash on a budget | `gemini-3.1-flash-image-gemini` ($0.025 flat) | Same model as `gemini-3.1-flash-image` at a lower flat price |
| Exact pixel size, e.g. a 1200x628 banner | `z-image-spicy` ($0.015, up to 1536 px) or `z-image-spicy-pro` ($0.03, up to 2560 px) | Any width x height; text-to-image only, no reference images |
| **Transparent-background edit** — product cut-out, sticker, logo on alpha | `doubao-seedream-5-0-flash` + `--background transparent` | Pass one PNG that already has an alpha channel; the result keeps it. Pro supports this too |
| **Split an image into layers** — editable poster, text/subject/props separated | `doubao-seedream-5-0-flash` + `--layers` | One input image → base + up to 16 transparent PNG layers with names and positions. $0.03 per output image |
| Controlled edits, marked regions, multilingual text | `doubao-seedream-5-0-pro` ($0.03 1K / $0.06 2K) | Point at the region to change (box, arrow, hand-drawn mark); 1K/2K only, no 4K |
| Edit / restyle an existing image | any model above + `--image <url>` | Passing a reference switches the same model to edit mode |
| Fuse several references | `gpt-image-2` (up to 16) or `kling-multi-image` | |
| Enlarge / upscale a photo | `real-esrgan` ($0.004) | Pure upscaler, not a generator |
| Extend/outpaint a photo's canvas | `kling-expand` | |

**When the user has no preference and the prompt has no text in the image:**
default to `gpt-image-2`. It is the safest all-rounder here.

**Rules of thumb worth saying out loud:**
- Text in the image → Qwen Image 3.0. It is the one that reliably renders small type.
- 4K needed → `gpt-image-2` or `doubao-seedream-5-0-260128` (Seedream 5.0 Lite). Seedream 5.0 Pro and Flash stop at 2K; Qwen tops out at 2K.
- Layer splitting is billed per output image. Before running `--layers`, tell the user the cost depends on how many layers come back (base + up to 16, so at most $0.51).
- Nobody needs Pro tiers for drafts. Iterate cheap, render final expensive.
- On resolution x quality models, quality IS the price. Quote the exact cell from data/models.json (e.g. gpt-image-2.5 2K-high = $0.04) before rendering, and never raise quality without saying what it costs.

## Generating

```bash
# Text to image
node scripts/generate.mjs --model gpt-image-2 --prompt "a red bicycle on a wet street at night"

# Common options
#   --resolution 1K|2K|4K        (model-dependent; see data/models.json)
#   --aspect 1:1|16:9|9:16|4:3|3:4|3:2|2:3|21:9
#   --image <url>                reference image; repeat for several
#   --out ./picture.png          also download the result next to you
#   --quality low|medium|high…   price tier on resolution x quality models (gpt-image-2.5-*, grok-imagine-image-2.0)
#   --json                       machine-readable output

# Edit an existing image
node scripts/generate.mjs --model qwen3-image --image https://example.com/a.jpg \
  --prompt "keep the subject, change to soft evening light"

# Edit a PNG that has a transparent background and keep it transparent
node scripts/generate.mjs --model doubao-seedream-5-0-flash --image https://example.com/product.png \
  --background transparent --prompt "change the mug color to terracotta orange"

# Split one image into editable layers (base + up to 16 transparent PNGs, each with a name and position)
node scripts/generate.mjs --model doubao-seedream-5-0-flash --image https://example.com/poster.jpg --layers --json

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
