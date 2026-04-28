// Component tests for `components/auth/EmailFirstLoginForm.tsx` —
// the B-2-b two-stage email-first login form.
//
// Coverage map (12 describe blocks per the implementation prompt):
//
//   1. Stage 1 — initial render
//   2. Stage 1 — local email validation
//   3. Stage 1 → Stage 2 (no SSO)
//   4. Stage 1 → Stage 2 (hybrid SSO)
//   5. Stage 1 → /sso/start (strict SSO)
//   6. Stage 2 — password submit success
//   7. Stage 2 — password submit error mapping
//   8. Stage 2 — Edit affordance returns to Stage 1 and clears password
//   9. Reason-code rendering for all 14 codes
//  10. ?redirect= and ?returnTo= preservation through the flow
//  11. Probe failure fail-soft (checkSSOEnabledForEmail throws)
//  12. Submit-while-loading guard (double-submit prevention)
//
// Mocking strategy:
//   - `next/navigation`: useRouter() and useSearchParams() are
//     mocked. Each test sets the mock searchParams to whatever URL
//     query state it needs.
//   - `@/lib/actions/sso`: checkSSOEnabledForEmail is a vi.fn().
//   - `@/lib/supabase/client`: createClient returns an object whose
//     auth.signInWithPassword is a vi.fn().
//   - `window.location.href` is captured via Object.defineProperty so
//     we can assert the SSO redirect URL without actually navigating.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EmailFirstLoginForm from '@/components/auth/EmailFirstLoginForm'
import { LOGIN_REASONS } from '@/lib/auth/login-reason-codes'

// ─────────────────────────────────────────────────────────────────────
// vi.hoisted mocks (pattern used by tests/components/create-mapping-form.test.tsx)
// ─────────────────────────────────────────────────────────────────────

const {
  routerPushMock,
  routerRefreshMock,
  searchParamsRef,
  checkSSOMock,
  signInWithPasswordMock,
} = vi.hoisted(() => ({
  routerPushMock: vi.fn(),
  routerRefreshMock: vi.fn(),
  // We use a ref-style holder so each test can swap in fresh
  // searchParams without needing to re-mock next/navigation. The mock
  // factory below reads `searchParamsRef.current` at call time.
  searchParamsRef: { current: new URLSearchParams() as URLSearchParams },
  checkSSOMock: vi.fn(),
  signInWithPasswordMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: routerPushMock,
    refresh: routerRefreshMock,
    replace: vi.fn(),
  }),
  useSearchParams: () => searchParamsRef.current,
}))

vi.mock('@/lib/actions/sso', () => ({
  checkSSOEnabledForEmail: (...args: unknown[]) => checkSSOMock(...args),
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: (...args: unknown[]) =>
        signInWithPasswordMock(...args),
    },
  }),
}))

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function setSearchParams(qs: string | URLSearchParams = '') {
  searchParamsRef.current =
    typeof qs === 'string' ? new URLSearchParams(qs) : qs
}

// `window.location.href` is a getter/setter on jsdom's Location. We
// shim it per-test with a plain object property so we can assert the
// strict-SSO redirect URL without triggering a real navigation.
let locationHrefSpy: { value: string } = { value: '' }

function shimWindowLocationHref() {
  locationHrefSpy = { value: '' }
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      ...window.location,
      get href() {
        return locationHrefSpy.value
      },
      set href(v: string) {
        locationHrefSpy.value = v
      },
    },
  })
}

beforeEach(() => {
  routerPushMock.mockReset()
  routerRefreshMock.mockReset()
  checkSSOMock.mockReset()
  signInWithPasswordMock.mockReset()
  setSearchParams('')
  shimWindowLocationHref()
})

afterEach(() => {
  // jsdom's location is restored on the next test's beforeEach via
  // shimWindowLocationHref; nothing to do here today, but keeping
  // the hook present for future cleanup.
})

// ─────────────────────────────────────────────────────────────────────
// 1. Stage 1 — initial render
// ─────────────────────────────────────────────────────────────────────

describe('EmailFirstLoginForm — Stage 1 initial render', () => {
  it('renders the email field, hidden autofill password input, and Continue button', () => {
    render(<EmailFirstLoginForm />)
    expect(screen.getByTestId('email-stage-form')).toBeInTheDocument()
    expect(screen.getByLabelText(/work email/i)).toBeInTheDocument()
    expect(screen.getByTestId('continue-button')).toHaveTextContent('Continue')
    expect(screen.getByTestId('continue-button')).not.toBeDisabled()
  })

  it('renders the hidden password autofill input with sr-only + aria-hidden + tabIndex=-1', () => {
    render(<EmailFirstLoginForm />)
    const hidden = screen.getByTestId('hidden-password-autofill')
    expect(hidden).toHaveAttribute('type', 'password')
    expect(hidden).toHaveAttribute('autocomplete', 'current-password')
    expect(hidden).toHaveAttribute('aria-hidden', 'true')
    expect(hidden).toHaveAttribute('tabindex', '-1')
    expect(hidden.className).toMatch(/sr-only/)
  })

  it('does not render Stage-2 elements on initial mount', () => {
    render(<EmailFirstLoginForm />)
    expect(screen.queryByTestId('password-stage-form')).toBeNull()
    expect(screen.queryByTestId('email-readonly')).toBeNull()
    expect(screen.queryByTestId('sso-button')).toBeNull()
  })

  it('does not render any reason banner when no ?reason / ?error is present', () => {
    render(<EmailFirstLoginForm />)
    expect(screen.queryByTestId('reason-banner')).toBeNull()
  })

  it('does not render a destructive form-error banner on initial mount', () => {
    render(<EmailFirstLoginForm />)
    expect(screen.queryByTestId('form-error')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────
// 2. Stage 1 — local email validation
// ─────────────────────────────────────────────────────────────────────

describe('EmailFirstLoginForm — Stage 1 local email validation', () => {
  it('shows the inline "Enter a valid email address." error on empty submit and does not call the probe', async () => {
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    // Bypass jsdom's HTML5 form validation (required + type="email")
    // so our JS-level handler runs. The point of this test is to
    // pin the JS validator path, not the browser-level one.
    const emailInput = screen.getByLabelText(/work email/i) as HTMLInputElement
    emailInput.removeAttribute('required')
    emailInput.setAttribute('type', 'text')

    await user.click(screen.getByTestId('continue-button'))

    expect(await screen.findByTestId('form-error')).toHaveTextContent(
      /enter a valid email address/i,
    )
    expect(checkSSOMock).not.toHaveBeenCalled()
  })

  it('shows the inline error for a malformed email and does not call the probe', async () => {
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    // Bypass the browser's native HTML5 email-format validation —
    // it would short-circuit form submission before our handler
    // runs. We use fireEvent on the form directly to exercise the
    // JS-level validator independently.
    const emailInput = screen.getByLabelText(/work email/i) as HTMLInputElement
    await user.type(emailInput, 'not-an-email')

    // Prevent the browser-level validation from blocking submit
    // (jsdom honors `required`/`type=email`).
    emailInput.removeAttribute('required')
    emailInput.setAttribute('type', 'text')

    await user.click(screen.getByTestId('continue-button'))

    expect(await screen.findByTestId('form-error')).toHaveTextContent(
      /enter a valid email address/i,
    )
    expect(checkSSOMock).not.toHaveBeenCalled()
  })

  it('clears the inline error when a previously-failed submit is followed by a valid one', async () => {
    checkSSOMock.mockResolvedValueOnce({ required: false })
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    // Same HTML5-bypass as the other Stage-1 validation tests: drop
    // required + change type so jsdom doesn't short-circuit submit.
    const emailInput = screen.getByLabelText(/work email/i) as HTMLInputElement
    emailInput.removeAttribute('required')
    emailInput.setAttribute('type', 'text')

    // Failing submit (empty input)
    await user.click(screen.getByTestId('continue-button'))
    expect(await screen.findByTestId('form-error')).toBeInTheDocument()

    // Type a valid email and submit again
    await user.type(emailInput, 'user@example.com')
    await user.click(screen.getByTestId('continue-button'))

    // We advanced to Stage 2 — error should be cleared and Stage 2
    // form rendered.
    expect(await screen.findByTestId('password-stage-form')).toBeInTheDocument()
    expect(screen.queryByTestId('form-error')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────
// 3. Stage 1 → Stage 2 (no SSO)
// ─────────────────────────────────────────────────────────────────────

describe('EmailFirstLoginForm — Stage 1 → Stage 2 (no SSO)', () => {
  it('advances to Stage 2 with password-only when probe returns { required: false } (no orgSlug)', async () => {
    checkSSOMock.mockResolvedValueOnce({ required: false })
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await user.type(screen.getByLabelText(/work email/i), 'user@example.com')
    await user.click(screen.getByTestId('continue-button'))

    expect(await screen.findByTestId('password-stage-form')).toBeInTheDocument()
    expect(checkSSOMock).toHaveBeenCalledWith('user@example.com')
    expect(screen.queryByTestId('sso-button')).toBeNull()
  })

  it('shows the email read-only with an Edit button on Stage 2', async () => {
    checkSSOMock.mockResolvedValueOnce({ required: false })
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await user.type(screen.getByLabelText(/work email/i), 'user@example.com')
    await user.click(screen.getByTestId('continue-button'))

    const readOnly = await screen.findByTestId('email-readonly')
    expect(readOnly).toHaveTextContent('user@example.com')
    expect(screen.getByTestId('edit-email-button')).toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────
// 4. Stage 1 → Stage 2 (hybrid SSO)
// ─────────────────────────────────────────────────────────────────────

describe('EmailFirstLoginForm — Stage 1 → Stage 2 (hybrid SSO)', () => {
  it('renders BOTH the SSO button AND the password field when probe returns { required: false, orgSlug }', async () => {
    checkSSOMock.mockResolvedValueOnce({
      required: false,
      orgSlug: 'acme-corp',
    })
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await user.type(screen.getByLabelText(/work email/i), 'jane@acme.com')
    await user.click(screen.getByTestId('continue-button'))

    expect(await screen.findByTestId('sso-button')).toBeInTheDocument()
    // Visible password input is the one inside Stage 2 form (not the
    // hidden autofill stub from Stage 1, which is no longer in the
    // DOM after stage transition).
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument()
  })

  it('SSO button click navigates to /sso/start?org=<slug>&next=/app/projects', async () => {
    checkSSOMock.mockResolvedValueOnce({
      required: false,
      orgSlug: 'acme-corp',
    })
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await user.type(screen.getByLabelText(/work email/i), 'jane@acme.com')
    await user.click(screen.getByTestId('continue-button'))

    await user.click(await screen.findByTestId('sso-button'))

    expect(locationHrefSpy.value).toBe(
      '/sso/start?org=acme-corp&next=%2Fapp%2Fprojects',
    )
  })

  it('SSO button preserves a same-origin ?redirect= as the next= param', async () => {
    setSearchParams('redirect=/app/projects/abc')
    checkSSOMock.mockResolvedValueOnce({
      required: false,
      orgSlug: 'acme-corp',
    })
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await user.type(screen.getByLabelText(/work email/i), 'jane@acme.com')
    await user.click(screen.getByTestId('continue-button'))
    await user.click(await screen.findByTestId('sso-button'))

    expect(locationHrefSpy.value).toBe(
      '/sso/start?org=acme-corp&next=%2Fapp%2Fprojects%2Fabc',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// 5. Stage 1 → /sso/start (strict SSO)
// ─────────────────────────────────────────────────────────────────────

describe('EmailFirstLoginForm — Stage 1 → /sso/start (strict SSO)', () => {
  it('redirects to /sso/start with org+next when probe returns { required: true, orgSlug }', async () => {
    checkSSOMock.mockResolvedValueOnce({
      required: true,
      orgSlug: 'strict-co',
    })
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await user.type(screen.getByLabelText(/work email/i), 'kaan@strict.co')
    await user.click(screen.getByTestId('continue-button'))

    await waitFor(() => {
      expect(locationHrefSpy.value).toBe(
        '/sso/start?org=strict-co&next=%2Fapp%2Fprojects',
      )
    })
    // Did NOT advance to Stage 2 — page is leaving.
    expect(screen.queryByTestId('password-stage-form')).toBeNull()
  })

  it('strict-SSO redirect drops a //evil.com redirect query param (open-redirect protection)', async () => {
    setSearchParams('redirect=//evil.com/steal')
    checkSSOMock.mockResolvedValueOnce({
      required: true,
      orgSlug: 'strict-co',
    })
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await user.type(screen.getByLabelText(/work email/i), 'kaan@strict.co')
    await user.click(screen.getByTestId('continue-button'))

    await waitFor(() => {
      expect(locationHrefSpy.value).toBe(
        '/sso/start?org=strict-co&next=%2Fapp%2Fprojects',
      )
    })
  })

  it('URL-encodes a slug containing dashes correctly', async () => {
    checkSSOMock.mockResolvedValueOnce({
      required: true,
      orgSlug: 'big-bank-co',
    })
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await user.type(screen.getByLabelText(/work email/i), 'kaan@bigbank.co')
    await user.click(screen.getByTestId('continue-button'))

    await waitFor(() => {
      expect(locationHrefSpy.value).toMatch(/^\/sso\/start\?org=big-bank-co&/)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────
// 6. Stage 2 — password submit success
// ─────────────────────────────────────────────────────────────────────

describe('EmailFirstLoginForm — Stage 2 password submit success', () => {
  async function advanceToStage2WithoutSso(user: ReturnType<typeof userEvent.setup>) {
    checkSSOMock.mockResolvedValueOnce({ required: false })
    await user.type(screen.getByLabelText(/work email/i), 'user@example.com')
    await user.click(screen.getByTestId('continue-button'))
    await screen.findByTestId('password-stage-form')
  }

  it('calls signInWithPassword with email + password on submit', async () => {
    signInWithPasswordMock.mockResolvedValueOnce({ error: null })
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await advanceToStage2WithoutSso(user)
    await user.type(screen.getByLabelText(/^password/i), 'hunter2')
    await user.click(screen.getByTestId('signin-button'))

    await waitFor(() => {
      expect(signInWithPasswordMock).toHaveBeenCalledWith({
        email: 'user@example.com',
        password: 'hunter2',
      })
    })
  })

  it('on success, calls router.push("/app/projects") and router.refresh()', async () => {
    signInWithPasswordMock.mockResolvedValueOnce({ error: null })
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await advanceToStage2WithoutSso(user)
    await user.type(screen.getByLabelText(/^password/i), 'hunter2')
    await user.click(screen.getByTestId('signin-button'))

    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith('/app/projects')
    })
    expect(routerRefreshMock).toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────
// 7. Stage 2 — password submit error mapping
// ─────────────────────────────────────────────────────────────────────

describe('EmailFirstLoginForm — Stage 2 error mapping', () => {
  async function submitWithSignInError(message: string) {
    signInWithPasswordMock.mockResolvedValueOnce({
      error: { message },
    })
    const user = userEvent.setup()
    checkSSOMock.mockResolvedValueOnce({ required: false })
    render(<EmailFirstLoginForm />)

    await user.type(screen.getByLabelText(/work email/i), 'user@example.com')
    await user.click(screen.getByTestId('continue-button'))
    await screen.findByTestId('password-stage-form')
    await user.type(screen.getByLabelText(/^password/i), 'hunter2')
    await user.click(screen.getByTestId('signin-button'))
  }

  it('"Invalid login credentials" → "Invalid email or password. Please try again."', async () => {
    await submitWithSignInError('Invalid login credentials')
    expect(await screen.findByTestId('form-error')).toHaveTextContent(
      /invalid email or password\. please try again\./i,
    )
  })

  it('"Email not confirmed" → verification-link copy', async () => {
    await submitWithSignInError('Email not confirmed')
    expect(await screen.findByTestId('form-error')).toHaveTextContent(
      /verify your email address/i,
    )
  })

  it('any other error → generic "An error occurred. Please try again."', async () => {
    await submitWithSignInError('GoTrue: 500 Internal Server Error')
    expect(await screen.findByTestId('form-error')).toHaveTextContent(
      /an error occurred\. please try again\./i,
    )
  })

  it('after an error, the Sign-in button is re-enabled (loading=false on error path — Bug 3 fix)', async () => {
    await submitWithSignInError('Invalid login credentials')
    await screen.findByTestId('form-error')
    expect(screen.getByTestId('signin-button')).not.toBeDisabled()
  })
})

// ─────────────────────────────────────────────────────────────────────
// 8. Stage 2 — Edit returns to Stage 1 and clears password
// ─────────────────────────────────────────────────────────────────────

describe('EmailFirstLoginForm — Edit affordance', () => {
  it('clicking Edit returns to Stage 1 and clears the password input', async () => {
    checkSSOMock.mockResolvedValueOnce({ required: false })
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await user.type(screen.getByLabelText(/work email/i), 'user@example.com')
    await user.click(screen.getByTestId('continue-button'))
    await screen.findByTestId('password-stage-form')

    await user.type(screen.getByLabelText(/^password/i), 'hunter2')
    await user.click(screen.getByTestId('edit-email-button'))

    expect(await screen.findByTestId('email-stage-form')).toBeInTheDocument()
    expect(screen.queryByTestId('password-stage-form')).toBeNull()

    // Re-advance to Stage 2 with a different orgSlug — the password
    // should be empty (proving the password state was cleared, not
    // hidden).
    checkSSOMock.mockResolvedValueOnce({
      required: false,
      orgSlug: 'different-co',
    })
    await user.click(screen.getByTestId('continue-button'))
    await screen.findByTestId('password-stage-form')

    expect(
      (screen.getByLabelText(/^password/i) as HTMLInputElement).value,
    ).toBe('')
  })

  it('Edit is disabled while loading (prevents stage thrash)', async () => {
    // Hold the probe open so the form stays in `loading=true` state.
    let resolveProbe!: (v: { required: boolean }) => void
    checkSSOMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveProbe = res
      }),
    )
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await user.type(screen.getByLabelText(/work email/i), 'user@example.com')
    await user.click(screen.getByTestId('continue-button'))

    // Still on Stage 1, but loading=true — Continue is disabled. We
    // can't test Edit yet (we're not on Stage 2 yet); resolve to
    // advance.
    resolveProbe({ required: false })
    await screen.findByTestId('password-stage-form')

    // Stage 2 reached. Now hold the next signInWithPassword open and
    // assert Edit is disabled.
    let resolveSignIn!: (v: { error: null }) => void
    signInWithPasswordMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveSignIn = res
      }),
    )
    await user.type(screen.getByLabelText(/^password/i), 'hunter2')
    await user.click(screen.getByTestId('signin-button'))

    expect(screen.getByTestId('edit-email-button')).toBeDisabled()

    resolveSignIn({ error: null })
  })
})

// ─────────────────────────────────────────────────────────────────────
// 9. Reason-code rendering for all 14 codes
// ─────────────────────────────────────────────────────────────────────

describe('EmailFirstLoginForm — reason-code banner rendering', () => {
  // Iterate every entry in LOGIN_REASONS. This is the closest we can
  // get to a parametrized "every emitted code → banner shows the
  // expected copy" assertion without re-listing the codes locally
  // (which would drift). The login-reason-codes-source test already
  // pinned that LOGIN_REASONS keys equal EXPECTED_EMITTED_CODES, so
  // covering the map covers the codebase.
  for (const [code, entry] of Object.entries(LOGIN_REASONS)) {
    it(`?reason=${code} renders a banner with the expected copy + variant`, () => {
      // Use ?reason=… for every code here. In practice
      // `auth_callback_error` is emitted on the `?error=` channel,
      // but the component reads `reason ?? error` so either channel
      // surfaces the same banner — covered by the dedicated test
      // below.
      setSearchParams(`reason=${code}`)
      render(<EmailFirstLoginForm />)
      const banner = screen.getByTestId('reason-banner')
      expect(banner).toHaveTextContent(entry.copy)
      if (entry.severity === 'error') {
        expect(banner).toHaveAttribute('role', 'alert')
      } else {
        expect(banner).not.toHaveAttribute('role')
      }
    })
  }

  it('?error=auth_callback_error renders the banner via the error channel', () => {
    setSearchParams('error=auth_callback_error')
    render(<EmailFirstLoginForm />)
    const banner = screen.getByTestId('reason-banner')
    expect(banner).toHaveTextContent(LOGIN_REASONS.auth_callback_error.copy)
  })

  it('?reason=<unknown_code> does NOT render a banner (silent ignore)', () => {
    setSearchParams('reason=this_is_not_a_real_code')
    render(<EmailFirstLoginForm />)
    expect(screen.queryByTestId('reason-banner')).toBeNull()
  })

  it('reason banner is dismissed once the user advances to Stage 2', async () => {
    setSearchParams('reason=timeout')
    checkSSOMock.mockResolvedValueOnce({ required: false })
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    expect(screen.getByTestId('reason-banner')).toBeInTheDocument()

    await user.type(screen.getByLabelText(/work email/i), 'user@example.com')
    await user.click(screen.getByTestId('continue-button'))
    await screen.findByTestId('password-stage-form')

    expect(screen.queryByTestId('reason-banner')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────
// 10. ?redirect= and ?returnTo= preservation through the flow
// ─────────────────────────────────────────────────────────────────────

describe('EmailFirstLoginForm — redirect/returnTo preservation', () => {
  it('Stage 2 password success preserves a same-origin ?redirect=', async () => {
    setSearchParams('redirect=/app/projects/abc?tab=schemas')
    checkSSOMock.mockResolvedValueOnce({ required: false })
    signInWithPasswordMock.mockResolvedValueOnce({ error: null })
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await user.type(screen.getByLabelText(/work email/i), 'user@example.com')
    await user.click(screen.getByTestId('continue-button'))
    await screen.findByTestId('password-stage-form')
    await user.type(screen.getByLabelText(/^password/i), 'hunter2')
    await user.click(screen.getByTestId('signin-button'))

    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith(
        '/app/projects/abc?tab=schemas',
      )
    })
  })

  it('Stage 2 password success reads ?returnTo= when ?redirect= is absent (Bug 1 fix)', async () => {
    setSearchParams('returnTo=/app/projects/xyz')
    checkSSOMock.mockResolvedValueOnce({ required: false })
    signInWithPasswordMock.mockResolvedValueOnce({ error: null })
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await user.type(screen.getByLabelText(/work email/i), 'user@example.com')
    await user.click(screen.getByTestId('continue-button'))
    await screen.findByTestId('password-stage-form')
    await user.type(screen.getByLabelText(/^password/i), 'hunter2')
    await user.click(screen.getByTestId('signin-button'))

    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith('/app/projects/xyz')
    })
  })

  it('Stage 2 password success drops a //evil.com redirect (Bug 2 fix)', async () => {
    setSearchParams('redirect=//evil.com/steal')
    checkSSOMock.mockResolvedValueOnce({ required: false })
    signInWithPasswordMock.mockResolvedValueOnce({ error: null })
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await user.type(screen.getByLabelText(/work email/i), 'user@example.com')
    await user.click(screen.getByTestId('continue-button'))
    await screen.findByTestId('password-stage-form')
    await user.type(screen.getByLabelText(/^password/i), 'hunter2')
    await user.click(screen.getByTestId('signin-button'))

    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith('/app/projects')
    })
  })

  it('Stage 2 password success drops a CRLF-injection redirect', async () => {
    setSearchParams('redirect=' + encodeURIComponent('/app\r\nSet-Cookie: x'))
    checkSSOMock.mockResolvedValueOnce({ required: false })
    signInWithPasswordMock.mockResolvedValueOnce({ error: null })
    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await user.type(screen.getByLabelText(/work email/i), 'user@example.com')
    await user.click(screen.getByTestId('continue-button'))
    await screen.findByTestId('password-stage-form')
    await user.type(screen.getByLabelText(/^password/i), 'hunter2')
    await user.click(screen.getByTestId('signin-button'))

    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith('/app/projects')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────
// 11. Probe failure fail-soft (checkSSOEnabledForEmail throws)
// ─────────────────────────────────────────────────────────────────────

describe('EmailFirstLoginForm — probe failure fail-soft', () => {
  it('falls through to Stage 2 password-only when checkSSOEnabledForEmail throws', async () => {
    // Suppress the console.warn the component emits on probe failure
    // so the test output stays clean.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    checkSSOMock.mockRejectedValueOnce(new Error('network fetch failed'))

    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await user.type(screen.getByLabelText(/work email/i), 'user@example.com')
    await user.click(screen.getByTestId('continue-button'))

    expect(await screen.findByTestId('password-stage-form')).toBeInTheDocument()
    // No destructive form-error banner — the probe failure is silent.
    expect(screen.queryByTestId('form-error')).toBeNull()
    // No SSO button (we treat the failure as "no SSO" so the user
    // can still sign in with a password).
    expect(screen.queryByTestId('sso-button')).toBeNull()
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })
})

// ─────────────────────────────────────────────────────────────────────
// 12. Submit-while-loading guard
// ─────────────────────────────────────────────────────────────────────

describe('EmailFirstLoginForm — submit-while-loading guard', () => {
  it('Continue button is disabled while the probe is in flight', async () => {
    let resolveProbe!: (v: { required: boolean }) => void
    checkSSOMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveProbe = res
      }),
    )

    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await user.type(screen.getByLabelText(/work email/i), 'user@example.com')
    await user.click(screen.getByTestId('continue-button'))

    // Probe still pending — button should be disabled and label
    // should change to the loading state.
    await waitFor(() => {
      expect(screen.getByTestId('continue-button')).toBeDisabled()
    })
    expect(screen.getByTestId('continue-button')).toHaveTextContent(/checking/i)

    resolveProbe({ required: false })
    await screen.findByTestId('password-stage-form')
  })

  it('Sign-in button is disabled while signInWithPassword is in flight', async () => {
    checkSSOMock.mockResolvedValueOnce({ required: false })

    let resolveSignIn!: (v: { error: null }) => void
    signInWithPasswordMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveSignIn = res
      }),
    )

    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await user.type(screen.getByLabelText(/work email/i), 'user@example.com')
    await user.click(screen.getByTestId('continue-button'))
    await screen.findByTestId('password-stage-form')

    await user.type(screen.getByLabelText(/^password/i), 'hunter2')
    await user.click(screen.getByTestId('signin-button'))

    await waitFor(() => {
      expect(screen.getByTestId('signin-button')).toBeDisabled()
    })
    expect(screen.getByTestId('signin-button')).toHaveTextContent(/signing in/i)

    resolveSignIn({ error: null })
  })

  it('clicking Continue twice rapidly does not trigger two probe calls', async () => {
    let resolveProbe!: (v: { required: boolean }) => void
    checkSSOMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveProbe = res
      }),
    )

    const user = userEvent.setup()
    render(<EmailFirstLoginForm />)

    await user.type(screen.getByLabelText(/work email/i), 'user@example.com')
    await user.click(screen.getByTestId('continue-button'))
    await user.click(screen.getByTestId('continue-button'))

    // The second click hits a disabled button — no extra invocation.
    expect(checkSSOMock).toHaveBeenCalledTimes(1)

    resolveProbe({ required: false })
    await screen.findByTestId('password-stage-form')
  })
})
