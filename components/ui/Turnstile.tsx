'use client'

/**
 * Settle's reusable Cloudflare Turnstile widget.
 *
 * Thin wrapper around @marsidev/react-turnstile that:
 *   - Pulls NEXT_PUBLIC_TURNSTILE_SITE_KEY at module scope so call sites
 *     don't have to pass it.
 *   - Surfaces a minimal callback API: onVerify(token), onError, onExpire.
 *   - Exposes a ref-based reset() so a form can re-challenge after a
 *     server-side rejection without remounting the widget.
 *   - Provides a dev convenience: when the site key is unset and
 *     NODE_ENV !== 'production', renders a dashed placeholder and emits
 *     a 'dev-bypass-token' once. The actual security boundary is the
 *     server-side verifyTurnstileToken in lib/auth/turnstile.ts, which
 *     independently bypasses in dev.
 *
 * In production with a missing site key, the widget renders nothing
 * and logs once. The server check rejects the submission anyway.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react'
import {
  Turnstile as MarsidevTurnstile,
  type TurnstileInstance,
} from '@marsidev/react-turnstile'
import { cn } from '@/lib/utils/cn'

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? ''
const IS_PRODUCTION = process.env.NODE_ENV === 'production'

export const TURNSTILE_DEV_BYPASS_TOKEN = 'dev-bypass-token'

export interface TurnstileProps {
  onVerify: (token: string) => void
  onError?: () => void
  onExpire?: () => void
  theme?: 'light' | 'dark' | 'auto'
  size?: 'normal' | 'flexible' | 'compact'
  className?: string
}

export interface TurnstileHandle {
  reset: () => void
}

let prodMissingKeyWarned = false

function warnProdMissingKeyOnce(): void {
  if (prodMissingKeyWarned) return
  prodMissingKeyWarned = true
  console.error(
    '[turnstile] NEXT_PUBLIC_TURNSTILE_SITE_KEY is not set in production. ' +
      'The widget will not render and submissions will be rejected by the server.',
  )
}

export const Turnstile = forwardRef<TurnstileHandle, TurnstileProps>(function Turnstile(
  { onVerify, onError, onExpire, theme = 'auto', size = 'flexible', className },
  ref,
) {
  const innerRef = useRef<TurnstileInstance | undefined>(undefined)
  const onVerifyRef = useRef(onVerify)
  useEffect(() => {
    onVerifyRef.current = onVerify
  }, [onVerify])

  useImperativeHandle(
    ref,
    () => ({
      reset: () => {
        innerRef.current?.reset()
      },
    }),
    [],
  )

  // Dev convenience path: no site key, not production. Emit a stable
  // bypass token so calling forms can submit during local development.
  // The server verifier independently bypasses, so this is purely UX.
  useEffect(() => {
    if (SITE_KEY || IS_PRODUCTION) return
    const t = setTimeout(() => {
      onVerifyRef.current(TURNSTILE_DEV_BYPASS_TOKEN)
    }, 100)
    return () => clearTimeout(t)
  }, [])

  if (!SITE_KEY) {
    if (IS_PRODUCTION) {
      warnProdMissingKeyOnce()
      return null
    }
    return (
      <div
        className={cn(
          'rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-3 text-center text-xs text-gray-500',
          className,
        )}
        role="status"
        aria-label="Turnstile disabled (development)"
      >
        Turnstile disabled (dev)
      </div>
    )
  }

  return (
    <MarsidevTurnstile
      ref={innerRef}
      siteKey={SITE_KEY}
      onSuccess={onVerify}
      onError={onError}
      onExpire={onExpire}
      options={{ theme, size }}
      className={className}
    />
  )
})
