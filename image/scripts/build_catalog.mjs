#!/usr/bin/env node
/**
 * Check data/models.json against what the image endpoint actually accepts.
 *
 * Why this exists: SKILL.md forbids the agent from inventing model names, which
 * only helps if the catalog it reads is current. A hand-maintained list goes
 * stale silently — a model is retired, the agent keeps offering it, the user gets
 * a 400 they cannot act on.
 *
 * ── Where the truth lives ────────────────────────────────────────────────────
 * NOT /api/v1/models. That endpoint enumerates database model names, and several
 * image models are reachable under a public alias that differs from the database
 * name — `grok-imagine-image` and `kling-v3-image` are both callable but absent
 * from /api/v1/models. Building the catalog from it would have silently dropped
 * two working models.
 *
 * Instead we ask the image endpoint itself: send a model name that cannot exist
 * and it answers 400 with the full list of names it accepts. That is the same
 * list the router validates against, so it cannot drift from reality. It costs
 * nothing — validation happens long before any generation is billed.
 *
 * What this script deliberately will NOT do: invent capabilities. A newly
 * accepted name is reported for a human to classify, never auto-added — the
 * endpoint's list mixes image models with a couple of video ones (`kling-v3`,
 * `kling-v3-omni` are per-second video), and guessing wrong means the agent
 * routes an image request at a video model.
 *
 *   node scripts/build_catalog.mjs            # report drift, write nothing
 *   node scripts/build_catalog.mjs --write    # drop models the API no longer accepts
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CATALOG = join(HERE, '..', 'data', 'models.json')
const API = 'https://api.apimodels.app/v1/images/generations'

/** Video models that the image endpoint accepts but which must never be offered
 *  as image models (they bill per second of output). */
const NOT_IMAGES = new Set(['kling-v3', 'kling-v3-omni', 'kling-v2'])

const write = process.argv.includes('--write')
const key = process.env.APIMODELS_API_KEY
if (!key) {
  console.error('APIMODELS_API_KEY is not set — needed to reach the endpoint (no generation is billed).')
  process.exit(2)
}

const catalog = JSON.parse(await readFile(CATALOG, 'utf8'))
const known = new Set(catalog.models.map((m) => m.model))

// A name with characters no real model uses, so this can never accidentally hit.
const res = await fetch(API, {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: '__catalog_probe__', prompt: 'probe' }),
  signal: AbortSignal.timeout(30000),
})
const body = await res.json().catch(() => null)
const msg = body?.msg ?? ''
const m = msg.match(/Supported models:\s*(.+)$/)
if (!m) {
  console.error('✗ could not read the supported-model list from the endpoint.')
  console.error(`  got: ${msg.slice(0, 200) || JSON.stringify(body).slice(0, 200)}`)
  console.error('  (the error format may have changed — check before trusting this catalog)')
  process.exit(1)
}
const accepted = m[1].split(',').map((s) => s.trim()).filter(Boolean)
const acceptedSet = new Set(accepted)

console.log(`endpoint accepts ${accepted.length} model names; catalog has ${catalog.models.length}`)

const retired = catalog.models.filter((x) => !acceptedSet.has(x.model))
if (retired.length) {
  console.log(`\n⚠️  in the catalog but NO LONGER accepted (${retired.length}) — these must go:`)
  for (const x of retired) console.log(`   ${x.model}`)
} else {
  console.log('✓ every catalogued model is still accepted')
}

const newNames = accepted.filter((id) => !known.has(id) && !NOT_IMAGES.has(id))
if (newNames.length) {
  console.log(`\nℹ️  accepted but not in the catalog (${newNames.length}) — classify by hand before adding:`)
  for (const id of newNames) console.log(`   ${id}`)
  console.log('   (aliases and channel-specific variants belong here too; add only real image models,')
  console.log('    each with its price and doc link, so the agent never quotes a price it made up.)')
}

if (!write) {
  console.log('\n(dry run — pass --write to drop retired models)')
  process.exit(retired.length ? 1 : 0)
}
if (!retired.length) { console.log('\nnothing to write'); process.exit(0) }

catalog.models = catalog.models.filter((x) => acceptedSet.has(x.model))
catalog.count = catalog.models.length
await writeFile(CATALOG, JSON.stringify(catalog, null, 2) + '\n')
console.log(`\n✓ wrote ${CATALOG} — removed ${retired.length}`)
