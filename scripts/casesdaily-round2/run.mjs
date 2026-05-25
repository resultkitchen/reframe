#!/usr/bin/env node
/**
 * CasesDaily Dashboard Round-2 — parallel Gemini 3.1 Pro task runner.
 *
 * Reads tasks/*.json, fans out one Gemini call per task, writes each
 * model output to STAGING/<task>/ for human review before merging.
 *
 * Usage:
 *   GOOGLE_API_KEY=... node run.mjs               # run all tasks
 *   GOOGLE_API_KEY=... node run.mjs <taskId>...   # run a subset
 */
import { GoogleGenAI } from '@google/genai'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = join(__dirname, 'tasks')
const STAGING = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'should-i-fight-all-tasks',
  '.gemini-staging',
  'round2'
)
const REPO = resolve(__dirname, '..', '..', '..', 'should-i-fight-all-tasks')
const RAILWAY = resolve(__dirname, '..', '..', '..', 'casesdaily-dashboard')

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview'
const API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY
if (!API_KEY) {
  console.error('Missing GOOGLE_API_KEY / GEMINI_API_KEY')
  process.exit(1)
}

const ai = new GoogleGenAI({ apiKey: API_KEY })

// Snapshot of the live public schema, captured 2026-05-20 via
// information_schema.columns. Injected into every prompt so model cannot
// hallucinate column names. Refresh by re-running the snapshot script.
const SCHEMA_PATH = join(__dirname, 'schema-snapshot.md')
const SCHEMA_SNAPSHOT = existsSync(SCHEMA_PATH)
  ? readFileSync(SCHEMA_PATH, 'utf8')
  : ''

function readContext(spec) {
  const parts = []
  if (SCHEMA_SNAPSHOT && spec.includeSchema !== false) {
    parts.push(`### LIVE DB SCHEMA (ground truth — do NOT assume columns not listed here)\n${SCHEMA_SNAPSHOT}`)
  }
  for (const f of spec.contextFiles || []) {
    const base = f.from === 'railway' ? RAILWAY : REPO
    const full = join(base, f.path)
    if (!existsSync(full)) {
      parts.push(`/* MISSING: ${f.path} */`)
      continue
    }
    let body = readFileSync(full, 'utf8')
    if (f.lineRange) {
      const [a, b] = f.lineRange
      body = body.split('\n').slice(a - 1, b).join('\n')
    }
    if (f.maxBytes && body.length > f.maxBytes) {
      body = body.slice(0, f.maxBytes) + '\n/* TRUNCATED */'
    }
    parts.push(`### FILE: ${f.path}${f.lineRange ? ` (lines ${f.lineRange[0]}-${f.lineRange[1]})` : ''}\n\`\`\`\n${body}\n\`\`\``)
  }
  return parts.join('\n\n')
}

async function runTask(spec) {
  const t0 = Date.now()
  const context = readContext(spec)
  const prompt = [
    `# TASK: ${spec.id} — ${spec.title}`,
    '',
    spec.brief,
    '',
    '## Context',
    context,
    '',
    '## Output contract',
    spec.outputContract,
    '',
    'Return ONLY the deliverable described in Output contract. No prose, no explanations outside the deliverable itself.',
  ].join('\n')

  console.log(`[${spec.id}] dispatching to ${MODEL} (${prompt.length} chars)`)
  try {
    const res = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    })
    let text = ''
    if (typeof res.text === 'string') text = res.text
    else if (typeof res.text === 'function') text = String(res.text() ?? '')
    else text = (res.candidates?.[0]?.content?.parts || []).map((p) => p?.text ?? '').join('')

    const outDir = join(STAGING, spec.id)
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'prompt.md'), prompt, 'utf8')
    writeFileSync(join(outDir, 'output.md'), text, 'utf8')
    if (spec.extractFiles) extractFiles(text, outDir)
    console.log(`[${spec.id}] DONE in ${Date.now() - t0}ms (${text.length} chars)`)
    return { id: spec.id, ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[${spec.id}] FAILED: ${msg}`)
    return { id: spec.id, ok: false, error: msg }
  }
}

// Extract fenced code blocks that start with `// FILE: <path>` into separate files.
function extractFiles(text, outDir) {
  const re = /```(?:[a-zA-Z]+)?\n\/\/ FILE: ([^\n]+)\n([\s\S]*?)```/g
  let m
  let n = 0
  while ((m = re.exec(text)) !== null) {
    const rel = m[1].trim()
    const body = m[2]
    const dest = join(outDir, 'files', rel)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, body, 'utf8')
    n++
  }
  if (n > 0) console.log(`  ↳ extracted ${n} file(s)`)
}

const all = readdirSync(TASKS_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(TASKS_DIR, f), 'utf8')))

const filter = process.argv.slice(2)
const tasks = filter.length ? all.filter((t) => filter.includes(t.id)) : all
if (!tasks.length) {
  console.error('No tasks matched.')
  process.exit(1)
}

console.log(`Running ${tasks.length} task(s) in parallel against ${MODEL}\n`)
const results = await Promise.all(tasks.map(runTask))
const fail = results.filter((r) => !r.ok)
console.log(`\nDONE. ${results.length - fail.length}/${results.length} ok. Staging: ${STAGING}`)
if (fail.length) {
  console.log('Failures:', fail)
  process.exit(2)
}
