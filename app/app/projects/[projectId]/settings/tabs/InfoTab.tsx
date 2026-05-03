'use client'

import { useState, useTransition } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { updateProject, updateProjectLabels } from '@/lib/actions/projects'
import type { ProjectSettingsInfo } from '../ProjectSettingsContent'

// Project info card. Read-only by default; editors can toggle into an inline
// edit form for project name, source label, target label. Created stays
// read-only. Mirrors the ProfileCard / OrganizationSettingsContent state
// machine: useState + useTransition + inline red error / inline green
// success (auto-dismiss). No toast, no Zod, no react-hook-form.
//
// Save sequencing is intentional: name first, labels second, abort on first
// failure. If name commits but labels fail, name persists on the server,
// the labels error surfaces, and edit mode stays open for retry. Idempotent
// retries are safe — the second pass will re-call updateProject if its
// stale-prop comparison still differs (server returns success, sequence
// continues to labels).
export default function InfoTab({ info }: { info: ProjectSettingsInfo }) {
  const params = useParams()
  const projectId = params?.projectId as string
  const router = useRouter()
  const { can, isReady } = useProjectRole(projectId)
  const canEdit = isReady && can('edit')

  const [isEditing, setIsEditing] = useState(false)
  const [name, setName] = useState(info.projectName)
  const [sourceLabel, setSourceLabel] = useState(info.sourceSystem ?? '')
  const [targetLabel, setTargetLabel] = useState(info.targetSystem ?? '')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [isPending, startTransition] = useTransition()

  const formattedDate = new Date(info.createdAt).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })

  const trimmedName = name.trim()
  const trimmedSource = sourceLabel.trim()
  const trimmedTarget = targetLabel.trim()
  const nameChanged = trimmedName !== info.projectName
  const sourceChanged = trimmedSource !== (info.sourceSystem ?? '')
  const targetChanged = trimmedTarget !== (info.targetSystem ?? '')
  const hasChanges = nameChanged || sourceChanged || targetChanged
  const allFilled = trimmedName !== '' && trimmedSource !== '' && trimmedTarget !== ''
  const canSave = !isPending && hasChanges && allFilled

  const enterEditMode = () => {
    setName(info.projectName)
    setSourceLabel(info.sourceSystem ?? '')
    setTargetLabel(info.targetSystem ?? '')
    setError(null)
    setSuccess(false)
    setIsEditing(true)
  }

  const cancel = () => {
    setName(info.projectName)
    setSourceLabel(info.sourceSystem ?? '')
    setTargetLabel(info.targetSystem ?? '')
    setError(null)
    setSuccess(false)
    setIsEditing(false)
  }

  const save = () => {
    setError(null)
    setSuccess(false)
    startTransition(async () => {
      if (nameChanged) {
        const result = await updateProject(projectId, { name: trimmedName })
        if (!result.success) {
          setError(result.error ?? 'Failed to update name.')
          return
        }
      }
      if (sourceChanged || targetChanged) {
        const result = await updateProjectLabels(projectId, trimmedSource, trimmedTarget)
        if (!result.success) {
          setError(result.error ?? 'Failed to update labels.')
          return
        }
      }
      setIsEditing(false)
      setSuccess(true)
      router.refresh()
      setTimeout(() => setSuccess(false), 3000)
    })
  }

  const fields: Array<{ label: string; value: string }> = [
    { label: 'Project', value: info.projectName },
    { label: 'Source System', value: info.sourceSystem ?? '—' },
    { label: 'Target System', value: info.targetSystem ?? '—' },
    { label: 'Created', value: formattedDate },
  ]

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Project info</h3>
        {!isEditing && canEdit && !info.isArchived && (
          <button
            onClick={enterEditMode}
            className="text-xs text-settle-slate-500 hover:text-settle-slate-700 border border-settle-slate-200 rounded-lg px-2.5 py-1 transition-colors"
          >
            Edit
          </button>
        )}
      </div>

      {isEditing ? (
        <div className="px-5 py-4 space-y-4">
          <div>
            <Label className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1 block">
              Project
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              maxLength={120}
              className="max-w-md"
            />
          </div>
          <div>
            <Label className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1 block">
              Source System
            </Label>
            <Input
              value={sourceLabel}
              onChange={(e) => setSourceLabel(e.target.value)}
              maxLength={80}
              className="max-w-md"
            />
          </div>
          <div>
            <Label className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1 block">
              Target System
            </Label>
            <Input
              value={targetLabel}
              onChange={(e) => setTargetLabel(e.target.value)}
              maxLength={80}
              className="max-w-md"
            />
          </div>
          <div>
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">Created</p>
            <p className="text-sm text-gray-900">{formattedDate}</p>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
            <Button
              variant="ghost"
              size="sm"
              onClick={cancel}
              disabled={isPending}
              className="text-gray-600"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={save}
              disabled={!canSave}
              className="bg-primary hover:bg-primary/90 text-white"
            >
              {isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="divide-y divide-gray-100">
            {fields.map((f) => (
              <div key={f.label} className="flex items-center px-5 py-3 gap-4">
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wide w-32 flex-shrink-0">
                  {f.label}
                </span>
                <span className="text-sm text-gray-900">{f.value}</span>
              </div>
            ))}
          </div>
          {success && (
            <div className="px-5 py-2 border-t border-gray-100">
              <p className="text-xs text-green-600">Project info updated successfully</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
