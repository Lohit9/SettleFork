import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SsoSettingsContent } from '@/app/app/settings/sso/SsoSettingsContent'
import type {
  GetOrgSsoOverviewResult,
  ListOrgSsoDomainsResult,
  ListOrgSsoLinkedUsersResult,
  ListOrgSsoAuditEventsResult,
} from '@/lib/actions/sso-admin'

// ─────────────────────────────────────────────────────────────────────
// SsoSettingsContent — page orchestrator under various data states.
//
// Covers the four states the page can land in:
//
//   1. SSO enabled + all four payloads ok → four sections render.
//   2. SSO disabled (overview.ok && !sso_enabled) → empty state CTA.
//   3. Overview returned ok:false → fall-through to four sections;
//      overview card renders its error row, others render their data
//      (fail-soft).
//   4. A single non-overview action returned ok:false → that section
//      renders an error row; siblings render normally.
//
// Plus inline empty states:
//   5. Empty domains array → "No domains configured."
//   6. Empty linked users array → "No SSO sign-ins yet."
//   7. Empty audit events array → "No recent SSO activity."
//
// We DO NOT test routing or auth gating here — those live in the
// RSC at `app/app/settings/sso/page.tsx` and have their own test
// surface (the integration suite at Step 10).
// ─────────────────────────────────────────────────────────────────────

const ORG_ID = '00000000-0000-0000-0000-000000000001'

function okOverview(
  overrides: Partial<Extract<GetOrgSsoOverviewResult, { ok: true }>> = {},
): GetOrgSsoOverviewResult {
  return {
    ok: true,
    sso_enabled: true,
    enforcement_mode: 'hybrid',
    sso_configured_at: new Date('2026-04-01T00:00:00Z').toISOString(),
    idp_type: 'okta',
    ...overrides,
  }
}

function okDomains(
  domains: Array<{ id: string; domain: string }> = [{ id: 'd1', domain: 'acme.com' }],
): ListOrgSsoDomainsResult {
  return { ok: true, domains }
}

function okUsers(
  users: Array<{
    user_id: string
    email: string | null
    linked_at: string
    last_login_at: string | null
  }> = [
    {
      user_id: 'u1',
      email: 'alice@acme.test',
      linked_at: new Date(Date.now() - 86_400_000).toISOString(),
      last_login_at: new Date(Date.now() - 60_000).toISOString(),
    },
  ],
): ListOrgSsoLinkedUsersResult {
  return { ok: true, users }
}

// Extract the event row type from the discriminated union for the
// helper signature below. Defaults are non-empty so the happy-path
// renders show realistic data.
type SsoAuditEventRow = Extract<
  ListOrgSsoAuditEventsResult,
  { ok: true }
>['events'][number]

function okEvents(
  events: SsoAuditEventRow[] = [
    {
      id: 'e1',
      event_type: 'sso.login.success',
      actor_user_id: 'u1',
      actor_email: 'alice@acme.test',
      metadata: { is_new_membership: false },
      created_at: new Date(Date.now() - 60_000).toISOString(),
    },
  ],
): ListOrgSsoAuditEventsResult {
  return { ok: true, events }
}

// ─── 1. Happy path — four sections render ────────────────────────────

describe('SsoSettingsContent — SSO enabled + all data ok', () => {
  it('renders all four section headings', () => {
    render(
      <SsoSettingsContent
        orgId={ORG_ID}
        overview={okOverview()}
        domains={okDomains()}
        linkedUsers={okUsers()}
        auditEvents={okEvents()}
      />,
    )
    expect(screen.getByText('Configuration')).toBeTruthy()
    expect(screen.getByText('Domains')).toBeTruthy()
    expect(screen.getByText('SSO-linked users')).toBeTruthy()
    expect(screen.getByText('Recent activity')).toBeTruthy()
  })

  it('does NOT render the empty-state CTA when SSO is enabled', () => {
    render(
      <SsoSettingsContent
        orgId={ORG_ID}
        overview={okOverview()}
        domains={okDomains()}
        linkedUsers={okUsers()}
        auditEvents={okEvents()}
      />,
    )
    expect(screen.queryByTestId('sso-empty-state')).toBeNull()
  })

  it('shows enforcement-mode badge text', () => {
    render(
      <SsoSettingsContent
        orgId={ORG_ID}
        overview={okOverview({ enforcement_mode: 'strict' })}
        domains={okDomains()}
        linkedUsers={okUsers()}
        auditEvents={okEvents()}
      />,
    )
    expect(screen.getByText(/Strict \(SSO required\)/)).toBeTruthy()
  })
})

// ─── 2. SSO disabled → empty state ───────────────────────────────────

describe('SsoSettingsContent — SSO disabled', () => {
  it('renders the empty-state CTA when overview.sso_enabled is false', () => {
    render(
      <SsoSettingsContent
        orgId={ORG_ID}
        overview={okOverview({ sso_enabled: false })}
        domains={okDomains()}
        linkedUsers={okUsers()}
        auditEvents={okEvents()}
      />,
    )
    expect(screen.getByTestId('sso-empty-state')).toBeTruthy()
  })

  it('does NOT render the four data sections when SSO is disabled', () => {
    render(
      <SsoSettingsContent
        orgId={ORG_ID}
        overview={okOverview({ sso_enabled: false })}
        domains={okDomains()}
        linkedUsers={okUsers()}
        auditEvents={okEvents()}
      />,
    )
    expect(screen.queryByText('Configuration')).toBeNull()
    expect(screen.queryByText('Domains')).toBeNull()
  })

  it('contact-support CTA links to mailto:info@usesettle.ai', () => {
    render(
      <SsoSettingsContent
        orgId={ORG_ID}
        overview={okOverview({ sso_enabled: false })}
        domains={okDomains()}
        linkedUsers={okUsers()}
        auditEvents={okEvents()}
      />,
    )
    const cta = screen.getByText('Contact support to enable SSO')
    expect(cta.getAttribute('href')).toMatch(/^mailto:info@usesettle\.ai/)
  })
})

// ─── 3. Fail-soft on action errors ───────────────────────────────────

describe('SsoSettingsContent — fail-soft when actions return ok:false', () => {
  it('renders four sections even when overview fails (siblings still render)', () => {
    render(
      <SsoSettingsContent
        orgId={ORG_ID}
        overview={{ ok: false, error: 'Failed to load organization' }}
        domains={okDomains()}
        linkedUsers={okUsers()}
        auditEvents={okEvents()}
      />,
    )
    // All four section headings still mount.
    expect(screen.getByText('Configuration')).toBeTruthy()
    expect(screen.getByText('Domains')).toBeTruthy()
    // Overview surfaces the error inline.
    expect(screen.getByText('Failed to load organization')).toBeTruthy()
  })

  it('renders an error row in the affected section only (domains)', () => {
    render(
      <SsoSettingsContent
        orgId={ORG_ID}
        overview={okOverview()}
        domains={{ ok: false, error: 'Failed to load domains' }}
        linkedUsers={okUsers()}
        auditEvents={okEvents()}
      />,
    )
    expect(screen.getByText('Failed to load domains')).toBeTruthy()
    // Linked users still renders its data.
    expect(screen.getByTestId('linked-users-list')).toBeTruthy()
  })

  it('renders an error row for audit-events section without affecting others', () => {
    render(
      <SsoSettingsContent
        orgId={ORG_ID}
        overview={okOverview()}
        domains={okDomains()}
        linkedUsers={okUsers()}
        auditEvents={{ ok: false, error: 'Failed to load audit events' }}
      />,
    )
    expect(screen.getByText('Failed to load audit events')).toBeTruthy()
    expect(screen.getByTestId('domains-list')).toBeTruthy()
  })
})

// ─── 4. Inline empty states ──────────────────────────────────────────

describe('SsoSettingsContent — inline empty states', () => {
  it('domains: shows "No domains configured." when empty', () => {
    render(
      <SsoSettingsContent
        orgId={ORG_ID}
        overview={okOverview()}
        domains={okDomains([])}
        linkedUsers={okUsers()}
        auditEvents={okEvents()}
      />,
    )
    expect(screen.getByText('No domains configured.')).toBeTruthy()
  })

  it('linked users: shows "No SSO sign-ins yet." when empty', () => {
    render(
      <SsoSettingsContent
        orgId={ORG_ID}
        overview={okOverview()}
        domains={okDomains()}
        linkedUsers={okUsers([])}
        auditEvents={okEvents()}
      />,
    )
    expect(screen.getByText('No SSO sign-ins yet.')).toBeTruthy()
  })

  it('audit events: shows "No recent SSO activity." when empty', () => {
    render(
      <SsoSettingsContent
        orgId={ORG_ID}
        overview={okOverview()}
        domains={okDomains()}
        linkedUsers={okUsers()}
        auditEvents={okEvents([])}
      />,
    )
    expect(screen.getByText('No recent SSO activity.')).toBeTruthy()
  })
})
