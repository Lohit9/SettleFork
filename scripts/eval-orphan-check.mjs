/**
 * One-shot helper to verify zero eval-synthetic orphans remain in the
 * production DB. Used during PR 10.4 verification; safe to keep as a
 * tool for ad-hoc checks.
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
const { data, error } = await supabase
  .from('projects')
  .select('id, name, created_at')
  .like('name', 'eval-synthetic-%')

if (error) {
  console.error('Query failed:', error.message)
  process.exit(2)
}

console.log(`Orphan eval-synthetic projects: ${data?.length ?? 0}`)
if (data && data.length > 0) {
  for (const r of data) {
    console.log(`  - ${r.name} (id=${r.id}, created_at=${r.created_at})`)
  }
  process.exit(1)
}
process.exit(0)
