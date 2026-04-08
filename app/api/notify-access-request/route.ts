import { Resend } from 'resend'
import { NextResponse } from 'next/server'
import {
  accessRequestConfirmationEmail,
  adminAccessRequestEmail,
} from '@/lib/email/templates'

const resend = new Resend(process.env.RESEND_API_KEY)

const FROM_NOTIFICATIONS = 'Settle Notifications <info@usesettle.ai>'
const FROM_KAAN = 'Kaan from Settle <info@usesettle.ai>'
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
//
// Handles one type:
//   access_request  — sends requester confirmation + admin notification
//
// Org invites are sent directly from lib/actions/org-invites.ts via Resend.
// Signup notifications are sent directly from lib/actions/auth.ts via Resend.

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const {
      name,
      email,
      company,
      role_type,
      systems_involved,
      additional_notes,
      ref,
    } = body

    if (!email) {
      return NextResponse.json({ success: false, error: 'Missing email' }, { status: 400 })
    }

    if (!name || !company || !role_type) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 })
    }

    if (!shouldNotify(String(email).toLowerCase())) {
      return NextResponse.json({ success: true, skipped: true })
    }

    const isAssessment = ref === 'assessment'
    const firstName = name.split(' ')[0]

    const source = isAssessment
      ? 'Migration Page — Assessment Request'
      : 'Homepage / General — Access Request'

    const { subject: adminSubject, html: adminHtml } = adminAccessRequestEmail({
      name,
      email,
      company,
      roleType: role_type,
      systemsInvolved: systems_involved,
      additionalNotes: additional_notes,
      source,
      isAssessment,
    })

    const { subject: requesterSubject, html: requesterHtml } =
      accessRequestConfirmationEmail(firstName, isAssessment)

    const results = await Promise.allSettled([
      resend.emails.send({
        from: FROM_NOTIFICATIONS,
        to: ADMIN_EMAIL,
        replyTo: ADMIN_EMAIL,
        subject: adminSubject,
        html: adminHtml,
      }),
      resend.emails.send({
        from: FROM_KAAN,
        to: email,
        replyTo: ADMIN_EMAIL,
        subject: requesterSubject,
        html: requesterHtml,
      }),
    ])

    const [adminResult, requesterResult] = results
    if (adminResult.status === 'rejected') console.error('Admin notification failed:', adminResult.reason)
    if (requesterResult.status === 'rejected') console.error('Requester confirmation failed:', requesterResult.reason)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Email notification failed:', error)
    return NextResponse.json({ success: false, error: 'Email failed' }, { status: 500 })
  }
}
