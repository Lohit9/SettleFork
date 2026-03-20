'use client'

import { useState, useTransition } from 'react'
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

function ProjectCard({ project }: { project: ProjectWithStats }) {
  const isCompleted = project.status === 'completed'

  const readinessDisplay = () => {
    if (project.readinessScore === null) return null
    return project.readinessScore
  }
  const score = readinessDisplay()

  const scoreColor =
    score === null
      ? 'text-gray-500'
      : score >= 90
        ? 'text-green-400'
        : score >= 60
          ? 'text-amber-400'
          : 'text-red-400'

  // Bottom stats chips
  const stats: { label: string; value: string; color?: string }[] = []

  if (project.mappedFieldCount > 0 || project.totalSourceFields > 0) {
    stats.push({ label: `Mapped: ${project.mappedFieldCount}/${project.totalSourceFields} fields`, value: '' })
  } else if (project.totalRows > 0) {
    stats.push({ label: `Rows: ${project.totalRows.toLocaleString()}`, value: '' })
  }

  if (project.blockingIssueCount > 0) {
    stats.push({ label: `Blocking: ${project.blockingIssueCount}`, value: '', color: 'text-red-400' })
  }

  if (project.warningCount > 0) {
    stats.push({ label: `Warnings: ${project.warningCount}`, value: '', color: 'text-amber-400' })
  }

  if (project.totalTransforms > 0) {
    stats.push({ label: `Transforms: ${project.savedTransforms}/${project.totalTransforms} saved`, value: '' })
  }

  if (isCompleted && project.outputCount > 0) {
    stats.push({ label: `Deliverables: ${project.outputCount} generated`, value: '' })
  }

  return (
    <Link
      href={`/app/projects/${project.id}`}
      className={`block bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-5 hover:border-[#3a3a3a] transition-all ${
        isCompleted ? 'opacity-70' : ''
      }`}
    >
      {/* Top row */}
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-base font-medium text-white truncate">{project.name}</span>
            {isCompleted ? (
              <Badge className="bg-green-900/40 text-green-400 border border-green-800/50 hover:bg-green-900/40 text-[11px] px-1.5 py-0 flex-shrink-0">
                Completed
              </Badge>
            ) : (
              <Badge className="bg-blue-900/40 text-blue-400 border border-blue-800/50 hover:bg-blue-900/40 text-[11px] px-1.5 py-0 flex-shrink-0">
                Active
              </Badge>
            )}
          </div>
          <p className="text-xs text-gray-500 truncate">
            {project.source_label} → {project.target_label}
            <span className="mx-1.5">·</span>
            Created {formatDate(project.created_at)}
            <span className="mx-1.5">·</span>
            Last updated {formatRelativeTime(project.updated_at)}
          </p>
        </div>

        {/* Readiness score */}
        <div className="text-right flex-shrink-0">
          {score !== null ? (
            <>
              <div className={`text-2xl font-medium leading-none ${scoreColor}`}>{score}%</div>
              <div className="text-[11px] text-gray-500 mt-0.5">Readiness</div>
            </>
          ) : (
            <>
              <div className="text-base font-medium text-red-500 leading-none">—</div>
              <div className="text-[11px] text-gray-500 mt-0.5">Not scanned</div>
            </>
          )}
        </div>
      </div>

      {/* Phase progress bar */}
      <div className="mb-3">
        <PhaseProgressBar currentPhase={project.currentPhase} showLabels />
      </div>

      {/* Bottom stats */}
      {stats.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
          {stats.map((s, i) => (
            <span key={i} className="flex items-center gap-3">
              {i > 0 && <span className="text-[#2a2a2a]">|</span>}
              <span className={s.color ?? 'text-gray-500'}>{s.label}</span>
            </span>
          ))}
        </div>
      )}
    </Link>
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
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl w-full max-w-lg p-6">
        <h2 className="text-lg font-semibold text-white mb-5">New Project</h2>
        <div className="space-y-4">
          <div>
            <Label htmlFor="project-name" className="text-xs text-gray-400 mb-1.5 block">
              Project Name
            </Label>
            <Input
              id="project-name"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="e.g., Salesforce to SAP Migration"
              className="bg-[#111111] border-[#2a2a2a] text-white placeholder:text-gray-600 focus-visible:ring-[#4F46E5] focus-visible:border-[#4F46E5]"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="source-system" className="text-xs text-gray-400 mb-1.5 block">
                Source System
              </Label>
              <Input
                id="source-system"
                value={sourceSystem}
                onChange={(e) => setSourceSystem(e.target.value)}
                placeholder="e.g., Salesforce"
                className="bg-[#111111] border-[#2a2a2a] text-white placeholder:text-gray-600 focus-visible:ring-[#4F46E5] focus-visible:border-[#4F46E5]"
              />
            </div>
            <div>
              <Label htmlFor="target-system" className="text-xs text-gray-400 mb-1.5 block">
                Target System
              </Label>
              <Input
                id="target-system"
                value={targetSystem}
                onChange={(e) => setTargetSystem(e.target.value)}
                placeholder="e.g., SAP S/4HANA"
                className="bg-[#111111] border-[#2a2a2a] text-white placeholder:text-gray-600 focus-visible:ring-[#4F46E5] focus-visible:border-[#4F46E5]"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="notes" className="text-xs text-gray-400 mb-1.5 block">
              Description <span className="text-gray-600">(optional)</span>
            </Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add any context or requirements"
              className="bg-[#111111] border-[#2a2a2a] text-white placeholder:text-gray-600 resize-none min-h-20 focus-visible:ring-[#4F46E5] focus-visible:border-[#4F46E5]"
            />
          </div>
        </div>

        {error && (
          <div className="mt-4 p-3 bg-red-950/50 border border-red-900/50 rounded-lg text-sm text-red-400">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={onCancel}
            className="text-gray-400 hover:text-white hover:bg-[#2a2a2a]"
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!projectName.trim() || !sourceSystem.trim() || !targetSystem.trim() || isPending}
            className="bg-[#4F46E5] hover:bg-[#4338CA] text-white disabled:opacity-50"
          >
            {isPending ? 'Creating…' : 'Create Project'}
          </Button>
        </div>
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
  const [projects] = useState<ProjectWithStats[]>(initialProjects)
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
  const totalBlocking = projects.reduce((s, p) => s + p.blockingIssueCount, 0)
  const scoredProjects = projects.filter((p) => p.readinessScore !== null)
  const avgReadiness =
    scoredProjects.length > 0
      ? Math.round(scoredProjects.reduce((s, p) => s + (p.readinessScore ?? 0), 0) / scoredProjects.length)
      : null

  const TABS: { id: FilterTab; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: projects.length },
    { id: 'active', label: 'Active', count: activeCount },
    { id: 'completed', label: 'Completed', count: completedCount },
  ]

  return (
    <div className="flex-1 bg-[#111111] flex flex-col min-h-screen">
      {/* Header */}
      <div className="px-8 pt-8 pb-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-white">Projects</h1>
            <p className="text-sm text-gray-500 mt-0.5">Manage your data migration projects</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search projects…"
                className="h-9 pl-9 pr-3 w-52 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-[#4F46E5] transition-colors"
              />
            </div>
            <Button
              onClick={() => setShowCreate(true)}
              className="bg-[#4F46E5] hover:bg-[#4338CA] text-white h-9 px-4 gap-1.5 text-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              New Project
            </Button>
          </div>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-4 gap-3 mb-6">
          <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-4">
            <div className="text-xs text-gray-500 mb-1">Total projects</div>
            <div className="text-xl font-semibold text-white">{projects.length}</div>
          </div>
          <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-4">
            <div className="text-xs text-gray-500 mb-1">Active</div>
            <div className="text-xl font-semibold text-green-400">{activeCount}</div>
          </div>
          <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-4">
            <div className="text-xs text-gray-500 mb-1">Blocking issues</div>
            <div className={`text-xl font-semibold ${totalBlocking > 0 ? 'text-orange-400' : 'text-white'}`}>
              {totalBlocking}
            </div>
          </div>
          <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-4">
            <div className="text-xs text-gray-500 mb-1">Avg. readiness</div>
            <div
              className={`text-xl font-semibold ${
                avgReadiness === null
                  ? 'text-gray-600'
                  : avgReadiness >= 90
                    ? 'text-green-400'
                    : avgReadiness >= 60
                      ? 'text-amber-400'
                      : 'text-red-400'
              }`}
            >
              {avgReadiness !== null ? `${avgReadiness}%` : '—'}
            </div>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex items-center gap-1 border-b border-[#2a2a2a]">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveFilter(tab.id)}
              className={`px-3 pb-2.5 text-sm font-medium flex items-center gap-1.5 border-b-2 transition-colors ${
                activeFilter === tab.id
                  ? 'border-[#4F46E5] text-white'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab.label}
              <span
                className={`text-[11px] px-1.5 py-0.5 rounded-full ${
                  activeFilter === tab.id ? 'bg-[#4F46E5] text-white' : 'bg-[#2a2a2a] text-gray-400'
                }`}
              >
                {tab.count}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Project list */}
      <div className="flex-1 px-8 pb-8">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-14 h-14 bg-[#1a1a1a] border border-[#2a2a2a] rounded-full flex items-center justify-center mb-4">
              <Database className="w-6 h-6 text-gray-600" />
            </div>
            <h3 className="text-base font-medium text-white mb-2">
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
                className="bg-[#4F46E5] hover:bg-[#4338CA] text-white gap-2"
              >
                <Plus className="w-3.5 h-3.5" />
                Create your first project
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((project) => (
              <ProjectCard key={project.id} project={project} />
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
    </div>
  )
}
