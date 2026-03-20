'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { deleteAccount } from '@/lib/actions/auth'

export function DangerZoneSection() {
  const [showModal, setShowModal] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleDelete = () => {
    setError(null)
    startTransition(async () => {
      const result = await deleteAccount()
      if (result.success) {
        window.location.href = '/login'
      } else {
        setError(result.error ?? 'Something went wrong. Please try again.')
      }
    })
  }

  return (
    <>
      <div className="bg-white border border-red-200 rounded-xl p-5">
        <p className="text-base font-medium text-red-600 mb-3">Danger zone</p>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-900">Delete account</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Permanently delete your account and all associated data
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowModal(true)}
            className="border-red-300 text-red-600 hover:bg-red-50 hover:border-red-400 text-xs flex-shrink-0"
          >
            Delete account
          </Button>
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-gray-200 rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-2">Are you sure?</h2>
            <p className="text-sm text-gray-600 mb-5">
              This will permanently delete your account and all your migration projects. This action
              cannot be undone.
            </p>

            {error && (
              <div className="mb-4 p-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setShowModal(false)
                  setError(null)
                }}
                disabled={isPending}
                className="text-gray-600"
              >
                Cancel
              </Button>
              <Button
                onClick={handleDelete}
                disabled={isPending}
                className="bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
              >
                {isPending ? 'Deleting…' : 'Delete my account'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
