import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { AuditEventRow } from '@/app/app/settings/sso/components/AuditEventRow'
import type { AuditEvent } from '@/app/app/settings/sso/components/AuditEventRow'

// ─────────────────────────────────────────────────────────────────────
// AuditEventRow — Mini-D6 hybrid switch.
//
// The renderer is the load-bearing UX surface for the audit log on
// /app/settings/sso. Five event types get hand-crafted summaries
// with reason translation; six others fall back to a generic
// metadata key/value list. We exercise every branch:
//
//   1. Each of the 11 declared SSOAuditEventType values renders
//      without throwing.
//   2. The five hand-crafted types produce the exact summary copy
//      in the spec.
//   3. The reason-translation table on `sso.login.failure` is
//      honored verbatim.
//   4. NULL `actor_user_id` renders as "Unauthenticated attempt".
//   5. Hash fields (`*_hash`) render truncated with the
//      "(hashed)" label.
//   6. The default fallback for an unknown event_type does not
//      throw and includes the raw event_type in the summary.
//
// Setup
// -----
// `<details>` / `<summary>` rendering in jsdom does not auto-open,
// so all assertions read from the visible summary or from elements
// that are present in the DOM regardless of open state. The expand
// affordance is exercised at the integration layer.
// ─────────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'evt-1',
    event_type: 'sso.login.success',
    actor_user_id: 'user-1',
    actor_email: 'alice@acme.test',
    metadata: {},
    created_at: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  }
}

// ─── 1. Hand-crafted summaries: sso.login.success ────────────────────

describe('AuditEventRow — sso.login.success', () => {
  it('renders "<email> signed in via SSO"', () => {
    render(<AuditEventRow event={makeEvent()} />)
    expect(
      screen.getByTestId('audit-row-summary').textContent,
    ).toBe('alice@acme.test signed in via SSO')
  })

  it('appends "(new member)" when metadata.is_new_membership is true', () => {
    const event = makeEvent({ metadata: { is_new_membership: true } })
    render(<AuditEventRow event={event} />)
    expect(
      screen.getByTestId('audit-row-summary').textContent,
    ).toBe('alice@acme.test signed in via SSO (new member)')
  })

  it('does NOT append "(new member)" when is_new_membership is missing or false', () => {
    const event = makeEvent({ metadata: { is_new_membership: false } })
    render(<AuditEventRow event={event} />)
    expect(
      screen.getByTestId('audit-row-summary').textContent,
    ).not.toContain('new member')
  })
})

// ─── 2. sso.login.failure with reason translation ────────────────────

describe('AuditEventRow — sso.login.failure', () => {
  it.each([
    ['cross_tenant', 'wrong organization'],
    ['domain_provider_mismatch', 'domain mismatch'],
    ['duplicate_account', 'duplicate account'],
    ['attempted_org_missing', 'session expired'],
    ['provider_not_resolved', 'provider not resolved'],
    ['jit_failed', 'account creation failed'],
    ['identity_link_failed', 'identity linking failed'],
    ['rate_limited', 'rate limit exceeded'],
    ['unknown_org', 'unknown organization'],
    ['sdk_error', 'provider SDK error'],
  ])('translates reason=%s to "%s"', (reason, expectedHuman) => {
    const event = makeEvent({
      event_type: 'sso.login.failure',
      metadata: { reason },
    })
    render(<AuditEventRow event={event} />)
    expect(screen.getByTestId('audit-row-summary').textContent).toContain(
      `sign-in failed: ${expectedHuman}`,
    )
  })

  it('passes through unknown reason codes verbatim (no silent drop)', () => {
    const event = makeEvent({
      event_type: 'sso.login.failure',
      metadata: { reason: 'totally_new_reason_we_added_yesterday' },
    })
    render(<AuditEventRow event={event} />)
    expect(screen.getByTestId('audit-row-summary').textContent).toContain(
      'totally_new_reason_we_added_yesterday',
    )
  })

  it('falls back to "unknown" when metadata.reason is missing', () => {
    const event = makeEvent({ event_type: 'sso.login.failure', metadata: {} })
    render(<AuditEventRow event={event} />)
    expect(screen.getByTestId('audit-row-summary').textContent).toContain(
      'sign-in failed: unknown',
    )
  })
})

// ─── 3. Other hand-crafted summaries ─────────────────────────────────

describe('AuditEventRow — sso.provider.configured', () => {
  it('mentions actor and idp_type', () => {
    const event = makeEvent({
      event_type: 'sso.provider.configured',
      metadata: { idp_type: 'okta' },
    })
    render(<AuditEventRow event={event} />)
    expect(screen.getByTestId('audit-row-summary').textContent).toBe(
      'alice@acme.test set up okta SSO',
    )
  })

  it('falls back to "SSO" when idp_type is missing', () => {
    const event = makeEvent({
      event_type: 'sso.provider.configured',
      metadata: {},
    })
    render(<AuditEventRow event={event} />)
    expect(screen.getByTestId('audit-row-summary').textContent).toContain(
      'set up SSO SSO',
    )
  })
})

describe('AuditEventRow — sso.enforcement.changed', () => {
  it('renders previous → next mode', () => {
    const event = makeEvent({
      event_type: 'sso.enforcement.changed',
      metadata: { previous_mode: 'optional', new_mode: 'strict' },
    })
    render(<AuditEventRow event={event} />)
    expect(screen.getByTestId('audit-row-summary').textContent).toBe(
      'alice@acme.test changed enforcement: optional → strict',
    )
  })
})

describe('AuditEventRow — sso.domain.added / removed', () => {
  it('renders "<actor> added domain <domain>"', () => {
    const event = makeEvent({
      event_type: 'sso.domain.added',
      metadata: { domain: 'acme.com' },
    })
    render(<AuditEventRow event={event} />)
    expect(screen.getByTestId('audit-row-summary').textContent).toBe(
      'alice@acme.test added domain acme.com',
    )
  })

  it('renders "<actor> removed domain <domain>"', () => {
    const event = makeEvent({
      event_type: 'sso.domain.removed',
      metadata: { domain: 'acme.com' },
    })
    render(<AuditEventRow event={event} />)
    expect(screen.getByTestId('audit-row-summary').textContent).toBe(
      'alice@acme.test removed domain acme.com',
    )
  })
})

// ─── 4. NULL actor → "Unauthenticated attempt" ───────────────────────

describe('AuditEventRow — actor labeling', () => {
  it('renders "Unauthenticated attempt" for null actor_user_id', () => {
    const event = makeEvent({
      actor_user_id: null,
      actor_email: null,
      event_type: 'sso.login.failure',
      metadata: { reason: 'rate_limited' },
    })
    render(<AuditEventRow event={event} />)
    expect(screen.getByTestId('audit-row-summary').textContent).toBe(
      'Unauthenticated attempt sign-in failed: rate limit exceeded',
    )
  })

  it('falls back to a short user-id tail when email is null but actor_user_id exists', () => {
    // Hard-deleted user case: link/event row outlived its auth.users row.
    const event = makeEvent({
      actor_user_id: 'aaaaaaaaaaaaa-bbbb',
      actor_email: null,
    })
    render(<AuditEventRow event={event} />)
    expect(screen.getByTestId('audit-row-summary').textContent).toContain(
      'User aaaaaaaa…',
    )
  })
})

// ─── 5. Hashed metadata fields ───────────────────────────────────────

describe('AuditEventRow — hash truncation', () => {
  it('renders *_hash fields truncated with "(hashed)" label', () => {
    const event = makeEvent({
      event_type: 'sso.login.failure',
      actor_user_id: null,
      actor_email: null,
      metadata: {
        reason: 'unknown_org',
        email_hash: '4a6b020c1234567890abcdef',
        ip_hash: 'fffefdfc11223344',
      },
    })
    render(<AuditEventRow event={event} />)
    const details = screen.getByTestId('audit-row-details')
    // Truncated to first 8 chars + ellipsis + label.
    expect(within(details).getByText(/4a6b020c… \(hashed email\)/)).toBeTruthy()
    expect(within(details).getByText(/fffefdfc… \(hashed ip\)/)).toBeTruthy()
  })

  it('renders non-hash string values as-is', () => {
    const event = makeEvent({
      event_type: 'sso.domain.added',
      metadata: { domain: 'engineering.acme.com' },
    })
    render(<AuditEventRow event={event} />)
    const details = screen.getByTestId('audit-row-details')
    expect(within(details).getByText('engineering.acme.com')).toBeTruthy()
  })
})

// ─── 6. Default fallback ─────────────────────────────────────────────

describe('AuditEventRow — fallback rendering for non-handcrafted types', () => {
  it.each([
    'sso.provider.updated',
    'sso.provider.removed',
    'sso.jit.provisioned',
    'sso.identity.linked',
    'sso.identity.unlinked',
  ] as const)('renders %s without crashing', (event_type) => {
    const event = makeEvent({ event_type })
    expect(() => render(<AuditEventRow event={event} />)).not.toThrow()
    // Default summary: "<actor> — <event_type>"
    expect(screen.getByTestId('audit-row-summary').textContent).toContain(
      event_type,
    )
  })

  it('renders an unknown event_type without crashing (forward compat)', () => {
    const event = makeEvent({
      // Cast to any so a future schema addition doesn't break compile.
      event_type: 'sso.future.event' as never,
    })
    expect(() => render(<AuditEventRow event={event} />)).not.toThrow()
    expect(screen.getByTestId('audit-row-summary').textContent).toContain(
      'sso.future.event',
    )
  })

  it('shows "No additional details" when metadata is empty', () => {
    const event = makeEvent({
      event_type: 'sso.identity.linked',
      metadata: {},
    })
    render(<AuditEventRow event={event} />)
    expect(screen.getByTestId('audit-row-no-details')).toBeTruthy()
  })
})

// ─── 7. Time formatting ──────────────────────────────────────────────

describe('AuditEventRow — relative time', () => {
  it('renders "just now" for events within the last minute', () => {
    const event = makeEvent({
      created_at: new Date(Date.now() - 5_000).toISOString(),
    })
    render(<AuditEventRow event={event} />)
    expect(screen.getByText('just now')).toBeTruthy()
  })

  it('renders "<n>m ago" between 1 and 60 minutes', () => {
    const event = makeEvent({
      created_at: new Date(Date.now() - 7 * 60_000).toISOString(),
    })
    render(<AuditEventRow event={event} />)
    expect(screen.getByText('7m ago')).toBeTruthy()
  })

  it('renders "<n>h ago" between 1 and 24 hours', () => {
    const event = makeEvent({
      created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    })
    render(<AuditEventRow event={event} />)
    expect(screen.getByText('3h ago')).toBeTruthy()
  })
})
