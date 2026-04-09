/**
 * Shared email templates for Settle.
 * All emails use emailLayout() for consistent branding.
 * Admin notifications use adminEmailLayout() for data-table style.
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://usesettle.ai'
const CALENDLY_SCOPING =
  process.env.NEXT_PUBLIC_CALENDLY_SCOPING_URL ?? 'https://calendly.com/settle-ai/migration-scoping-call'

// ── Shared layout ─────────────────────────────────────────────────────────────

interface SignOff {
  name: string
  title: string
}

interface LayoutOptions {
  body: string
  ctaText?: string
  ctaUrl?: string
  /** Pass null to suppress sign-off entirely (e.g. admin emails). Omit for default (Kaan). */
  signOff?: SignOff | null
  showFooter?: boolean
}

export function emailLayout({
  body,
  ctaText,
  ctaUrl,
  signOff,
  showFooter = true,
}: LayoutOptions): string {
  const defaultSignOff: SignOff = { name: 'Kaan Dincer', title: 'Founder & CEO, Settle' }
  const resolvedSignOff = signOff === null ? null : (signOff ?? defaultSignOff)

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Settle</title>
</head>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;padding:40px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">

        <!-- Logo header -->
        <tr><td style="padding-bottom:24px;">
          <a href="${APP_URL}" style="text-decoration:none;display:inline-block;">
            <img src="${APP_URL}/images/logos/settle-logo-full.png" alt="Settle" width="120" style="display:block;border:0;height:auto;" />
          </a>
        </td></tr>

        <!-- Divider -->
        <tr><td style="border-top:1px solid #e2e8f0;padding-bottom:24px;"></td></tr>

        <!-- Body -->
        <tr><td style="font-size:15px;line-height:26px;color:#334155;">
          ${body}
        </td></tr>

        ${ctaText && ctaUrl ? `
        <!-- CTA button -->
        <tr><td style="padding:28px 0 8px;">
          <a href="${ctaUrl}"
             style="display:inline-block;background:#2358D4;color:white;font-weight:600;font-size:15px;padding:13px 28px;border-radius:8px;text-decoration:none;letter-spacing:0.01em;">
            ${ctaText}
          </a>
        </td></tr>
        ` : ''}

        ${resolvedSignOff ? `
        <!-- Sign-off -->
        <tr><td style="padding-top:24px;font-size:15px;line-height:26px;color:#334155;">
          <p style="margin:0;">
            Best,<br>
            <strong>${resolvedSignOff.name}</strong><br>
            <span style="color:#64748b;font-size:14px;">${resolvedSignOff.title}</span>
          </p>
        </td></tr>
        ` : ''}

        ${showFooter ? `
        <!-- Footer -->
        <tr><td style="padding-top:32px;border-top:1px solid #e2e8f0;margin-top:32px;">
          <p style="margin:0;font-size:13px;color:#94a3b8;line-height:20px;">
            Settle &middot; AI-native data migration<br>
            <a href="https://usesettle.ai" style="color:#94a3b8;text-decoration:none;">usesettle.ai</a>
          </p>
        </td></tr>
        ` : ''}

      </table>
    </td></tr>
  </table>
</body>
</html>`
}

// ── Admin notification layout (data table style, no personal sign-off) ────────

interface AdminLayoutOptions {
  title: string
  subtitle?: string
  fields: Array<{ label: string; value: string }>
  ctaText?: string
  ctaUrl?: string
}

export function adminEmailLayout({
  title,
  subtitle,
  fields,
  ctaText,
  ctaUrl,
}: AdminLayoutOptions): string {
  const rows = fields
    .map(
      (f) => `<tr>
      <td style="padding:9px 12px;font-size:13px;color:#64748b;font-weight:500;border-bottom:1px solid #f1f5f9;white-space:nowrap;width:120px;">${f.label}</td>
      <td style="padding:9px 12px;font-size:13px;color:#1e293b;border-bottom:1px solid #f1f5f9;">${f.value}</td>
    </tr>`
    )
    .join('')

  return emailLayout({
    body: `
      <p style="margin:0 0 4px;font-weight:700;font-size:17px;color:#0f172a;">${title}</p>
      ${subtitle ? `<p style="margin:0 0 20px;font-size:14px;color:#64748b;">${subtitle}</p>` : '<p style="margin:0 0 20px;"></p>'}
      <table width="100%" cellpadding="0" cellspacing="0"
             style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;border-collapse:collapse;">
        ${rows}
      </table>
    `,
    ctaText,
    ctaUrl,
    signOff: null,
    showFooter: true,
  })
}

// ── 1. Access request confirmation (to requester) ─────────────────────────────

export function accessRequestConfirmationEmail(
  firstName: string,
  isAssessment: boolean
): { subject: string; html: string } {
  const bodyText = isAssessment
    ? "Thanks for submitting your migration details. I'll review your request and get back to you within 48 hours."
    : "Thanks for your interest in Settle. I'll review your request and get back to you within 48 hours."

  return {
    subject: isAssessment
      ? 'Your migration assessment is underway — Settle'
      : 'We received your request — Settle',
    html: emailLayout({
      body: `
        <p style="margin:0 0 16px;">Hi ${firstName},</p>
        <p style="margin:0 0 16px;">${bodyText}</p>
        <p style="margin:0 0 16px;">If you'd like to book time sooner:</p>
        <p style="margin:0 0 16px;">
          <a href="${CALENDLY_SCOPING}"
             style="display:inline-block;background:#2358D4;color:white;font-weight:600;font-size:15px;padding:12px 28px;border-radius:8px;text-decoration:none;">
            Book a Call
          </a>
        </p>
        <p style="margin:0 0 16px;color:#64748b;">Otherwise, I'll be in touch soon. Feel free to reply to this email anytime.</p>
      `,
      signOff: { name: 'Kaan Dincer', title: 'Founder & CEO, Settle' },
    }),
  }
}

// ── 2. Org invite email (to invited user) ─────────────────────────────────────

export function orgInviteEmail(params: {
  recipientName?: string
  orgName: string
  role: string
  inviterName: string
  token: string
  appUrl?: string
}): { subject: string; html: string } {
  const acceptUrl = `${params.appUrl ?? APP_URL}/invite/${params.token}`

  const greeting = params.recipientName ? `Hi ${params.recipientName},` : 'Hi,'

  const roleWithArticle = ['admin', 'editor', 'owner'].includes(params.role.toLowerCase())
    ? `an ${params.role}`
    : `a ${params.role}`

  const joinPhrase = params.orgName.toLowerCase() === 'settle'
    ? `join Settle as <strong>${roleWithArticle}</strong>`
    : `join <strong>${params.orgName}</strong> on Settle as <strong>${roleWithArticle}</strong>`

  return {
    subject: `You've been invited to join ${params.orgName} on Settle`,
    html: emailLayout({
      body: `
        <p style="margin:0 0 16px;">${greeting}</p>
        <p style="margin:0 0 16px;">You've been invited to ${joinPhrase}.</p>
        <p style="margin:0 0 16px;">Click below to accept the invite. If you don't have a Settle account yet, you'll be able to create one.</p>
        <p style="margin:0 0 4px;font-size:13px;color:#94a3b8;">This invite expires in 7 days.</p>
      `,
      ctaText: 'Accept Invite',
      ctaUrl: acceptUrl,
      signOff: { name: 'Kaan Dincer', title: 'Founder & CEO, Settle' },
    }),
  }
}

// ── 3. Welcome email (sent after successful signup) ───────────────────────────

export function welcomeEmail(
  firstName: string,
  orgName: string
): { subject: string; html: string } {
  return {
    subject: `Welcome to Settle — you're all set`,
    html: emailLayout({
      body: `
        <p style="margin:0 0 16px;">Hi ${firstName},</p>
        <p style="margin:0 0 16px;">Your account is ready and you've joined <strong>${orgName}</strong>.</p>
        <p style="margin:0 0 12px;">Here's how to get started:</p>
        <ol style="margin:0 0 20px;padding-left:20px;color:#334155;font-size:15px;line-height:26px;">
          <li style="margin-bottom:6px;">Create a project and name your migration</li>
          <li style="margin-bottom:6px;">Upload your source data (CSV) or connect your database</li>
          <li style="margin-bottom:6px;">Settle profiles your data and generates field mappings automatically</li>
        </ol>
        <p style="margin:0 0 16px;">If you have any questions, just reply to this email.</p>
      `,
      ctaText: 'Go to Settle',
      ctaUrl: `${APP_URL}/app/projects`,
      signOff: { name: 'Kaan Dincer', title: 'Founder & CEO, Settle' },
    }),
  }
}

// ── 4. Admin notification — new access request ────────────────────────────────

export function adminAccessRequestEmail(data: {
  name: string
  email: string
  company: string
  roleType: string
  systemsInvolved?: string
  additionalNotes?: string
  source: string
  isAssessment?: boolean
}): { subject: string; html: string } {
  const subject = data.isAssessment
    ? `🎯 Migration Assessment Request: ${data.company}`
    : `New Access Request: ${data.company}`

  return {
    subject,
    html: adminEmailLayout({
      title: `New Access Request from ${data.name}`,
      subtitle: 'Someone just requested access to Settle.',
      fields: [
        { label: 'Name', value: data.name },
        { label: 'Email', value: `<a href="mailto:${data.email}" style="color:#2358D4;text-decoration:none;">${data.email}</a>` },
        { label: 'Company', value: data.company },
        { label: 'Role', value: data.roleType },
        ...(data.systemsInvolved
          ? [{ label: 'Systems', value: data.systemsInvolved }]
          : []),
        ...(data.additionalNotes
          ? [{ label: 'Notes', value: data.additionalNotes }]
          : []),
        { label: 'Source', value: data.source },
      ],
      ctaText: 'Review & Approve →',
      ctaUrl: `${APP_URL}/admin/invites`,
    }),
  }
}

// ── 5. Admin notification — new signup ────────────────────────────────────────

export function adminSignupEmail(data: {
  email: string
  name: string
  company?: string
  method: string
}): { subject: string; html: string } {
  return {
    subject: `New Settle Signup: ${data.email}`,
    html: adminEmailLayout({
      title: `New Signup: ${data.name}`,
      subtitle: 'A new user just created their Settle account.',
      fields: [
        { label: 'Email', value: `<a href="mailto:${data.email}" style="color:#2358D4;text-decoration:none;">${data.email}</a>` },
        { label: 'Name', value: data.name || 'Not provided' },
        ...(data.company ? [{ label: 'Company', value: data.company }] : []),
        { label: 'Method', value: `<code style="font-family:monospace;">${data.method}</code>` },
      ],
      ctaText: 'View Admin Dashboard →',
      ctaUrl: `${APP_URL}/admin/invites`,
    }),
  }
}
