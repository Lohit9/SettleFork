'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Plus, ArrowRight, Calendar, Database } from '@/components/icons'
import { createProject } from '@/lib/actions/projects'
import { Project } from '@/lib/types/database'

interface ProjectsListProps {
  initialProjects: Project[]
}

export function ProjectsList({ initialProjects }: ProjectsListProps) {
  const router = useRouter()
  const [showCreate, setShowCreate] = useState(false)
  const [projects, setProjects] = useState<Project[]>(initialProjects)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  // Form state
  const [projectName, setProjectName] = useState('')
  const [sourceSystem, setSourceSystem] = useState('')
  const [targetSystem, setTargetSystem] = useState('')
  const [notes, setNotes] = useState('')

  const handleCreate = () => {
    if (!projectName || !sourceSystem || !targetSystem) return
    setError(null)

    startTransition(async () => {
      try {
        const newProject = await createProject(projectName, sourceSystem, targetSystem, notes || undefined)
        setProjects([newProject, ...projects])
        router.push(`/app/projects/${newProject.id}`)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create project')
      }
    })
  }

  const getStatusBadge = (status: Project['status']) => {
    switch (status) {
      case 'completed':
        return <Badge className="bg-green-100 text-green-700 hover:bg-green-100">Completed</Badge>
      case 'archived':
        return <Badge className="bg-gray-100 text-gray-700 hover:bg-gray-100">Archived</Badge>
      default:
        return <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100">Active</Badge>
    }
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  if (showCreate) {
    return (
      <div className="flex-1 bg-gray-50 flex flex-col">
        <div className="border-b border-gray-200 bg-white p-6">
          <Button variant="ghost" onClick={() => setShowCreate(false)} className="mb-2">
            ← Back to Projects
          </Button>
        </div>
        <div className="flex-1 p-8">
          <div className="max-w-2xl">
            <h1 className="text-2xl font-semibold text-gray-900 mb-8">Create Project</h1>
            <div className="bg-white rounded-lg border border-gray-200 p-8">
              <div className="space-y-6">
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
                <div>
                  <Label htmlFor="notes" className="text-sm text-gray-700 mb-1.5 block">
                    Description (Optional)
                  </Label>
                  <Textarea
                    id="notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Add any additional context or requirements"
                    className="w-full min-h-24 resize-none"
                  />
                </div>
              </div>

              {error && (
                <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">
                  {error}
                </div>
              )}

              <div className="mt-8 flex justify-end">
                <Button
                  onClick={handleCreate}
                  disabled={!projectName || !sourceSystem || !targetSystem || isPending}
                  className="bg-[#4F46E5] hover:bg-[#4338CA] text-white"
                >
                  {isPending ? 'Creating...' : 'Create Project'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 bg-gray-50 flex flex-col">
      <div className="border-b border-gray-200 bg-white p-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 mb-1">Projects</h1>
            <p className="text-sm text-gray-600">Manage your data migration projects</p>
          </div>
          <Button
            onClick={() => setShowCreate(true)}
            className="bg-[#4F46E5] hover:bg-[#4338CA] text-white gap-2"
          >
            <Plus className="w-4 h-4" />
            New Project
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
              <Database className="w-8 h-8 text-gray-400" />
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">No projects yet</h3>
            <p className="text-sm text-gray-500 mb-6 max-w-sm">
              Create your first data migration project to get started with Mine.
            </p>
            <Button
              onClick={() => setShowCreate(true)}
              className="bg-[#4F46E5] hover:bg-[#4338CA] text-white gap-2"
            >
              <Plus className="w-4 h-4" />
              Create your first project
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 max-w-5xl">
            {projects.map((project) => (
              <button
                key={project.id}
                onClick={() => router.push(`/app/projects/${project.id}`)}
                className="bg-white rounded-lg border border-gray-200 p-6 text-left hover:border-[#4F46E5] hover:shadow-sm transition-all group"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-lg font-semibold text-gray-900 group-hover:text-[#4F46E5] transition-colors">
                        {project.name}
                      </h3>
                      {getStatusBadge(project.status)}
                    </div>
                    {project.description && (
                      <p className="text-sm text-gray-600 mb-2">{project.description}</p>
                    )}
                  </div>
                  <ArrowRight className="w-5 h-5 text-gray-400 group-hover:text-[#4F46E5] transition-colors flex-shrink-0" />
                </div>

                <div className="flex flex-wrap gap-4 text-xs text-gray-500">
                  <div className="flex items-center gap-1.5">
                    <Calendar className="w-3.5 h-3.5" />
                    <span>Created {formatDate(project.created_at)}</span>
                  </div>
                  {project.updated_at !== project.created_at && (
                    <>
                      <div className="w-px bg-gray-200" />
                      <div className="flex items-center gap-1.5">
                        <span>Updated {formatDate(project.updated_at)}</span>
                      </div>
                    </>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
