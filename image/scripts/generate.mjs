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
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'

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
  --background transparent
                        Keep a transparent background (PNG with alpha). Edit mode only:
                        pass exactly one --image that is a PNG with an alpha channel.
                        Seedream 5.0 Flash and Pro only.
  --layers              Split ONE --image into a base plus up to 16 transparent PNG layers
                        (text, subjects, props), each with a name and position. --prompt is
                        optional here. Billed per output image. doubao-seedream-5-0-flash only.
  --out <path>          Download the result to this path as well.
  --json                Print machine-readable JSON only.
  --check               Verify the API key and exit.
  --login               One-click browser authorization — no key ever typed anywhere.
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
    else if (a === '--background') o.background = next()
    else if (a === '--layers') o.layers = true
    else if (a === '--out') o.out = next()
    else if (a === '--json') o.json = true
    else if (a === '--check') o.check = true
    else if (a === '--save-key') o.saveKey = true
    else if (a === '--login') o.login = true
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

/**
 * One-click browser authorization (RFC 8252 loopback):
 *   1. listen on a random 127.0.0.1 port, mint a `state` nonce;
 *   2. hand the user https://apimodels.app/cli-auth?port=..&state=.. — they log
 *      in (if needed) and click ONE button;
 *   3. the browser full-page-redirects to our /callback with a single-use,
 *      10-minute code (no CORS involved — it's a navigation, not a fetch);
 *   4. we exchange the code over HTTPS for a freshly-minted key and save it.
 * The key never touches the conversation, the shell history or the URL bar —
 * only the throwaway code transits the browser.
 */
async function login() {
  const state = randomBytes(16).toString('base64url')
  let settle
  const done = new Promise((resolve) => { settle = resolve })

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return }
    const page = (title, body) =>
      `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh"><div style="text-align:center"><h2>${title}</h2><p style="color:#999">${body}</p></div>`
    if (u.searchParams.get('state') !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page('State mismatch', 'This link belongs to a different login attempt. Close this tab and re-run --login.'))
      return
    }
    const code = u.searchParams.get('code') ?? ''
    try {
      const r = await fetch('https://apimodels.app/api/cli-auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(30000),
      })
      const data = await r.json().catch(() => null)
      const key = data?.data?.apiKey
      if (!r.ok || !key) throw new Error(data?.msg || `exchange failed (HTTP ${r.status})`)
      await mkdir(CRED_DIR, { recursive: true })
      await writeFile(CRED_FILE, key + '\n', { mode: 0o600 })
      await chmod(CRED_FILE, 0o600).catch(() => {})
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page('✓ Connected', `Key “${data?.data?.name ?? 'CLI'}” is configured on this machine. You can close this tab and go back to your agent.`))
      settle({ ok: true, tail: key.slice(-4), name: data?.data?.name })
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page('Authorization failed', `${e.message}. Close this tab and re-run --login.`))
      settle({ ok: false, error: e.message })
    }
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const url = `https://apimodels.app/cli-auth?port=${port}&state=${state}`

  console.log('Open this link, log in if asked, and click “Authorize”:')
  console.log(`\n  ${url}\n`)
  console.log('Waiting for the browser… (10 minutes; Ctrl-C to abort)')
  // Best-effort auto-open; harmless if there is no GUI.
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  execFile(opener, [url], () => {})

  const timeout = setTimeout(() => settle({ ok: false, error: 'timed out after 10 minutes' }), 10 * 60 * 1000)
  const result = await done
  clearTimeout(timeout)
  server.close()
  if (result.ok) {
    console.log(`✓ saved to ${CRED_FILE} (…${result.tail}), readable only by you. Key name: ${result.name}`)
    return 0
  }
  console.error(`✗ ${result.error}`)
  return 2
}

const NO_KEY_HINT =
  `No API key found.\n` +
  `  Easiest: node scripts/generate.mjs --login   ← one browser click, nothing to type\n` +
  `  Or get one at ${CONSOLE_URL} and either:\n` +
  `    • export APIMODELS_API_KEY=sk_...        ← add it to ~/.zshrc to persist\n` +
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
      // Layer splitting returns one URL per layer plus per-layer metadata in
      // resultJson.layers (name, z_index, bounding_box). resultJson arrives as a
      // JSON string on this endpoint.
      let layers = null
      try {
        const rj = typeof d?.resultJson === 'string' ? JSON.parse(d.resultJson) : d?.resultJson
        if (Array.isArray(rj?.layers)) layers = rj.layers
      } catch { /* no layer metadata */ }
      return { ok: true, urls, layers, seconds: Math.round(elapsed / 1000) }
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
  if (args.login) process.exit(await login())

  const key = await resolveKey()
  if (!key) { console.error(NO_KEY_HINT); process.exit(2) }

  if (args.check) {
    const r = await call('https://api.apimodels.app/v1/balance', { method: 'GET' }, key)
    if (!r.ok) { console.error(`✗ ${r.message}${r.hint ? `\n  ${r.hint}` : ''}`); process.exit(1) }
    console.log(`✓ key works. Balance: $${r.data?.balance ?? r.data?.credits ?? '?'}`)
    process.exit(0)
  }

  if (!args.model) { console.error('--model is required. Pick one from data/models.json.'); process.exit(2) }
  if (!args.prompt && !args.layers) { console.error('--prompt is required.'); process.exit(2) }
  if (args.layers && args.images.length !== 1) { console.error('--layers needs exactly one --image to split.'); process.exit(2) }
  if (args.background && args.images.length !== 1) { console.error('--background transparent needs exactly one --image (a PNG with alpha).'); process.exit(2) }

  const body = { model: args.model }
  if (args.prompt) body.prompt = args.prompt
  if (args.resolution) body.resolution = args.resolution
  if (args.aspect) body.aspect_ratio = args.aspect
  if (args.images.length) body.image_urls = args.images
  if (args.background) body.background = args.background
  if (args.layers) body.layer_decomposition = true

  if (!args.json) {
    const mode = args.layers ? 'splitting the image into layers'
      : args.images.length ? `editing with ${args.images.length} reference image(s)` : 'generating'
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
    console.log(JSON.stringify({ ok: true, taskId, urls: result.urls, ...(result.layers ? { layers: result.layers } : {}), seconds: result.seconds, saved }))
  } else {
    console.log(`✓ done in ${result.seconds}s`)
    if (result.layers) {
      // One line per layer: index 0 is the flattened base, 1..N the layers in stacking order.
      result.urls.forEach((u, i) => {
        const l = result.layers[i] ?? {}
        const b = l.bounding_box
        const box = b ? `  box=${JSON.stringify(b)}` : ''
        console.log(`  [${i}] ${l.name ?? (i === 0 ? 'base' : 'layer')}${box}\n      ${u}`)
      })
      console.log(`  ${result.urls.length} images, billed per image. Layer names come from the model and may be in Chinese.`)
    } else {
      for (const u of result.urls) console.log(`  ${u}`)
    }
    if (saved) console.log(`  saved → ${saved.path} (${(saved.bytes / 1024).toFixed(0)} KB)`)
    console.log('  note: these URLs expire after 7 days.')
  }
}

main().catch((e) => { console.error(`✗ ${e?.message ?? e}`); process.exit(1) })
