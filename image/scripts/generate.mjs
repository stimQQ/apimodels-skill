#!/usr/bin/env node
/**
 * apimodels.app image generation — create, poll, deliver.
 *
 * Zero dependencies, Node 18+ (built-in fetch). Run `--help` for usage.
 *
 * Why a script instead of letting the agent call the API directly: three things
 * here are easy to get wrong and expensive when you do.
 *   1. This API answers HTTP 200 with a `code` field for some failures, so
 *      branching on res.ok reads a failure as a success.
 *   2. Generation is asynchronous. Polling too eagerly wastes calls; giving up
 *      too early makes a normal slow render look like a failure (some models
 *      have a long tail past 5 minutes).
 *   3. Result URLs expire after 7 days, so "just hand back the link" quietly
 *      produces dead links later.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'

const API = 'https://api.apimodels.app/v1/images/generations'
const CONSOLE_URL = 'https://apimodels.app/console/api-keys'

/**
 * Where a saved key lives when there is no environment to put one in.
 *
 * Claude Code has the user's shell, so `APIMODELS_API_KEY` in .zshrc is the good
 * path — the key never enters the conversation. The claude.ai / desktop sandbox
 * has neither shell nor a secrets mechanism (there is no per-skill credential
 * store today), so the only workable pattern is: ask once, save, reuse.
 */
const CRED_DIR = join(homedir(), '.apimodels')
const CRED_FILE = join(CRED_DIR, 'credentials')

// Poll pacing: quick at first (most images land inside 2 minutes), then back off
// so a genuinely slow model does not cost hundreds of requests.
const POLL_SCHEDULE_MS = [3000, 3000, 5000, 5000, 5000, 8000, 8000, 10000]
const POLL_TAIL_MS = 15000
// 10 minutes. Longer than any observed generation, including Qwen Pro's tail.
const MAX_WAIT_MS = 10 * 60 * 1000

function usage() {
  console.log(`
apimodels.app — image generation

  node scripts/generate.mjs --model <id> --prompt "<text>" [options]

Required
  --model <id>          Model id. MUST be one listed in data/models.json.
  --prompt "<text>"     What to generate (or how to edit, with --image).

Options
  --image <url>         Reference image URL. Repeat for multiple.
  --resolution <r>      1K | 2K | 4K (model-dependent).
  --aspect <a>          1:1 16:9 9:16 4:3 3:4 3:2 2:3 21:9  (or auto).
  --out <path>          Download the result to this path as well.
  --json                Print machine-readable JSON only.
  --check               Verify the API key and exit.
  --save-key            Read a key from stdin and save it (for sandboxes with no shell).
  --help

API key (first one found wins)
  APIMODELS_API_KEY env var         best — never enters the conversation
  ~/.apimodels/credentials          written by --save-key, mode 0600
  Get a key at ${CONSOLE_URL}

Notes
  Result URLs expire after 7 days — use --out if you need the file.
  Failed generations are never charged.
`)
}

function parseArgs(argv) {
  const o = { images: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--model') o.model = next()
    else if (a === '--prompt') o.prompt = next()
    else if (a === '--image') o.images.push(next())
    else if (a === '--resolution') o.resolution = next()
    else if (a === '--aspect' || a === '--aspect-ratio') o.aspect = next()
    else if (a === '--out') o.out = next()
    else if (a === '--json') o.json = true
    else if (a === '--check') o.check = true
    else if (a === '--save-key') o.saveKey = true
    else if (a === '--help' || a === '-h') o.help = true
    else return { error: `unknown argument: ${a}` }
  }
  return o
}

/** Everything the caller needs to say something true to the user. */
function fail(message, hint) {
  return { ok: false, message, hint: hint ?? null }
}

/**
 * Find the API key. Order matters:
 *   1. APIMODELS_API_KEY — the good path. Set in the user's shell, it never
 *      passes through the conversation and never lands in a transcript.
 *   2. ~/.apimodels/credentials — for sandboxes with no shell to inherit from.
 *
 * Deliberately NOT a `--key` flag: an argument shows up in the command the agent
 * prints, in process listings and in the chat transcript. If the key has to be
 * spoken once, it goes in via `--save-key` on stdin and is never echoed again.
 */
async function resolveKey() {
  const fromEnv = process.env.APIMODELS_API_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    const saved = (await readFile(CRED_FILE, 'utf8')).trim()
    if (saved) return saved
  } catch { /* no saved key — fall through */ }
  return null
}

/** Read the key from stdin and store it 0600. Never printed back. */
async function saveKey() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const key = Buffer.concat(chunks).toString('utf8').trim()
  if (!key) { console.error('nothing on stdin — pipe the key in, e.g. printf %s "$KEY" | node scripts/generate.mjs --save-key'); return 2 }
  if (!/^sk_[A-Za-z0-9]{16,}$/.test(key)) {
    console.error('that does not look like an apimodels key (expected sk_… ). Nothing was saved.')
    return 2
  }
  await mkdir(CRED_DIR, { recursive: true })
  await writeFile(CRED_FILE, key + '\n', { mode: 0o600 })
  await chmod(CRED_FILE, 0o600).catch(() => {})
  // Only ever show the tail, so a screenshot or transcript cannot leak the key.
  console.log(`✓ saved to ${CRED_FILE} (…${key.slice(-4)}), readable only by you.`)
  return 0
}

const NO_KEY_HINT =
  `No API key found.\n` +
  `  Get one at ${CONSOLE_URL} (free to create), then either:\n` +
  `    • export APIMODELS_API_KEY=sk_...        ← best; add it to ~/.zshrc to persist\n` +
  `    • printf %s "sk_..." | node scripts/generate.mjs --save-key   ← for sandboxes with no shell`

async function call(url, init, key) {
  let res
  try {
    res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(60000),
    })
  } catch (e) {
    return fail(`network error talking to apimodels.app: ${e.message}`)
  }
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return fail(`unexpected non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }
  // The status line is not the whole truth here — a 200 can carry code 4xx.
  const code = typeof body?.code === 'number' ? body.code : res.status
  if (code === 401) return fail('API key rejected (401).', `Re-copy the key from ${CONSOLE_URL} and set APIMODELS_API_KEY.`)
  if (code === 402) return fail('Not enough balance (402).', 'Top up at https://apimodels.app/console/credits — failed calls are not charged.')
  if (code !== 200) return fail(`${body?.msg || 'request failed'} (code ${code})`)
  return { ok: true, data: body.data }
}

/** Human-readable reason out of a finished-but-failed task. */
function describeFailure(d) {
  const code = d?.failCode || ''
  const msg = d?.failMsg || d?.error || 'generation failed'
  if (/CONTENT_MODERATION|moderation|审核/i.test(code + msg)) {
    return fail(`Refused by the content safety review: ${msg}`, 'Reword the prompt or change the reference image — retrying the same input will not help. Not charged.')
  }
  if (/UPSTREAM_BUSY|busy/i.test(code + msg)) {
    return fail(`The model is busy right now: ${msg}`, 'Retry in a moment or pick another model. Not charged.')
  }
  if (/TIMEOUT/i.test(code + msg)) {
    return fail(`The upstream took too long: ${msg}`, 'Retry, or try a faster model. Not charged.')
  }
  return fail(msg, 'Not charged. Retry or try a different model.')
}

async function poll(taskId, key, onTick) {
  const started = Date.now()
  for (let i = 0; ; i++) {
    const wait = POLL_SCHEDULE_MS[i] ?? POLL_TAIL_MS
    await new Promise((r) => setTimeout(r, wait))
    const elapsed = Date.now() - started
    if (elapsed > MAX_WAIT_MS) {
      return fail(`still running after ${Math.round(elapsed / 1000)}s — gave up waiting.`,
        `The task may still finish. Check it with: node scripts/generate.mjs --status ${taskId}`)
    }
    const r = await call(`${API}?task_id=${encodeURIComponent(taskId)}`, { method: 'GET' }, key)
    if (!r.ok) return r
    const d = r.data
    const state = d?.state
    if (state === 'completed') {
      const urls = d?.resultUrls ?? []
      if (!urls.length) return fail('the task reported success but returned no image URL.')
      return { ok: true, urls, seconds: Math.round(elapsed / 1000) }
    }
    if (state === 'failed') return describeFailure(d)
    onTick?.(Math.round(elapsed / 1000))
  }
}

async function download(url, out) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const { writeFile } = await import('node:fs/promises')
  await writeFile(out, buf)
  return buf.length
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.error) { console.error(args.error); usage(); process.exit(2) }
  if (args.help) { usage(); process.exit(0) }

  if (args.saveKey) process.exit(await saveKey())

  const key = await resolveKey()
  if (!key) { console.error(NO_KEY_HINT); process.exit(2) }

  if (args.check) {
    const r = await call('https://api.apimodels.app/v1/balance', { method: 'GET' }, key)
    if (!r.ok) { console.error(`✗ ${r.message}${r.hint ? `\n  ${r.hint}` : ''}`); process.exit(1) }
    console.log(`✓ key works. Balance: $${r.data?.balance ?? r.data?.credits ?? '?'}`)
    process.exit(0)
  }

  if (!args.model) { console.error('--model is required. Pick one from data/models.json.'); process.exit(2) }
  if (!args.prompt) { console.error('--prompt is required.'); process.exit(2) }

  const body = { model: args.model, prompt: args.prompt }
  if (args.resolution) body.resolution = args.resolution
  if (args.aspect) body.aspect_ratio = args.aspect
  if (args.images.length) body.image_urls = args.images

  if (!args.json) {
    const mode = args.images.length ? `editing with ${args.images.length} reference image(s)` : 'generating'
    console.log(`▸ ${args.model}: ${mode}…`)
  }

  const created = await call(API, { method: 'POST', body: JSON.stringify(body) }, key)
  if (!created.ok) {
    if (args.json) console.log(JSON.stringify({ ok: false, error: created.message, hint: created.hint }))
    else console.error(`✗ ${created.message}${created.hint ? `\n  ${created.hint}` : ''}`)
    process.exit(1)
  }

  const taskId = created.data?.taskId
  if (!taskId) {
    console.error('✗ the API accepted the request but returned no task id.')
    process.exit(1)
  }

  const result = await poll(taskId, key, (s) => {
    if (!args.json && s % 15 === 0) console.log(`  … still running (${s}s)`)
  })
  if (!result.ok) {
    if (args.json) console.log(JSON.stringify({ ok: false, taskId, error: result.message, hint: result.hint }))
    else console.error(`✗ ${result.message}${result.hint ? `\n  ${result.hint}` : ''}`)
    process.exit(1)
  }

  let saved = null
  if (args.out) {
    try {
      const bytes = await download(result.urls[0], args.out)
      saved = { path: args.out, bytes }
    } catch (e) {
      // The image exists and is paid for — a failed local save must not read as
      // a failed generation.
      if (!args.json) console.error(`  (could not save locally: ${e.message} — the URL below still works)`)
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: true, taskId, urls: result.urls, seconds: result.seconds, saved }))
  } else {
    console.log(`✓ done in ${result.seconds}s`)
    for (const u of result.urls) console.log(`  ${u}`)
    if (saved) console.log(`  saved → ${saved.path} (${(saved.bytes / 1024).toFixed(0)} KB)`)
    console.log('  note: these URLs expire after 7 days.')
  }
}

main().catch((e) => { console.error(`✗ ${e?.message ?? e}`); process.exit(1) })
