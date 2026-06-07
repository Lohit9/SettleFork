/**
 * Approve-path smoke test.
 *
 * Catches the failure class that broke the Jun-5 Rootstock demo: a project left
 * in `maintenance_mode` silently blocks every approve (assertMappingWritesEnabled
 * throws MAINTENANCE_MODE) with no visible signal, so the UI looks broken.
 *
 * Read-only by default (CI/cron safe). Set SMOKE_PROJECT_ID to also run a live
 * approve round-trip (flip one mapping needs_review → approved → revert) against
 * a throwaway project, proving the write path itself is open.
 *
 *   npm run smoke:approve                           # health checks (read-only)
 *   SMOKE_PROJECT_ID=<uuid> npm run smoke:approve   # + live round-trip
 *
 * Exit 0 = approve path healthy, 1 = a check failed.
 *
 * Note: this is a DB-level smoke test — it queries the same `projects.maintenance_mode`
 * the server guard reads, but does not exercise the full server action (auth, sibling
 * fan-out). A browser-level E2E (Playwright) is the follow-up for that depth.
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.local' })

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}
const db = createClient(URL, KEY)

const failures: string[] = []
const fail = (m: string) => { failures.push(m); console.error(`  ✗ ${m}`) }
const pass = (m: string) => console.log(`  ✓ ${m}`)

// 1. The Jun-5 failure: an ACTIVE project frozen in maintenance_mode blocks every
//    approve. A frozen *archived* project is fine; a frozen *active* one is the bug.
async function checkNoActiveProjectFrozen() {
  console.log('1. No active project stuck in maintenance_mode (the Jun-5 failure)')
  const { data, error } = await db
    .from('projects')
    .select('id, name')
    .eq('status', 'active')
    .eq('maintenance_mode', true)
  if (error) return fail(`projects query failed: ${error.message}`)
  if (data.length) {
    for (const p of data) fail(`ACTIVE project "${p.name}" (${p.id}) is FROZEN — approve is blocked there`)
  } else {
    pass('no active project is frozen')
  }
}

// 2. Approve is reachable: at least one active project has needs_review mappings to act on.
async function checkApproveReachable() {
  console.log('2. Approve has targets (active projects with needs_review mappings)')
  const { data: active, error: pErr } = await db.from('projects').select('id').eq('status', 'active')
  if (pErr) return fail(`projects query failed: ${pErr.message}`)
  const ids = (active ?? []).map((p) => p.id)
  if (!ids.length) return fail('no active projects exist')
  const { count, error } = await db
    .from('target_field_mappings')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'needs_review')
    .in('project_id', ids)
  if (error) return fail(`mappings query failed: ${error.message}`)
  if (!count) console.warn('  ⚠ no active project has needs_review mappings (nothing to approve — confirm expected)')
  else pass(`${count} approvable mappings across active projects`)
}

// 3. Optional live round-trip: prove the write path is open end-to-end (gated to a
//    designated throwaway project so a CI run never mutates a real migration).
async function roundTrip(projectId: string) {
  console.log(`3. Live approve round-trip on project ${projectId}`)
  const { data: rows, error } = await db
    .from('target_field_mappings')
    .select('id, status')
    .eq('project_id', projectId)
    .eq('status', 'needs_review')
    .eq('is_acknowledged', false)
    .limit(1)
  if (error) return fail(`fetch failed: ${error.message}`)
  if (!rows?.length) return fail(`no needs_review mapping in ${projectId} to round-trip`)
  const tfmId = rows[0].id
  try {
    const { error: upErr } = await db.from('target_field_mappings').update({ status: 'approved' }).eq('id', tfmId)
    if (upErr) return fail(`approve write failed (writes blocked?): ${upErr.message}`)
    const { data: after } = await db.from('target_field_mappings').select('status').eq('id', tfmId).single()
    if (after?.status === 'approved') pass(`approve wrote through (tfm ${tfmId})`)
    else fail(`status did not flip to approved (got "${after?.status}")`)
  } finally {
    await db.from('target_field_mappings').update({ status: 'needs_review' }).eq('id', tfmId)
    pass('reverted to needs_review')
  }
}

async function main() {
  console.log('— approve smoke test —')
  await checkNoActiveProjectFrozen()
  await checkApproveReachable()
  const smokeProject = process.env.SMOKE_PROJECT_ID
  if (smokeProject) await roundTrip(smokeProject)
  else console.log('3. Live round-trip skipped (set SMOKE_PROJECT_ID to enable)')

  console.log('')
  if (failures.length) {
    console.error(`FAILED — ${failures.length} check(s) failed. Approve may be blocked.`)
    process.exit(1)
  }
  console.log('PASSED — approve path healthy.')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
