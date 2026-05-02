/**
 * One-shot helper to inspect the most recent `eval_mapping` rows in
 * llm_calls. Used during PR 10.4 verification to confirm the
 * featureOverride flow is wiring correctly. Safe to keep as an ad-hoc
 * tool.
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
const since = new Date(Date.now() - 30 * 60 * 1000).toISOString() // 30 min
const { data, error } = await supabase
  .from('llm_calls')
  .select('id, feature, model, cost_usd, succeeded, created_at, project_id')
  .gte('created_at', since)
  .order('created_at', { ascending: false })
  .limit(10)

if (error) {
  console.error('Query failed:', error.message)
  process.exit(2)
}

console.log(`Recent llm_calls (last 30min): ${data?.length ?? 0}`)
for (const r of data ?? []) {
  console.log(
    `  - ${r.created_at} | feature=${r.feature} | cost=$${Number(r.cost_usd ?? 0).toFixed(4)} | succeeded=${r.succeeded} | project=${String(r.project_id).slice(0, 8)}`,
  )
}
