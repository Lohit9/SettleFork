'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { acceptInvite } from '@/lib/actions/org-invites'
import { signUpWithBotProtection } from '@/lib/actions/auth'
import type { OrgRole } from '@/lib/types/organizations'

const ROLE_LABELS: Record<OrgRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
}

const ROLE_COLORS: Record<OrgRole, string> = {
  owner: 'bg-purple-100 text-purple-700',
  admin: 'bg-blue-100 text-blue-700',
  editor: 'bg-green-100 text-green-700',
  viewer: 'bg-gray-100 text-gray-600',
}

interface InviteClientProps {
  token: string
  orgName: string
  role: OrgRole
  inviterName: string
  email: string
  isLoggedIn: boolean
  userId?: string
  emailExists?: boolean
}

export default function InviteClient({ token, orgName, role, inviterName, email, isLoggedIn, userId, emailExists = false }: InviteClientProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Signup form state
  const [fullName, setFullName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const handleAccept = () => {
    if (!userId) return
    setError(null)
    startTransition(async () => {
      const result = await acceptInvite(token, userId)
      if (result.error) {
        setError(result.error)
        return
      }
      router.push('/app/projects')
    })
  }

  const handleSignupAndJoin = (e: React.FormEvent) => {
    e.preventDefault()
    if (!fullName.trim() || !password) return
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    setError(null)
    startTransition(async () => {
      const result = await signUpWithBotProtection({
        fullName: fullName.trim(),
        email,
        password,
        inviteCode: '',
        inviteToken: token,
        website: '',
        loadedAt: String(Date.now() - 10000),
      })
      if (!result.success) {
        if (result.error?.toLowerCase().includes('already exists') || result.error?.toLowerCase().includes('already registered')) {
          setError(`An account with this email already exists. Please log in instead.`)
          // Surface the login link via the error state — user will see it below
        } else {
          setError(result.error ?? 'Failed to create account')
        }
        return
      }
      if (result.requiresEmailVerification) {
        router.push('/verify-email')
        return
      }
      router.push('/app/projects')
    })
  }

  return (
    <div>
      {/* Invite card */}
      <div className="text-center mb-6">
        <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-gray-900 mb-1">You&apos;re invited to join</h2>
        <p className="text-xl font-bold text-gray-900">{orgName}</p>
        <p className="text-sm text-gray-500 mt-2">
          {inviterName} invited you as{' '}
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ROLE_COLORS[role]}`}>
            {ROLE_LABELS[role]}
          </span>
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
          {(error.toLowerCase().includes('already exists') || error.toLowerCase().includes('already registered') || error.toLowerCase().includes('log in instead')) && (
            <span>
              {' '}
              <a href={`/login?redirect=/invite/${token}`} className="font-medium underline hover:text-red-900">
                Log in here
              </a>
            </span>
          )}
        </div>
      )}

      {isLoggedIn ? (
        /* State 1: Already logged in — show Accept button */
        <Button
          onClick={handleAccept}
          disabled={isPending}
          className="w-full bg-primary hover:bg-primary/90 text-white"
        >
          {isPending ? 'Joining...' : 'Accept Invite & Join'}
        </Button>
      ) : emailExists ? (
        /* State 2: Not logged in, but email has an existing account — prompt login */
        <>
          <div className="border-t border-gray-200 my-5" />
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800 mb-4">
            You already have a Settle account with this email address. Log in to accept this invite.
          </div>
          <a
            href={`/login?redirect=/invite/${token}`}
            className="flex items-center justify-center w-full h-10 px-4 rounded-lg bg-primary hover:bg-primary/90 text-white text-sm font-medium transition-colors"
          >
            Log In to Accept
          </a>
        </>
      ) : (
        /* State 3: Not logged in, new email — show signup form */
        <>
          <div className="border-t border-gray-200 my-5" />
          <p className="text-sm text-gray-600 mb-4 text-center">Create your account to join</p>

          <form onSubmit={handleSignupAndJoin} className="space-y-4">
            <div>
              <Label htmlFor="fullName" className="text-sm font-medium text-gray-700">Full name</Label>
              <Input
                id="fullName"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Jane Smith"
                required
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="email" className="text-sm font-medium text-gray-700">Email</Label>
              <Input
                id="email"
                value={email}
                disabled
                className="mt-1 bg-gray-50 text-gray-500"
              />
            </div>
            <div>
              <Label htmlFor="password" className="text-sm font-medium text-gray-700">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                required
                minLength={8}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="confirmPassword" className="text-sm font-medium text-gray-700">Confirm Password</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm your password"
                required
                className="mt-1"
              />
            </div>
            <Button
              type="submit"
              disabled={isPending || !fullName.trim() || password.length < 8 || !confirmPassword}
              className="w-full bg-primary hover:bg-primary/90 text-white"
            >
              {isPending ? 'Creating account...' : 'Create Account & Join'}
            </Button>
          </form>

          <p className="mt-4 text-center text-sm text-gray-500">
            Already have an account?{' '}
            <a href={`/login?redirect=/invite/${token}`} className="font-medium text-blue-600 hover:text-blue-700">
              Sign in
            </a>
          </p>
        </>
      )}
    </div>
  )
}
