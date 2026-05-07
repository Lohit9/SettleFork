'use client'

import { useState, useEffect, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Plus, Database, Search, Layers, FileText } from '@/components/icons'
import { createProject } from '@/lib/actions/projects'
import { ProjectWithStats } from '@/lib/types/database'
import { ProjectMenu } from '@/components/app/ProjectMenu'
import { ProjectStateBadge } from '@/components/app/ProjectStateBadge'
import { BlockingPill } from '@/components/app/BlockingPill'

// ── helpers ────────────────────────────────────────────────────────────────

function formatRelativeTime(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diffMs / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 30) return `${days} day${days !== 1 ? 's' : ''} ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Auto-archive countdown helper ───────────────────────────────────────────

function AutoArchiveCountdown({ completedAt }: { completedAt: string | null }) {
  if (!completedAt) return null
  const daysElapsed = Math.floor((Date.now() - new Date(completedAt).getTime()) / 86400000)
  const daysRemaining = 90 - daysElapsed
  if (daysRemaining <= 0) return null

  const color =
    daysRemaining <= 7
      ? 'text-red-500'
      : daysRemaining <= 14
        ? 'text-amber-500'
        : 'text-gray-400'

  return (
    <span className={`text-xs ${color}`}>
      Auto-archives in {daysRemaining} day{daysRemaining !== 1 ? 's' : ''}
    </span>
  )
}

// ── ProjectCard ─────────────────────────────────────────────────────────────

// PR-2 (feat/project-tile-redesign): the tile now consumes the new
// `projectStats: ProjectStats | null` field that PR-1 populated on
// `ProjectWithStats`. The legacy fields (`mappingApproved`, `mappingTotal`,
// `transformApplied`, `transformScope`, `blockingIssueCount`, etc.) stay
// on the type for the Migration Center surface — PR-3 retires them once
// MC also stops reading them.
//
// State machine (3 states + Completed overlay) drives a `<ProjectStateBadge>`
// next to the project name and gates the stats row entirely:
//
//   awaiting_data        → gray badge, no stats
//   data_ingested        → blue badge, no stats
//   mappings_generated   → amber badge, 3 stats + blocking pill
//   completed (overlay)  → green badge regardless of state; stats render
//                          when underlying state === mappings_generated
//
// Archived projects keep their existing "no stats" treatment (data purged
// on archive — stats meaningless). Q1 in PR-2 Stop 1.
//
// Transform numerator note: `projectStats.transforms.complete` counts
// `saved + applied` rows (Q2 from PR-1) — a numeric SHIFT upward from the
// previous `transformApplied`-only display. Deliberate spec change; user-
// visible work-in-progress (Saved status) now reads as completed.
export function ProjectCard({
  project,
  onUpdate,
}: {
  project: ProjectWithStats
  onUpdate: () => void
}) {
  const isCompleted = project.status === 'completed'
  const isArchived = project.status === 'archived'
  const stats = project.projectStats
  // Stats row visible only when (a) not archived, (b) state machine has
  // reached `mappings_generated`. Defensive null-fallback (Q5 from
  // PR-2 Stop 1) treats null as `awaiting_data` — no stats shown.
  const showStats = !isArchived && stats?.state === 'mappings_generated'

  const cardContent = (
    <>
      {/* Row 1: Project name + state badge / archived span / countdown */}
      <div className="flex items-center gap-2 mb-1">
        <span
          className={`text-sm font-semibold truncate ${isArchived ? 'text-gray-400' : 'text-gray-900'}`}
        >
          {project.name}
        </span>
        {!isArchived && (
          <ProjectStateBadge
            state={stats?.state ?? null}
            completedAt={project.completed_at}
          />
        )}
        {isArchived && (
          <span className="text-[10px] font-medium text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded flex-shrink-0">
            Archived
          </span>
        )}
        {isCompleted && !isArchived && <AutoArchiveCountdown completedAt={project.completed_at} />}
      </div>

      {/* Row 2: Meta left, stats right */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          {project.source_label && (
            <>
              <span>{project.source_label}</span>
              <span className="text-gray-300">→</span>
              <span>{project.target_label}</span>
              <span className="text-gray-300">·</span>
            </>
          )}
          <span>
            {isArchived && project.archived_at
              ? `Archived ${formatDate(project.archived_at)}`
              : `Updated ${formatRelativeTime(project.updated_at)}`}
          </span>
          {isArchived && <span className="text-gray-400">· Data purged</span>}
        </div>

        {showStats && stats && (
          <div
            data-testid="project-stats-row"
            className="flex items-center gap-0 text-xs text-gray-500 flex-shrink-0"
          >
            <span data-testid="stat-target">
              Mapped: {stats.target.approved}/{stats.target.total} fields
            </span>
            <span className="mx-2 text-gray-300">|</span>
            <span data-testid="stat-source">
              Sources: {stats.source.decided}/{stats.source.total}
            </span>
            <span className="mx-2 text-gray-300">|</span>
            <span data-testid="stat-transforms">
              Transforms: {stats.transforms.complete}/{stats.transforms.total}
            </span>
            <BlockingPill count={stats.blocking} className="ml-3" />
          </div>
        )}
      </div>
    </>
  )

  return (
    <div className={`relative group/card ${isArchived ? 'opacity-70' : ''}`}>
      <Link
        href={`/app/projects/${project.id}`}
        className={`block bg-white border border-gray-200 rounded-lg px-5 py-3.5 pr-12 hover:border-gray-300 transition-colors ${
          isCompleted ? 'opacity-75' : ''
        }`}
      >
        {cardContent}
      </Link>

      {/* Three-dot menu — floats above the card */}
      <div className="absolute top-3 right-3 opacity-0 group-hover/card:opacity-100 transition-opacity">
        <ProjectMenu
          project={{
            id: project.id,
            name: project.name,
            source_label: project.source_label,
            target_label: project.target_label,
            status: project.status,
            completed_at: project.completed_at,
          }}
          onUpdate={onUpdate}
        />
      </div>
    </div>
  )
}

// ── New Project Form ─────────────────────────────────────────────────────────

function NewProjectForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const [projectName, setProjectName] = useState('')
  const [sourceSystem, setSourceSystem] = useState('')
  const [targetSystem, setTargetSystem] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleCreate = () => {
    if (!projectName.trim() || !sourceSystem.trim() || !targetSystem.trim()) return
    setError(null)
    startTransition(async () => {
      const activeOrgId = document.cookie.match(/settle-active-org=([^;]+)/)?.[1]
        ?? document.cookie.match(/mine-active-org=([^;]+)/)?.[1]
      const result = await createProject(projectName, sourceSystem, targetSystem, notes || undefined, activeOrgId)
      if (!result.success || !result.data) {
        setError(result.error ?? 'Failed to create project')
        return
      }
      onCreated(result.data.id)
    })
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white border border-gray-200 rounded-xl shadow-xl w-full max-w-lg p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-5">New Project</h2>
        <div className="space-y-4">
          <div>
            <Label htmlFor="project-name" className="text-sm text-gray-700 mb-1.5 block">
              Project Name
            </Label>
            <Input
              id="project-name"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="e.g., Salesforce to SAP Migration"
              className="w-full"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="source-system" className="text-sm text-gray-700 mb-1.5 block">
                Source System
              </Label>
              <Input
                id="source-system"
                value={sourceSystem}
                onChange={(e) => setSourceSystem(e.target.value)}
                placeholder="e.g., Salesforce"
                className="w-full"
              />
            </div>
            <div>
              <Label htmlFor="target-system" className="text-sm text-gray-700 mb-1.5 block">
                Target System
              </Label>
              <Input
                id="target-system"
                value={targetSystem}
                onChange={(e) => setTargetSystem(e.target.value)}
                placeholder="e.g., SAP S/4HANA"
                className="w-full"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="notes" className="text-sm text-gray-700 mb-1.5 block">
              Description <span className="text-gray-400">(optional)</span>
            </Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add any context or requirements"
              className="w-full resize-none min-h-20"
            />
          </div>
        </div>

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} className="text-gray-600">
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!projectName.trim() || !sourceSystem.trim() || !targetSystem.trim() || isPending}
            className="bg-primary hover:bg-primary/90 text-white disabled:opacity-50"
          >
            {isPending ? 'Creating…' : 'Create Project'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Welcome modal (first-time users) ─────────────────────────────────────

function WelcomeModal({ onDismiss, onGetStarted }: { onDismiss: () => void; onGetStarted: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onDismiss() }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-[460px] p-8">
        {/* Logo / icon */}
        <div className="flex justify-center mb-5">
          <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center">
            <span className="text-white text-xl font-bold leading-none">S</span>
          </div>
        </div>

        <h2 className="text-xl font-semibold text-gray-900 mb-4 text-center">Welcome to Settle</h2>

        <p className="text-sm text-gray-500 mb-5 text-center">
          Your workspace is ready. Here&apos;s how to get started:
        </p>

        <ol className="space-y-3 mb-6 text-left">
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-xs font-semibold flex items-center justify-center mt-0.5">1</span>
            <span className="text-sm text-gray-700">
              <span className="font-medium">Create a project</span> — give your migration a name and select your source and target systems
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-xs font-semibold flex items-center justify-center mt-0.5">2</span>
            <span className="text-sm text-gray-700">
              <span className="font-medium">Upload your data</span> — CSV files or connect directly to your database
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-xs font-semibold flex items-center justify-center mt-0.5">3</span>
            <span className="text-sm text-gray-700">
              <span className="font-medium">Settle will take it from here</span> — we&apos;ll profile your data, generate mappings, and identify quality issues automatically
            </span>
          </li>
        </ol>

        <p className="text-xs text-gray-400 text-center mb-6">
          If you need help, reach out anytime at{' '}
          <a href="mailto:info@usesettle.ai" className="text-blue-600 hover:underline">info@usesettle.ai</a>
          {' '}or reply to your invite email.
        </p>

        <Button
          onClick={onGetStarted}
          className="w-full bg-primary hover:bg-primary/90 text-white font-medium"
        >
          Create Your First Project
        </Button>
      </div>
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────────────

type FilterTab = 'active' | 'completed' | 'archived'

interface ProjectsListProps {
  initialProjects: ProjectWithStats[]
  activeOrgRole?: string
}

export function ProjectsList({ initialProjects, activeOrgRole }: ProjectsListProps) {
  // Post-079: any org membership ('owner' or 'member') can create projects.
  // The pre-079 'viewer' org-role no longer exists. Treat absent membership
  // (undefined activeOrgRole) as the only no-create case.
  const canCreateProject = activeOrgRole === 'owner' || activeOrgRole === 'member'
  const router = useRouter()
  const [projects, setProjects] = useState<ProjectWithStats[]>(initialProjects)
  const [showWelcome, setShowWelcome] = useState(false)

  // Sync with server data when router.refresh() causes new props
  useEffect(() => { setProjects(initialProjects) }, [initialProjects])

  // Show welcome modal for first-time users (zero projects, never dismissed)
  useEffect(() => {
    if (initialProjects.length === 0) {
      const dismissed = localStorage.getItem('settle_welcome_dismissed')
        ?? localStorage.getItem('mine_welcome_dismissed')
      if (!dismissed) setShowWelcome(true)
    }
  }, [initialProjects.length])

  const dismissWelcome = () => {
    localStorage.setItem('settle_welcome_dismissed', 'true')
    setShowWelcome(false)
  }

  const getStarted = () => {
    localStorage.setItem('settle_welcome_dismissed', 'true')
    setShowWelcome(false)
    setShowCreate(true)
  }
  const [activeFilter, setActiveFilter] = useState<FilterTab>('active')
  const [search, setSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)

  const filtered = projects.filter((p) => {
    const matchesFilter =
      (activeFilter === 'active' && p.status === 'active') ||
      (activeFilter === 'completed' && p.status === 'completed') ||
      (activeFilter === 'archived' && p.status === 'archived')
    const matchesSearch =
      search.trim() === '' ||
      p.name.toLowerCase().includes(search.toLowerCase())
    return matchesFilter && matchesSearch
  })

  const TABS: { id: FilterTab; label: string }[] = [
    { id: 'active', label: 'Active' },
    { id: 'completed', label: 'Completed' },
    { id: 'archived', label: 'Archived' },
  ]

  return (
    <div className="flex-1 bg-gray-50 flex flex-col min-h-screen">
      {/* Header */}
      <div className="border-b border-gray-200 bg-white px-8 pt-6 pb-0">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Projects</h1>
            <p className="text-sm text-gray-500 mt-0.5">Manage your data migration projects</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search projects…"
                className="h-9 pl-9 pr-3 w-52 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-600 transition-colors"
              />
            </div>
            {canCreateProject && (
              <Button
                onClick={() => setShowCreate(true)}
                className="bg-primary hover:bg-primary/90 text-white h-9 px-4 gap-1.5 text-sm"
              >
                <Plus className="w-3.5 h-3.5" />
                New Project
              </Button>
            )}
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex items-center gap-1 border-b border-settle-slate-200">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveFilter(tab.id)}
              className={`px-3 py-2.5 text-sm font-medium transition-colors cursor-pointer border-b-2 -mb-px ${
                activeFilter === tab.id
                  ? 'border-settle-blue-500 text-settle-slate-900'
                  : 'border-transparent text-settle-slate-500 hover:text-settle-slate-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Project list */}
      <div className="flex-1 px-8 py-6">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            {/* Filtered empty states — compact */}
            {(search || activeFilter === 'archived' || activeFilter === 'completed') ? (
              <>
                <div className="w-14 h-14 bg-gray-100 rounded-full flex items-center justify-center mb-4">
                  <Database className="w-6 h-6 text-gray-400" />
                </div>
                <h3 className="text-base font-medium text-gray-900 mb-2">
                  {search
                    ? 'No projects match your search'
                    : activeFilter === 'archived'
                      ? 'No archived projects'
                      : 'No completed projects'}
                </h3>
                <p className="text-sm text-gray-500 max-w-xs">
                  {search
                    ? 'Try a different search term.'
                    : activeFilter === 'archived'
                      ? 'Completed projects are automatically archived after 90 days.'
                      : 'Mark a project as complete when the migration is finished.'}
                </p>
              </>
            ) : (
              /* First project — rich empty state */
              <div className="max-w-md mx-auto">
                <div className="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center mx-auto mb-4">
                  <Layers className="h-6 w-6 text-blue-600" />
                </div>
                <h3 className="text-lg font-semibold text-slate-900 mb-2">Create your first project</h3>
                <p className="text-sm text-slate-500 mb-6">
                  A project represents one migration — from source system to target system.
                  Start by uploading a CSV file or connecting to your database.
                </p>
                {canCreateProject && (
                  <Button
                    onClick={() => setShowCreate(true)}
                    className="bg-primary hover:bg-primary/90 text-white gap-2"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    New Project
                  </Button>
                )}
                <div className="mt-8 text-left border-t border-gray-100 pt-6">
                  <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-3">What you&apos;ll need</p>
                  <ul className="text-sm text-slate-600 space-y-2">
                    <li className="flex items-start gap-2">
                      <FileText className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" />
                      Source data — CSV exports or database connection credentials
                    </li>
                    <li className="flex items-start gap-2">
                      <Database className="h-4 w-4 text-slate-400 mt-0.5 shrink-0" />
                      Target schema — DDL, ERD, or data dictionary of your target system
                    </li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2 max-w-5xl">
            {filtered.map((project) => (
              <ProjectCard key={project.id} project={project} onUpdate={() => router.refresh()} />
            ))}
          </div>
        )}
      </div>

      {showCreate && (
        <NewProjectForm
          onCancel={() => setShowCreate(false)}
          onCreated={(id) => router.push(`/app/projects/${id}`)}
        />
      )}

      {showWelcome && <WelcomeModal onDismiss={dismissWelcome} onGetStarted={getStarted} />}
    </div>
  )
}
