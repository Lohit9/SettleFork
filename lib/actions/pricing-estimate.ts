'use server'

/**
 * Server action for the pricing estimator's lead-capture step
 * (components/pricing/PricingEstimator.tsx).
 *
 * Replaces the previous browser-direct
 * `supabase.from('pricing_leads').insert(...)` path, which exposed the
 * public anon key as the write boundary on a public form. Inserts now
 * go through `supabaseAdmin` (service role, bypasses RLS) gated by
 * Cloudflare Turnstile, mirroring `submitMigrationLead` and
 * `submitAccessRequest`.
 *
 * Column set written here matches the live `pricing_leads` schema
 * documented in `scripts/sql/create-pricing-leads.sql`. The notify-route
 * fan-out preserves the exact payload shape the browser form was sending
 * to `/api/notify-pricing-estimate`, so the email contract is unchanged.
 */

import { supabaseAdmin } from '@/lib/supabase/admin'
import { verifyTurnstileToken } from '@/lib/auth/turnstile'
import { getRequestIp } from '@/lib/utils/request-ip'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://usesettle.ai'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface SubmitPricingEstimatePayload {
  name: string
  email: string
  company: string
  /** Optional — `pricing_leads.role` is nullable. */
  role?: string
  systemType: string
  sourceSystemCount: string
  tableCountRange: string
  timeline: string
  computedTier: string
  priceRangeShown: string
  turnstileToken: string
}

export type SubmitPricingEstimateResult =
  | { success: true }
  | { success: false; error: string }

export async function submitPricingEstimate(
  payload: SubmitPricingEstimatePayload,
): Promise<SubmitPricingEstimateResult> {
  // a. Manual validation — same checks the client form runs today, plus
  // server-side guards on the question-step values so a direct API call
  // can't write a malformed lead row. The pricing_leads table marks
  // every column except `role` NOT NULL.
  const name = payload.name?.trim() ?? ''
  const email = payload.email?.trim().toLowerCase() ?? ''
  const company = payload.company?.trim() ?? ''
  const role = payload.role?.trim() ?? ''
  const systemType = payload.systemType?.trim() ?? ''
  const sourceSystemCount = payload.sourceSystemCount?.trim() ?? ''
  const tableCountRange = payload.tableCountRange?.trim() ?? ''
  const timeline = payload.timeline?.trim() ?? ''
  const computedTier = payload.computedTier?.trim() ?? ''
  const priceRangeShown = payload.priceRangeShown?.trim() ?? ''

  if (!name || !company) {
    return { success: false, error: 'Please fill in all required fields.' }
  }
  if (!email || !EMAIL_REGEX.test(email)) {
    return { success: false, error: 'Please enter a valid work email.' }
  }
  if (
    !systemType ||
    !sourceSystemCount ||
    !tableCountRange ||
    !timeline ||
    !computedTier ||
    !priceRangeShown
  ) {
    return {
      success: false,
      error: 'Missing estimator answers. Please refresh and try again.',
    }
  }

  // b. Resolve client IP for the optional remoteip param.
  const ip = await getRequestIp()

  // c. Cloudflare Turnstile gate. Dev/local with TURNSTILE_SECRET_KEY
  // unset is bypassed inside the verifier.
  const verify = await verifyTurnstileToken(payload.turnstileToken, ip)
  if (!verify.ok) {
    console.warn('[turnstile] pricing-estimate rejected', {
      reason: verify.reason,
      errorCodes: verify.errorCodes,
    })
    return { success: false, error: 'Verification failed. Please try again.' }
  }

  // d. Insert. Column set matches `scripts/sql/create-pricing-leads.sql`.
  const { error: dbError } = await supabaseAdmin.from('pricing_leads').insert({
    name,
    email,
    company,
    role: role || null,
    system_type: systemType,
    source_system_count: sourceSystemCount,
    table_count_range: tableCountRange,
    timeline,
    computed_tier: computedTier,
    price_range_shown: priceRangeShown,
  })

  if (dbError) {
    console.error('[pricing-estimate] insert failed:', dbError)
    return {
      success: false,
      error: 'Something went wrong. Please try again or book a call directly.',
    }
  }

  // e. Notify fan-out — preserves the exact payload shape the browser
  // form sent to /api/notify-pricing-estimate before this refactor
  // (snake_case keys matching the route's destructure). Failures are
  // non-blocking; the DB row is the source of truth.
  try {
    await fetch(`${APP_URL}/api/notify-pricing-estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        email,
        company,
        role,
        system_type: systemType,
        source_system_count: sourceSystemCount,
        table_count_range: tableCountRange,
        timeline,
        computed_tier: computedTier,
        price_range_shown: priceRangeShown,
      }),
    })
  } catch (err) {
    console.error('[pricing-estimate] notify fetch failed (non-blocking):', err)
  }

  return { success: true }
}
