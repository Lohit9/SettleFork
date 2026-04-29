'use server'

/**
 * Server action for the lead-capture form on the /migrate/[slug]
 * programmatic SEO pages (components/migrate/LeadCaptureForm.tsx).
 *
 * This replaces the previous browser-direct
 * `supabase.from('migration_leads').insert(...)` path, which exposed
 * the public anon key as the write boundary on a public form. Inserts
 * now go through `supabaseAdmin` (service role, bypasses RLS) gated by
 * Cloudflare Turnstile, mirroring the access-request flow in
 * `submitAccessRequest`.
 *
 * Column set written here matches the existing `migration_leads`
 * schema (migrations 037 + 038). The notify-route fan-out preserves
 * the existing payload shape used by the browser form so the email
 * route's contract is unchanged.
 */

import { supabaseAdmin } from '@/lib/supabase/admin'
import { verifyTurnstileToken } from '@/lib/auth/turnstile'
import { getRequestIp } from '@/lib/utils/request-ip'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://usesettle.ai'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface SubmitMigrationLeadPayload {
  email: string
  company: string
  slug: string
  sourceSystem: string
  targetSystem: string
  /** Optional context fields collected by the form; preserved in the
   * existing migration_leads schema and surfaced in the admin email. */
  timeline?: string
  volume?: string
  notes?: string
  turnstileToken: string
}

export type SubmitMigrationLeadResult =
  | { success: true }
  | { success: false; error: string }

export async function submitMigrationLead(
  payload: SubmitMigrationLeadPayload,
): Promise<SubmitMigrationLeadResult> {
  // a. Manual validation — same checks the client form uses today, plus
  // server-side guards on the slug/source/target so a direct API call
  // can't write a malformed lead row.
  const email = payload.email?.trim() ?? ''
  const company = payload.company?.trim() ?? ''
  const slug = payload.slug?.trim() ?? ''
  const sourceSystem = payload.sourceSystem?.trim() ?? ''
  const targetSystem = payload.targetSystem?.trim() ?? ''

  if (!company) {
    return { success: false, error: 'Please enter your company name.' }
  }
  if (!email || !EMAIL_REGEX.test(email)) {
    return { success: false, error: 'Please enter a valid work email address.' }
  }
  if (!slug || !sourceSystem || !targetSystem) {
    return { success: false, error: 'Missing migration context. Please refresh and try again.' }
  }

  // b. Resolve client IP for the optional remoteip param.
  const ip = await getRequestIp()

  // c. Cloudflare Turnstile gate. Dev/local with TURNSTILE_SECRET_KEY
  // unset is bypassed inside the verifier.
  const verify = await verifyTurnstileToken(payload.turnstileToken, ip)
  if (!verify.ok) {
    console.warn('[turnstile] migration-lead rejected', {
      reason: verify.reason,
      errorCodes: verify.errorCodes,
    })
    return { success: false, error: 'Verification failed. Please try again.' }
  }

  // d. Insert. Column set matches migrations 037 + 038 (`notes` was
  // added in 038). Empty optional fields are stored as NULL to match
  // the prior browser-insert behavior.
  const timeline = payload.timeline?.trim() || null
  const volume = payload.volume?.trim() || null
  const notes = payload.notes?.trim() || null

  const { error: dbError } = await supabaseAdmin.from('migration_leads').insert({
    company_name: company || null,
    email,
    source_system: sourceSystem,
    target_system: targetSystem,
    timeline,
    volume,
    notes,
    page_slug: slug,
  })

  if (dbError) {
    console.error('[migration-leads] insert failed:', dbError)
    return { success: false, error: 'Something went wrong. Please try again.' }
  }

  // e. Notify fan-out — preserves the exact payload shape the browser
  // form sent before this refactor (ref: 'assessment', additional_notes
  // composed from timeline/volume/notes). Failures are non-blocking;
  // the DB row is the source of truth.
  const additionalNotes = [
    timeline ? `Timeline: ${timeline}` : '',
    volume ? `Data volume: ${volume}` : '',
    notes ?? '',
  ]
    .filter(Boolean)
    .join(' | ')

  try {
    await fetch(`${APP_URL}/api/notify-access-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '',
        email,
        company,
        role_type: '',
        systems_involved: `${sourceSystem} → ${targetSystem}`,
        additional_notes: additionalNotes,
        ref: 'assessment',
      }),
    })
  } catch (err) {
    console.error('[migration-leads] notify fetch failed (non-blocking):', err)
  }

  return { success: true }
}
