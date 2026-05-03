'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Settings } from '@/components/icons'
import { deleteProject, markProjectComplete, reactivateProject, archiveProject } from '@/lib/actions/projects'
import { getExecutionPackageUrl } from '@/lib/actions/execution-package'
import { useProjectRole } from '@/lib/hooks/useProjectRole'

// ── types ──────────────────────────────────────────────────────────────────

export interface ProjectMenuProject {
  id: string
  name: string
  source_label: string
  target_label: string
  status: string
  completed_at?: string | null
}

interface ProjectMenuProps {
  project: ProjectMenuProject
  onUpdate?: () => void
}

// ── three-dot icon ─────────────────────────────────────────────────────────

function DotsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <circle cx="3" cy="8" r="1.5" />
      <circle cx="8" cy="8" r="1.5" />
      <circle cx="13" cy="8" r="1.5" />
    </svg>
  )
}

// ── main component ─────────────────────────────────────────────────────────

export function ProjectMenu({ project, onUpdate }: ProjectMenuProps) {
  const router = useRouter()
  const { can: canRole } = useProjectRole(project.id)
  const canEdit = canRole('edit')
  const canManage = canRole('manage')
  const [modal, setModal] = useState<'delete' | 'archive' | null>(null)

  const [archiveLoading, setArchiveLoading] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const [outputUrl, setOutputUrl] = useState<string | null | undefined>(undefined) // undefined = not yet checked, null = none

  const [isPending, startTransition] = useTransition()
  const [actionError, setActionError] = useState<string | null>(null)

  const refresh = () => {
    router.refresh()
    onUpdate?.()
  }

  const openModal = (m: 'delete' | 'archive') => {
    setActionError(null)
    if (m === 'archive') {
      setArchiveError(null)
      setOutputUrl(undefined)
      // Pre-check whether an execution package exists
      getExecutionPackageUrl(project.id).then((result) => {
        setOutputUrl(result.url ?? null)
      }).catch(() => setOutputUrl(null))
    }
    setModal(m)
  }

  const closeModal = () => setModal(null)

  // ── actions ──

  const handleToggleStatus = () => {
    startTransition(async () => {
      if (project.status === 'completed') {
        await reactivateProject(project.id)
      } else {
        await markProjectComplete(project.id)
      }
      refresh()
    })
  }

  const handleDelete = () => {
    setActionError(null)
    startTransition(async () => {
      const result = await deleteProject(project.id)
      if (!result.success) { setActionError(result.error ?? 'Failed to delete project'); return }
      closeModal()
      router.push('/app/projects')
      router.refresh()
    })
  }

  const handleArchive = async () => {
    setArchiveLoading(true)
    setArchiveError(null)
    const result = await archiveProject(project.id)
    setArchiveLoading(false)
    if (result.success) {
      closeModal()
      refresh()
    } else {
      setArchiveError(result.error ?? 'Failed to archive project')
    }
  }

  const isCompleted = project.status === 'completed'
  const isArchived = project.status === 'archived'

  // Hide the entire menu for viewers — no actionable items remain
  if (!canEdit && !canManage) return null

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="w-8 h-8 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            title="Project options"
          >
            <DotsIcon />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent className="w-52">
            {canEdit && (
              <DropdownMenuItem
                onSelect={() => router.push(`/app/projects/${project.id}/settings?tab=info`)}
              >
                <Settings className="w-4 h-4 flex-shrink-0" />
                Project settings
              </DropdownMenuItem>
            )}
            {!isArchived && (
              <>
                {canEdit && (
                  <DropdownMenuItem onSelect={handleToggleStatus}>
                    <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
                      {isCompleted
                        ? <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 8a6 6 0 0110.5-4M14 8a6 6 0 01-10.5 4"/><path d="M12 4l2 2-2 2M4 12l-2-2 2-2"/></svg>
                        : <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6"/><path d="M5 8l2 2 4-4"/></svg>
                      }
                    </span>
                    {isCompleted ? 'Reactivate' : 'Mark as completed'}
                  </DropdownMenuItem>
                )}
                {canManage && (
                  <DropdownMenuItem onSelect={() => openModal('archive')}>
                    <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 12V6l4-4h5l3 3v7a1 1 0 01-1 1H3a1 1 0 01-1-1z"/><path d="M6 2v4H2"/><path d="M8 9v3M8 7v.5"/></svg>
                    </span>
                    Archive project
                  </DropdownMenuItem>
                )}
                {(canEdit || canManage) && <DropdownMenuSeparator />}
              </>
            )}
            {canManage && (
              <DropdownMenuItem
                onSelect={() => openModal('delete')}
                className="text-red-600 focus:bg-red-50 focus:text-red-700"
              >
                <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 4h10M6 4V3h4v1M13 4l-.75 9H3.75L3 4"/><path d="M6.5 7v4M9.5 7v4"/></svg>
                </span>
                Delete project
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenu>

      {/* Delete confirmation modal */}
      {modal === 'delete' && (
        <Modal title="Delete project" onClose={closeModal}>
          {actionError && (
            <div className="mb-3 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{actionError}</div>
          )}
          <p className="text-sm text-gray-600 mb-2">
            Are you sure you want to delete <span className="font-medium text-gray-900">&ldquo;{project.name}&rdquo;</span>?
          </p>
          <p className="text-sm text-gray-500 mb-5">
            This will permanently delete all data, mappings, transforms, and validation results. This action cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={closeModal} className="text-gray-600">Cancel</Button>
            <Button
              onClick={handleDelete}
              disabled={isPending}
              className="bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
            >
              {isPending ? 'Deleting…' : 'Delete project'}
            </Button>
          </div>
        </Modal>
      )}

      {/* Archive confirmation modal */}
      {modal === 'archive' && (
        <Modal title="Archive Project" onClose={archiveLoading ? undefined : closeModal}>
          <p className="text-sm text-gray-600 mb-3">
            Archiving will permanently delete all uploaded data and database connections from{' '}
            <span className="font-medium text-gray-900">&ldquo;{project.name}&rdquo;</span>.
          </p>
          <div className="mb-4 bg-gray-50 border border-gray-200 rounded-lg p-3">
            <p className="text-xs font-medium text-gray-700 mb-1.5">The following will be preserved:</p>
            <ul className="text-xs text-gray-500 space-y-0.5 list-disc list-inside">
              <li>Source and target schema structure</li>
              <li>Field mappings and transformation logic</li>
              <li>Validation results and quality decisions</li>
              <li>Generated outputs and execution packages</li>
            </ul>
          </div>
          <p className="text-xs text-gray-400 mb-5">This action cannot be undone.</p>

          {archiveError && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {archiveError}
            </div>
          )}

          {archiveLoading ? (
            <div className="flex items-center justify-center gap-2 py-2 text-sm text-gray-500">
              <svg className="animate-spin w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              Archiving project and purging data…
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {outputUrl && (
                <button
                  onClick={async () => {
                    try {
                      const response = await fetch(outputUrl)
                      const blob = await response.blob()
                      const downloadUrl = URL.createObjectURL(blob)
                      const a = document.createElement('a')
                      a.href = downloadUrl
                      a.download = `${project.name.replace(/\s+/g, '_')}_execution_package.sql`
                      document.body.appendChild(a)
                      a.click()
                      document.body.removeChild(a)
                      URL.revokeObjectURL(downloadUrl)
                    } catch {
                      // Fallback to opening in new tab if download fails
                      window.open(outputUrl, '_blank')
                    }
                  }}
                  className="flex items-center justify-center gap-1.5 w-full px-4 py-2 text-sm font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
                  Download Outputs First
                </button>
              )}
              <div className="flex justify-end gap-2 mt-1">
                <Button variant="ghost" onClick={closeModal} className="text-gray-600">Cancel</Button>
                <Button
                  onClick={handleArchive}
                  className="bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
                >
                  Archive Project
                </Button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  )
}
