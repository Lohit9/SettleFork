'use client'

import { useState, useEffect, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Plus, Database, Search } from '@/components/icons'
import { PhaseProgressBar } from '@/components/app/PhaseProgressBar'
import { createProject } from '@/lib/actions/projects'
import { ProjectWithStats } from '@/lib/types/database'
import { ProjectMenu } from '@/components/app/ProjectMenu'

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

// ── ProjectCard ─────────────────────────────────────────────────────────────

function ProjectCard({ project, onUpdate }: { project: ProjectWithStats; onUpdate: () => void }) {
  const isCompleted = project.status === 'completed'
  const score = project.readinessScore

  const scoreColor =
    score === null
      ? 'text-gray-400'
      : score >= 90
        ? 'text-green-600'
        : score >= 60
          ? 'text-amber-500'
          : 'text-red-500'

  // Bottom stats chips
  const stats: { label: string; color?: string }[] = []

  if (project.mappedFieldCount > 0 || project.totalSourceFields > 0) {
    stats.push({ label: `Mapped: ${project.mappedFieldCount}/${project.totalSourceFields} fields` })
  } else if (project.totalRows > 0) {
    stats.push({ label: `Rows: ${project.totalRows.toLocaleString()}` })
  }

  if (project.blockingIssueCount > 0) {
    stats.push({ label: `Blocking: ${project.blockingIssueCount}`, color: 'text-red-600' })
  }

  if (project.warningCount > 0) {
    stats.push({ label: `Warnings: ${project.warningCount}`, color: 'text-amber-600' })
  }

  if (project.totalTransforms > 0) {
    stats.push({ label: `Transforms: ${project.savedTransforms}/${project.totalTransforms} saved` })
  }

  if (isCompleted && project.outputCount > 0) {
    stats.push({ label: `Deliverables: ${project.outputCount} generated` })
  }

  return (
    <div className="relative group/card">
      <Link
        href={`/app/projects/${project.id}`}
        className={`block bg-white border border-gray-200 rounded-xl p-5 pr-12 hover:border-gray-300 hover:shadow-sm transition-all ${
          isCompleted ? 'opacity-75' : ''
        }`}
      >
        {/* Top row */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-base font-medium text-gray-900 truncate">{project.name}</span>
              {isCompleted ? (
                <Badge className="bg-green-100 text-green-700 hover:bg-green-100 text-xs px-1.5 py-0 flex-shrink-0">
                  Completed
                </Badge>
              ) : (
                <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100 text-xs px-1.5 py-0 flex-shrink-0">
                  Active
                </Badge>
              )}
            </div>
            <p className="text-xs text-gray-400 truncate">
              {project.source_label} → {project.target_label}
              <span className="mx-1.5">·</span>
              Created {formatDate(project.created_at)}
              <span className="mx-1.5">·</span>
              Last updated {formatRelativeTime(project.updated_at)}
            </p>
          </div>

          {/* Readiness score — only shown when meaningfully > 0 */}
          {score !== null && score > 0 && (
            <div className="text-right flex-shrink-0">
              <div className={`text-2xl font-semibold leading-none ${scoreColor}`}>{score}%</div>
              <div className="text-xs text-gray-400 mt-0.5">Readiness</div>
            </div>
          )}
        </div>

        {/* Phase progress bar */}
        <div className="mb-3">
          <PhaseProgressBar currentPhase={project.currentPhase} showLabels />
        </div>

        {/* Bottom stats */}
        {stats.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-0 gap-y-1 text-xs text-gray-500">
            {stats.map((s, i) => (
              <span key={i} className="flex items-center">
                {i > 0 && <span className="mx-2.5 text-gray-300">|</span>}
                <span className={s.color ?? 'text-gray-500'}>{s.label}</span>
              </span>
            ))}
          </div>
        )}
      </Link>

      {/* Three-dot menu — floats above the card link */}
      <div className="absolute top-4 right-4 opacity-0 group-hover/card:opacity-100 transition-opacity">
        <ProjectMenu
          project={{
            id: project.id,
            name: project.name,
            source_label: project.source_label,
            target_label: project.target_label,
            status: project.status,
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
      try {
        const newProject = await createProject(projectName, sourceSystem, targetSystem, notes || undefined)
        onCreated(newProject.id)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create project')
      }
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
            className="bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
          >
            {isPending ? 'Creating…' : 'Create Project'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Welcome modal (first-time users) ─────────────────────────────────────

function WelcomeModal({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onDismiss() }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-[440px] p-8 text-center">
        {/* Logo / icon */}
        <div className="flex justify-center mb-5">
          <div className="w-12 h-12 rounded-xl bg-blue-600 flex items-center justify-center">
            <span className="text-white text-xl font-bold leading-none">M</span>
          </div>
        </div>

        <h2 className="text-xl font-semibold text-gray-900 mb-3">Welcome to Mine!</h2>
        <p className="text-sm text-gray-600 leading-relaxed mb-3">
          Your account is ready. You can start exploring right away — create a project,
          upload data, and see what Mine can do.
        </p>
        <p className="text-sm text-gray-500 leading-relaxed mb-7">
          Our team will reach out within 24 hours to schedule a guided onboarding session
          where we&apos;ll set up your first migration project together.
        </p>

        <Button
          onClick={onDismiss}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium"
        >
          Get Started
        </Button>
      </div>
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────────────

type FilterTab = 'all' | 'active' | 'completed'

interface ProjectsListProps {
  initialProjects: ProjectWithStats[]
}

export function ProjectsList({ initialProjects }: ProjectsListProps) {
  const router = useRouter()
  const [projects, setProjects] = useState<ProjectWithStats[]>(initialProjects)
  const [showWelcome, setShowWelcome] = useState(false)

  // Sync with server data when router.refresh() causes new props
  useEffect(() => { setProjects(initialProjects) }, [initialProjects])

  // Show welcome modal for first-time users (zero projects, never dismissed)
  useEffect(() => {
    if (initialProjects.length === 0) {
      const dismissed = localStorage.getItem('mine_welcome_dismissed')
      if (!dismissed) setShowWelcome(true)
    }
  }, [initialProjects.length])

  const dismissWelcome = () => {
    localStorage.setItem('mine_welcome_dismissed', 'true')
    setShowWelcome(false)
  }
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all')
  const [search, setSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)

  const filtered = projects.filter((p) => {
    const matchesFilter =
      activeFilter === 'all' ||
      (activeFilter === 'active' && p.status === 'active') ||
      (activeFilter === 'completed' && p.status === 'completed')
    const matchesSearch = search.trim() === '' || p.name.toLowerCase().includes(search.toLowerCase())
    return matchesFilter && matchesSearch
  })

  const activeCount = projects.filter((p) => p.status === 'active').length
  const completedCount = projects.filter((p) => p.status === 'completed').length

  const TABS: { id: FilterTab; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: projects.length },
    { id: 'active', label: 'Active', count: activeCount },
    { id: 'completed', label: 'Completed', count: completedCount },
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
            <Button
              onClick={() => setShowCreate(true)}
              className="bg-blue-600 hover:bg-blue-700 text-white h-9 px-4 gap-1.5 text-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              New Project
            </Button>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex items-center gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveFilter(tab.id)}
              className={`px-3 pb-3 text-sm font-medium flex items-center gap-1.5 border-b-2 transition-colors ${
                activeFilter === tab.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
              <span
                className={`text-xs px-1.5 py-0.5 rounded-full ${
                  activeFilter === tab.id
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 text-gray-500'
                }`}
              >
                {tab.count}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Project list */}
      <div className="flex-1 px-8 py-6">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-14 h-14 bg-gray-100 rounded-full flex items-center justify-center mb-4">
              <Database className="w-6 h-6 text-gray-400" />
            </div>
            <h3 className="text-base font-medium text-gray-900 mb-2">
              {search ? 'No projects match your search' : 'No projects yet'}
            </h3>
            <p className="text-sm text-gray-500 mb-6 max-w-xs">
              {search
                ? 'Try a different search term.'
                : 'Create your first data migration project to get started.'}
            </p>
            {!search && (
              <Button
                onClick={() => setShowCreate(true)}
                className="bg-blue-600 hover:bg-blue-700 text-white gap-2"
              >
                <Plus className="w-3.5 h-3.5" />
                Create your first project
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3 max-w-5xl">
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

      {showWelcome && <WelcomeModal onDismiss={dismissWelcome} />}
    </div>
  )
}
