'use client'

import * as React from 'react'

// Empty state shown when `sso_enabled = false` for the active org.
//
// Replaces the four data cards with a single bordered panel — fewer
// "Not set"s, less empty-list noise, and one clear CTA. Setup itself
// is gated to platform admins (Settle staff) per migration 070's
// `platform_admins_only` policies on `sso_providers` and
// `sso_domains`, so the CTA is intentionally a contact-support link
// rather than a self-serve button.

export function SsoEmptyState() {
  return (
    <div className="px-8 py-6 max-w-3xl">
      <section
        className="bg-white border border-gray-200 rounded-xl px-8 py-10 text-center"
        data-testid="sso-empty-state"
      >
        <div className="mx-auto w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center mb-4">
          <svg
            className="w-6 h-6 text-blue-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3Zm0 2c-2.67 0-8 1.34-8 4v3h16v-3c0-2.66-5.33-4-8-4Z"
            />
          </svg>
        </div>
        <h2 className="text-base font-semibold text-gray-900">
          Single sign-on isn&apos;t set up yet
        </h2>
        <p className="mt-2 text-sm text-gray-600 max-w-md mx-auto">
          SSO lets your team sign in with their existing identity provider
          (Okta, Microsoft Entra, Google, or any SAML 2.0 IdP). Get in touch
          and we&apos;ll help you set it up.
        </p>
        <div className="mt-5">
          <a
            href="mailto:info@usesettle.ai?subject=Enable%20SSO%20for%20my%20organization"
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            Contact support to enable SSO
          </a>
        </div>
      </section>
    </div>
  )
}
