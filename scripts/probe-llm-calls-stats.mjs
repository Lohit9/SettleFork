/**
 * Phase 2 readiness probe — Item 2/3: per-feature input-token + latency stats
 * from production llm_calls.
 *
 * One-shot. Read-only. No production code modifications. Output is a
 * markdown table the architect uses to prioritize PR 13's caching plan.
 */
import { config } from 'dotenv'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'

config({ path: resolve(process.cwd(), '.env.local') })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(2)
}

const supabase = createClient(url, key)

// Pull the rows; aggregate in JS because Supabase JS doesn't expose
// PERCENTILE_CONT directly via PostgREST. Volume is small (a few thousand
// at most), so the cost is trivial.
const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
const { data, error } = await supabase
  .from('llm_calls')
  .select('feature, input_tokens, output_tokens, latency_ms, succeeded, created_at')
  .gte('created_at', since)
  .not('input_tokens', 'is', null)

if (error) {
  console.error('Query failed:', error.message)
  process.exit(2)
}

// Filter out eval_* features (per existing convention)
const rows = (data ?? []).filter(
  (r) => !((r.feature ?? '').startsWith('eval_')),
)

if (rows.length === 0) {
  console.log('No non-eval llm_calls rows in the last 30 days.')
  // Try all-time as fallback
  const { data: allTime } = await supabase
    .from('llm_calls')
    .select('feature, input_tokens, output_tokens, latency_ms, succeeded, created_at')
    .not('input_tokens', 'is', null)
  const allRows = (allTime ?? []).filter(
    (r) => !((r.feature ?? '').startsWith('eval_')),
  )
  console.log(`All-time non-eval rows: ${allRows.length}`)
  if (allRows.length === 0) {
    console.log('No data — production has no non-eval llm_calls rows yet.')
    process.exit(0)
  }
  rows.push(...allRows)
}

// Group by feature
const byFeature = new Map()
for (const r of rows) {
  const f = r.feature
  if (!byFeature.has(f)) byFeature.set(f, [])
  byFeature.get(f).push(r)
}

function pctile(arr, p) {
  if (arr.length === 0) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(Math.floor(p * sorted.length), sorted.length - 1)
  return sorted[idx]
}

function avg(arr) {
  if (arr.length === 0) return null
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

const summary = []
for (const [feature, entries] of byFeature.entries()) {
  const inTokens = entries.map((e) => e.input_tokens ?? 0)
  const outTokens = entries.map((e) => e.output_tokens ?? 0)
  const latency = entries.map((e) => e.latency_ms ?? 0)
  summary.push({
    feature,
    calls: entries.length,
    avg_input: Math.round(avg(inTokens) ?? 0),
    p50_input: pctile(inTokens, 0.5),
    p95_input: pctile(inTokens, 0.95),
    max_input: Math.max(...inTokens),
    avg_output: Math.round(avg(outTokens) ?? 0),
    avg_latency_ms: Math.round(avg(latency) ?? 0),
    p95_latency_ms: pctile(latency, 0.95),
    failures: entries.filter((e) => !e.succeeded).length,
  })
}

summary.sort((a, b) => b.calls - a.calls)

console.log(`\nQuery window: last 30 days (or all-time fallback)`)
console.log(`Total non-eval calls: ${rows.length}`)
console.log(`Distinct features: ${summary.length}\n`)
console.log('| Feature | Calls | Avg in | P50 in | P95 in | Max in | Avg out | Avg lat (ms) | P95 lat (ms) | Failures |')
console.log('|---|---|---|---|---|---|---|---|---|---|')
for (const s of summary) {
  console.log(
    `| \`${s.feature}\` | ${s.calls} | ${s.avg_input} | ${s.p50_input} | ${s.p95_input} | ${s.max_input} | ${s.avg_output} | ${s.avg_latency_ms} | ${s.p95_latency_ms} | ${s.failures} |`,
  )
}

console.log('')
process.exit(0)
