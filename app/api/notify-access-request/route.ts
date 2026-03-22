import { Resend } from 'resend'
import { NextResponse } from 'next/server'

const resend = new Resend(process.env.RESEND_API_KEY)

const CALENDLY = 'https://calendly.com/trymine-info/demo'
const FROM_NOTIFICATIONS = 'Mine Notifications <contact@trymine.ai>'
const FROM_KAAN = 'Kaan from Mine <contact@trymine.ai>'
const ADMIN_EMAIL = 'kaandincer1@gmail.com'

// ── in-memory rate limit: max 3 notifications per email per 24h ───────────
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

// ── email builders ─────────────────────────────────────────────────────────

function adminAccessRequestHtml(name: string, email: string, company: string, role_type: string, systems_involved?: string, additional_notes?: string) {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 24px;">
        <div style="width: 28px; height: 28px; background: #2563EB; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center;">
          <span style="color: white; font-size: 14px; font-weight: bold; line-height: 1;">M</span>
        </div>
        <span style="font-size: 16px; font-weight: 700; color: #0F172A;">Mine</span>
      </div>
      <h2 style="font-size: 20px; font-weight: 700; color: #0F172A; margin: 0 0 6px 0;">New Access Request</h2>
      <p style="color: #64748B; font-size: 14px; margin: 0 0 24px 0;">Someone just requested access to Mine.</p>
      <table style="width: 100%; border-collapse: collapse; border: 1px solid #E2E8F0; border-radius: 8px; overflow: hidden;">
        <tr style="background: #F8FAFC;">
          <td style="padding: 10px 14px; font-size: 13px; font-weight: 600; color: #475569; width: 130px; border-bottom: 1px solid #E2E8F0;">Name</td>
          <td style="padding: 10px 14px; font-size: 13px; color: #0F172A; border-bottom: 1px solid #E2E8F0;">${name}</td>
        </tr>
        <tr>
          <td style="padding: 10px 14px; font-size: 13px; font-weight: 600; color: #475569; border-bottom: 1px solid #E2E8F0;">Email</td>
          <td style="padding: 10px 14px; font-size: 13px; border-bottom: 1px solid #E2E8F0;"><a href="mailto:${email}" style="color: #2563EB; text-decoration: none;">${email}</a></td>
        </tr>
        <tr style="background: #F8FAFC;">
          <td style="padding: 10px 14px; font-size: 13px; font-weight: 600; color: #475569; border-bottom: 1px solid #E2E8F0;">Company</td>
          <td style="padding: 10px 14px; font-size: 13px; color: #0F172A; border-bottom: 1px solid #E2E8F0;">${company}</td>
        </tr>
        <tr>
          <td style="padding: 10px 14px; font-size: 13px; font-weight: 600; color: #475569; border-bottom: 1px solid #E2E8F0;">Role</td>
          <td style="padding: 10px 14px; font-size: 13px; color: #0F172A; border-bottom: 1px solid #E2E8F0;">${role_type}</td>
        </tr>
        <tr style="background: #F8FAFC;">
          <td style="padding: 10px 14px; font-size: 13px; font-weight: 600; color: #475569; border-bottom: 1px solid #E2E8F0; vertical-align: top;">Systems</td>
          <td style="padding: 10px 14px; font-size: 13px; color: #0F172A; border-bottom: 1px solid #E2E8F0;">${systems_involved || '<span style="color:#94A3B8;">Not specified</span>'}</td>
        </tr>
        <tr>
          <td style="padding: 10px 14px; font-size: 13px; font-weight: 600; color: #475569; vertical-align: top;">Notes</td>
          <td style="padding: 10px 14px; font-size: 13px; color: #0F172A;">${additional_notes || '<span style="color:#94A3B8;">None</span>'}</td>
        </tr>
      </table>
      <div style="margin-top: 24px;">
        <a href="https://trymine.ai/admin/invites"
           style="display: inline-block; background: #4F46E5; color: white; padding: 11px 22px; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600;">
          Review &amp; Approve →
        </a>
      </div>
      <p style="margin-top: 24px; font-size: 12px; color: #94A3B8;">Mine · trymine.ai</p>
    </div>
  `
}

function requesterConfirmationHtml(name: string) {
  const firstName = name.split(' ')[0]
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; color: #1a1a2e; line-height: 1.6;">
      <p style="margin: 0 0 16px 0;">Hi ${firstName},</p>
      <p style="margin: 0 0 16px 0;">Thanks for your interest in Mine. We received your access request and will be in touch within 24 hours.</p>
      <p style="margin: 0 0 16px 0;">In the meantime, if you'd like to see Mine in action, you can book a demo call:</p>
      <p style="margin: 0 0 24px 0;">
        <a href="${CALENDLY}"
           style="display: inline-block; background: #4F46E5; color: white; padding: 10px 24px; text-decoration: none; border-radius: 6px; font-weight: 500; font-size: 14px;">
          Book a Demo
        </a>
      </p>
      <p style="margin: 0; color: #334155;">Best,<br/>Kaan Dincer<br/>Founder, Mine</p>
    </div>
  `
}

function adminSignupHtml(name: string, email: string, company: string, invite_code: string) {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 24px;">
        <div style="width: 28px; height: 28px; background: #2563EB; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center;">
          <span style="color: white; font-size: 14px; font-weight: bold; line-height: 1;">M</span>
        </div>
        <span style="font-size: 16px; font-weight: 700; color: #0F172A;">Mine</span>
      </div>
      <h2 style="font-size: 20px; font-weight: 700; color: #0F172A; margin: 0 0 6px 0;">New User Signed Up</h2>
      <p style="color: #64748B; font-size: 14px; margin: 0 0 24px 0;">A new user just created their Mine account.</p>
      <table style="width: 100%; border-collapse: collapse; border: 1px solid #E2E8F0; border-radius: 8px; overflow: hidden;">
        <tr style="background: #F8FAFC;">
          <td style="padding: 10px 14px; font-size: 13px; font-weight: 600; color: #475569; width: 130px; border-bottom: 1px solid #E2E8F0;">Email</td>
          <td style="padding: 10px 14px; font-size: 13px; border-bottom: 1px solid #E2E8F0;"><a href="mailto:${email}" style="color: #2563EB; text-decoration: none;">${email}</a></td>
        </tr>
        <tr>
          <td style="padding: 10px 14px; font-size: 13px; font-weight: 600; color: #475569; border-bottom: 1px solid #E2E8F0;">Name</td>
          <td style="padding: 10px 14px; font-size: 13px; color: #0F172A; border-bottom: 1px solid #E2E8F0;">${name || '<span style="color:#94A3B8;">Not provided</span>'}</td>
        </tr>
        <tr style="background: #F8FAFC;">
          <td style="padding: 10px 14px; font-size: 13px; font-weight: 600; color: #475569; border-bottom: 1px solid #E2E8F0;">Company</td>
          <td style="padding: 10px 14px; font-size: 13px; color: #0F172A; border-bottom: 1px solid #E2E8F0;">${company || '<span style="color:#94A3B8;">Not provided</span>'}</td>
        </tr>
        <tr>
          <td style="padding: 10px 14px; font-size: 13px; font-weight: 600; color: #475569;">Invite Code</td>
          <td style="padding: 10px 14px; font-size: 13px; font-family: monospace; color: #0F172A;">${invite_code || 'Unknown'}</td>
        </tr>
      </table>
      <p style="margin-top: 16px; font-size: 14px; color: #475569;">They can now log in. Reach out to schedule their onboarding session.</p>
      <div style="margin-top: 16px;">
        <a href="https://trymine.ai/admin/invites"
           style="display: inline-block; background: #4F46E5; color: white; padding: 11px 22px; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 600;">
          View Admin Dashboard →
        </a>
      </div>
      <p style="margin-top: 24px; font-size: 12px; color: #94A3B8;">Mine · trymine.ai</p>
    </div>
  `
}

// ── POST handler ──────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const {
      type = 'access_request',
      name,
      email,
      company,
      role_type,
      systems_involved,
      additional_notes,
      invite_code,
    } = body

    if (!email) {
      return NextResponse.json({ success: false, error: 'Missing email' }, { status: 400 })
    }

    // ── Signup notification (admin only, no rate limit) ──────────────────
    if (type === 'signup') {
      await resend.emails.send({
        from: FROM_NOTIFICATIONS,
        to: ADMIN_EMAIL,
        replyTo: 'contact@trymine.ai',
        subject: `New Mine Signup: ${email}`,
        html: adminSignupHtml(name || '', email, company || '', invite_code || ''),
      })
      return NextResponse.json({ success: true })
    }

    // ── Access request (admin + requester) ───────────────────────────────
    if (!name || !company || !role_type) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 })
    }

    // Rate limit by submitter email
    if (!shouldNotify(String(email).toLowerCase())) {
      return NextResponse.json({ success: true, skipped: true })
    }

    // Send admin notification + requester confirmation in parallel.
    // If the requester email fails, the admin notification still succeeds.
    const results = await Promise.allSettled([
      resend.emails.send({
        from: FROM_NOTIFICATIONS,
        to: ADMIN_EMAIL,
        replyTo: 'contact@trymine.ai',
        subject: `New Mine Access Request: ${company}`,
        html: adminAccessRequestHtml(name, email, company, role_type, systems_involved, additional_notes),
      }),
      resend.emails.send({
        from: FROM_KAAN,
        to: email,
        replyTo: 'contact@trymine.ai',
        subject: 'We received your request — Mine',
        html: requesterConfirmationHtml(name),
      }),
    ])

    const [adminResult, requesterResult] = results
    if (adminResult.status === 'rejected') {
      console.error('Admin notification email failed:', adminResult.reason)
    }
    if (requesterResult.status === 'rejected') {
      console.error('Requester confirmation email failed:', requesterResult.reason)
    }

    // Return success as long as at least the admin email was attempted
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Email notification failed:', error)
    return NextResponse.json({ success: false, error: 'Email failed' }, { status: 500 })
  }
}
