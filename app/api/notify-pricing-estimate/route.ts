import { Resend } from 'resend'
import { NextResponse } from 'next/server'
import { pricingEstimateEmail, adminPricingEstimateEmail } from '@/lib/email/templates'

const resend = new Resend(process.env.RESEND_API_KEY)

const FROM_NOTIFICATIONS = 'Settle <info@usesettle.ai>'
const ADMIN_EMAIL = 'info@usesettle.ai'

// ── in-memory rate limit: max 3 notifications per email per 24h ──────────────
interface RLEntry { count: number; resetAt: number }
const emailAttempts = new Map<string, RLEntry>()
const MAX_NOTIFS = 3
const WINDOW_MS = 24 * 60 * 60 * 1000

function shouldNotify(email: string): boolean {
  const now = Date.now()
  const entry = emailAttempts.get(email)
  if (!entry || now > entry.resetAt) {
    emailAttempts.set(email, { count: 1, resetAt: now + WINDOW_MS })
    return true
  }
  if (entry.count >= MAX_NOTIFS) return false
  entry.count++
  return true
}

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const {
      name,
      email,
      company,
      role,
      system_type,
      source_system_count,
      table_count_range,
      timeline,
      computed_tier,
      price_range_shown,
    } = body

    if (!email) {
      return NextResponse.json({ success: false, error: 'Missing email' }, { status: 400 })
    }

    if (
      !name ||
      !company ||
      !system_type ||
      !source_system_count ||
      !table_count_range ||
      !timeline ||
      !computed_tier ||
      !price_range_shown
    ) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 })
    }

    if (!shouldNotify(String(email).toLowerCase())) {
      return NextResponse.json({ success: true, skipped: true })
    }

    const firstName = String(name).split(' ')[0]

    const { subject: userSubject, html: userHtml } = pricingEstimateEmail(
      firstName,
      price_range_shown,
      computed_tier,
    )

    const { subject: adminSubject, html: adminHtml } = adminPricingEstimateEmail({
      name,
      email,
      company,
      role: role || undefined,
      system_type,
      source_system_count,
      table_count_range,
      timeline,
      computed_tier,
      price_range_shown,
    })

    const results = await Promise.allSettled([
      resend.emails.send({
        from: FROM_NOTIFICATIONS,
        to: String(email).toLowerCase(),
        replyTo: ADMIN_EMAIL,
        subject: userSubject,
        html: userHtml,
      }),
      resend.emails.send({
        from: FROM_NOTIFICATIONS,
        to: ADMIN_EMAIL,
        replyTo: ADMIN_EMAIL,
        subject: adminSubject,
        html: adminHtml,
      }),
    ])

    const [userResult, adminResult] = results
    if (userResult.status === 'rejected') console.error('User confirmation failed:', userResult.reason)
    if (adminResult.status === 'rejected') console.error('Admin notification failed:', adminResult.reason)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Email notification failed:', error)
    return NextResponse.json({ success: false, error: 'Email failed' }, { status: 500 })
  }
}
