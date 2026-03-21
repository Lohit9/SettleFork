'use client'

import { useState, useRef, useEffect, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { updateProject, updateProjectLabels, deleteProject } from '@/lib/actions/projects'

// ── types ──────────────────────────────────────────────────────────────────

export interface ProjectMenuProject {
  id: string
  name: string
  source_label: string
  target_label: string
  status: string
}

interface ProjectMenuProps {
  project: ProjectMenuProject
  onUpdate?: () => void
}

// ── shared modal shell ─────────────────────────────────────────────────────

function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-[300] p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white border border-gray-200 rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-base font-semibold text-gray-900 mb-4">{title}</h2>
        {children}
      </div>
    </div>
  )
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

// ── menu item ──────────────────────────────────────────────────────────────

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-md transition-colors text-left ${
        danger
          ? 'text-red-600 hover:bg-red-50'
          : 'text-gray-700 hover:bg-gray-50'
      }`}
    >
      <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">{icon}</span>
      {label}
    </button>
  )
}

// ── main component ─────────────────────────────────────────────────────────

export function ProjectMenu({ project, onUpdate }: ProjectMenuProps) {
  const router = useRouter()
  const [isOpen, setIsOpen] = useState(false)
  const [dropCoords, setDropCoords] = useState({ top: 0, left: 0 })
  const [modal, setModal] = useState<'rename' | 'labels' | 'delete' | null>(null)

  // rename state
  const [newName, setNewName] = useState(project.name)
  // labels state
  const [srcLabel, setSrcLabel] = useState(project.source_label)
  const [tgtLabel, setTgtLabel] = useState(project.target_label)

  const [isPending, startTransition] = useTransition()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)

  const refresh = () => {
    router.refresh()
    onUpdate?.()
  }

  // close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return
    function handler(e: MouseEvent) {
      const t = e.target as Node
      if (
        dropRef.current && !dropRef.current.contains(t) &&
        triggerRef.current && !triggerRef.current.contains(t)
      ) setIsOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isOpen])

  // close dropdown on Escape
  useEffect(() => {
    if (!isOpen) return
    function handler(e: KeyboardEvent) { if (e.key === 'Escape') setIsOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen])

  const openDropdown = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      setDropCoords({ top: rect.bottom + 4, left: rect.left })
    }
    setIsOpen(o => !o)
  }

  const openModal = (m: 'rename' | 'labels' | 'delete') => {
    setIsOpen(false)
    if (m === 'rename') setNewName(project.name)
    if (m === 'labels') { setSrcLabel(project.source_label); setTgtLabel(project.target_label) }
    setModal(m)
  }

  const closeModal = () => setModal(null)

  // ── actions ──

  const handleRename = () => {
    if (!newName.trim()) return
    startTransition(async () => {
      await updateProject(project.id, { name: newName.trim() })
      closeModal()
      refresh()
    })
  }

  const handleLabels = () => {
    if (!srcLabel.trim() || !tgtLabel.trim()) return
    startTransition(async () => {
      await updateProjectLabels(project.id, srcLabel.trim(), tgtLabel.trim())
      closeModal()
      refresh()
    })
  }

  const handleToggleStatus = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsOpen(false)
    const newStatus = project.status === 'completed' ? 'active' : 'completed'
    startTransition(async () => {
      await updateProject(project.id, { status: newStatus })
      refresh()
    })
  }

  const handleDelete = () => {
    startTransition(async () => {
      await deleteProject(project.id)
      closeModal()
      router.push('/app/projects')
      router.refresh()
    })
  }

  const isCompleted = project.status === 'completed'

  return (
    <>
      {/* Trigger */}
      <button
        ref={triggerRef}
        onClick={openDropdown}
        className="w-8 h-8 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
        title="Project options"
      >
        <DotsIcon />
      </button>

      {/* Dropdown portal */}
      {isOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={dropRef}
          className="fixed w-52 bg-white border border-gray-200 rounded-xl shadow-lg z-[200] py-1.5"
          style={{ top: dropCoords.top, left: dropCoords.left }}
        >
          <MenuItem
            icon={<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M11.5 2.5l2 2-8 8H3.5v-2l8-8z"/></svg>}
            label="Rename"
            onClick={() => openModal('rename')}
          />
          <MenuItem
            icon={<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="5" width="12" height="9" rx="1"/><path d="M5 5V4a3 3 0 016 0v1"/></svg>}
            label="Edit labels"
            onClick={() => openModal('labels')}
          />
          <MenuItem
            icon={
              isCompleted
                ? <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 8a6 6 0 0110.5-4M14 8a6 6 0 01-10.5 4"/><path d="M12 4l2 2-2 2M4 12l-2-2 2-2"/></svg>
                : <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6"/><path d="M5 8l2 2 4-4"/></svg>
            }
            label={isCompleted ? 'Reactivate' : 'Mark as completed'}
            onClick={handleToggleStatus}
          />
          <div className="border-t border-gray-100 my-1" />
          <MenuItem
            icon={<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 4h10M6 4V3h4v1M13 4l-.75 9H3.75L3 4"/><path d="M6.5 7v4M9.5 7v4"/></svg>}
            label="Delete project"
            onClick={() => openModal('delete')}
            danger
          />
        </div>,
        document.body
      )}

      {/* Rename modal */}
      {modal === 'rename' && (
        <Modal title="Rename project" onClose={closeModal}>
          <div className="mb-4">
            <Label className="text-sm text-gray-700 mb-1.5 block">Project name</Label>
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleRename() }}
              className="w-full"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={closeModal} className="text-gray-600">Cancel</Button>
            <Button
              onClick={handleRename}
              disabled={!newName.trim() || isPending}
              className="bg-[#4F46E5] hover:bg-[#4338CA] text-white disabled:opacity-50"
            >
              {isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </Modal>
      )}

      {/* Edit labels modal */}
      {modal === 'labels' && (
        <Modal title="Edit project labels" onClose={closeModal}>
          <div className="space-y-3 mb-4">
            <div>
              <Label className="text-sm text-gray-700 mb-1.5 block">Source system</Label>
              <Input
                autoFocus
                value={srcLabel}
                onChange={(e) => setSrcLabel(e.target.value)}
                className="w-full"
              />
            </div>
            <div>
              <Label className="text-sm text-gray-700 mb-1.5 block">Target system</Label>
              <Input
                value={tgtLabel}
                onChange={(e) => setTgtLabel(e.target.value)}
                className="w-full"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={closeModal} className="text-gray-600">Cancel</Button>
            <Button
              onClick={handleLabels}
              disabled={!srcLabel.trim() || !tgtLabel.trim() || isPending}
              className="bg-[#4F46E5] hover:bg-[#4338CA] text-white disabled:opacity-50"
            >
              {isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </Modal>
      )}

      {/* Delete confirmation modal */}
      {modal === 'delete' && (
        <Modal title="Delete project" onClose={closeModal}>
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
    </>
  )
}
