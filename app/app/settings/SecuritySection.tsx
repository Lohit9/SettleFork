'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { changePassword } from '@/lib/actions/auth'
import { MFAEnrollment } from '@/components/app/settings/MFAEnrollment'

function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white border border-gray-200 rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-base font-semibold text-gray-900 mb-4">{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function SecuritySection() {
  const [showModal, setShowModal] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [isPending, startTransition] = useTransition()

  const handleSave = () => {
    setError(null)
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    startTransition(async () => {
      const result = await changePassword(newPassword)
      if (result.success) {
        setSuccess(true)
        setTimeout(() => {
          setShowModal(false)
          setNewPassword('')
          setConfirmPassword('')
          setSuccess(false)
        }, 1500)
      } else {
        setError(result.error ?? 'Something went wrong.')
      }
    })
  }

  const handleClose = () => {
    setShowModal(false)
    setNewPassword('')
    setConfirmPassword('')
    setError(null)
    setSuccess(false)
  }

  return (
    <>
      <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
        <div className="px-5 py-3.5 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-900">Password</p>
            <p className="text-xs text-gray-500 mt-0.5">Last changed: Never</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowModal(true)}
            className="border-gray-200 text-gray-700 hover:bg-gray-50 text-xs"
          >
            Change password
          </Button>
        </div>

        <div className="px-5 py-3.5 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-900">Two-factor authentication</p>
            <p className="text-xs text-gray-500 mt-0.5">Add an extra layer of security to your account</p>
          </div>
          <MFAEnrollment />
        </div>

        <div className="px-5 py-3.5 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-900">Active sessions</p>
            <p className="text-xs text-gray-500 mt-0.5">1 active session (this device)</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled
            className="border-gray-200 text-gray-700 text-xs opacity-50 cursor-not-allowed"
          >
            Manage
          </Button>
        </div>

        <div className="px-5 py-3.5 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-900">Session timeout</p>
            <p className="text-xs text-gray-500 mt-0.5">Sessions automatically expire after 30 minutes of inactivity</p>
          </div>
          <span className="text-sm text-gray-500 tabular-nums">30 minutes</span>
        </div>
      </div>

      {showModal && (
        <Modal title="Change password" onClose={handleClose}>
          {success ? (
            <div className="py-4 text-center">
              <p className="text-sm text-green-600 font-medium">Password updated successfully.</p>
            </div>
          ) : (
            <>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="new-password" className="text-sm text-gray-700 mb-1.5 block">
                    New password
                  </Label>
                  <Input
                    id="new-password"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                    className="w-full"
                  />
                </div>
                <div>
                  <Label htmlFor="confirm-password" className="text-sm text-gray-700 mb-1.5 block">
                    Confirm password
                  </Label>
                  <Input
                    id="confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repeat new password"
                    className="w-full"
                  />
                </div>
              </div>

              {error && (
                <div className="mt-3 p-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
                  {error}
                </div>
              )}

              <div className="mt-5 flex justify-end gap-2">
                <Button variant="ghost" onClick={handleClose} className="text-gray-600">
                  Cancel
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={!newPassword || !confirmPassword || isPending}
                  className="bg-[#4F46E5] hover:bg-[#4338CA] text-white disabled:opacity-50"
                >
                  {isPending ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  )
}
