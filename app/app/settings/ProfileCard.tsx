'use client'

import { useState, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { Upload } from '@/components/icons'
import { updateProfileName, uploadAvatar } from '@/lib/actions/profile'
import { useEditableField } from '@/lib/hooks/useEditableField'

function getInitials(name: string | null, email: string): string {
  if (name) {
    return name
      .split(' ')
      .map((part) => part[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase()
  }
  return (email[0] ?? '?').toUpperCase()
}

interface ProfileCardProps {
  initialName: string | null
  email: string
  initialAvatarUrl: string | null
  isVerified: boolean
  orgName: string
  createdAt: string
}

export function ProfileCard({
  initialName,
  email,
  initialAvatarUrl,
  isVerified,
  orgName,
  createdAt,
}: ProfileCardProps) {
  const [displayName, setDisplayName] = useState(initialName ?? '')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(initialAvatarUrl)

  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)

  // Display-name edit machinery: state lifted into useEditableField (PR F).
  // The hook expects `{success, error}` results; updateProfileName throws on
  // error and resolves with `{name}` on success — wrap inline to fit.
  const nameField = useEditableField({
    initialValue: displayName,
    onSave: async (draft) => {
      try {
        const result = await updateProfileName(draft)
        setDisplayName(result.name)
        return { success: true }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to save',
        }
      }
    },
  })

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setUploadingAvatar(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const result = await uploadAvatar(formData)
      setAvatarUrl(result.avatarUrl)
    } catch {
      // Could add error state here if needed
    } finally {
      setUploadingAvatar(false)
      e.target.value = ''
    }
  }

  const initials = getInitials(displayName || null, email)

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <div className="flex items-center gap-4">
        {/* Avatar */}
        <div
          className="relative group cursor-pointer flex-shrink-0"
          onClick={() => avatarInputRef.current?.click()}
        >
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={displayName || email}
              className="w-14 h-14 rounded-full object-cover"
            />
          ) : (
            <div className="w-14 h-14 rounded-full bg-primary/10 text-primary flex items-center justify-center text-lg font-semibold">
              {initials}
            </div>
          )}
          <div className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
            {uploadingAvatar ? (
              <Loader2 className="w-5 h-5 text-white animate-spin" />
            ) : (
              <Upload className="w-4 h-4 text-white" />
            )}
          </div>
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={handleAvatarUpload}
          />
        </div>

        {/* Name + Email */}
        <div className="flex-1 min-w-0">
          {nameField.isEditing ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={nameField.draft}
                onChange={(e) => nameField.setDraft(e.target.value)}
                className="h-8 px-3 text-sm border border-settle-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                autoFocus
                onKeyDown={nameField.handleKeyDown}
              />
              <button
                onClick={nameField.save}
                disabled={!nameField.canSave}
                className="h-8 px-3 text-xs font-medium bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {nameField.isSaving ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={nameField.cancel}
                className="h-8 px-3 text-xs font-medium text-settle-slate-600 border border-settle-slate-200 rounded-lg hover:bg-settle-slate-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-gray-900 truncate">
                {displayName || email}
              </p>
              <button
                onClick={nameField.startEdit}
                className="text-xs text-settle-slate-500 hover:text-settle-slate-700 border border-settle-slate-200 rounded-lg px-2.5 py-1 transition-colors flex-shrink-0"
              >
                Edit
              </button>
            </div>
          )}
          {nameField.error && (
            <p className="text-xs text-red-600 mt-1">{nameField.error}</p>
          )}
          <p className="text-sm text-gray-500 truncate mt-0.5">{email}</p>
        </div>
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-4 mt-4 pt-4 border-t border-gray-100">
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Organization</p>
          <p className="text-sm text-gray-900">{orgName}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Account created</p>
          <p className="text-sm text-gray-900">{createdAt}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Email status</p>
          {isVerified ? (
            <p className="text-sm font-medium text-green-600">Verified</p>
          ) : (
            <p className="text-sm font-medium text-amber-600">Unverified</p>
          )}
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Plan</p>
          <p className="text-sm font-medium text-settle-slate-900">Enterprise</p>
        </div>
      </div>
    </div>
  )
}
