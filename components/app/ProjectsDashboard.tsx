'use client'

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Plus, ArrowRight, Calendar, Database, HelpCircle, Settings } from '@/components/icons';
import { ProjectSetup } from './ProjectSetup';
import Link from 'next/link';

interface ProjectsDashboardProps {
  onSelectProject: (projectId: string) => void;
}

const mockProjects = [
  {
    id: '1',
    name: 'Salesforce to SAP Migration',
    sourceSystem: 'Salesforce',
    targetSystem: 'SAP S/4HANA',
    status: 'in-progress' as const,
    lastModified: '2026-01-18',
    tablesCount: 12,
    currentPhase: 'Mapping Review',
  },
  {
    id: '2',
    name: 'Oracle EBS to Dynamics 365',
    sourceSystem: 'Oracle E-Business Suite',
    targetSystem: 'Microsoft Dynamics 365',
    status: 'in-progress' as const,
    lastModified: '2026-01-17',
    tablesCount: 28,
    currentPhase: 'Schema Ingestion',
  },
  {
    id: '3',
    name: 'Legacy CRM Data Migration',
    sourceSystem: 'Custom CRM',
    targetSystem: 'HubSpot',
    status: 'completed' as const,
    lastModified: '2026-01-15',
    tablesCount: 8,
    currentPhase: 'Completed',
  },
];

export function ProjectsDashboard({ onSelectProject }: ProjectsDashboardProps) {
  const [showCreateProject, setShowCreateProject] = useState(false);

  const getStatusBadge = (status: 'in-progress' | 'completed' | 'draft') => {
    switch (status) {
      case 'completed':
        return <Badge className="bg-green-100 text-green-700 hover:bg-green-100">Completed</Badge>;
      case 'in-progress':
        return <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100">In Progress</Badge>;
      case 'draft':
        return <Badge className="bg-gray-100 text-gray-700 hover:bg-gray-100">Draft</Badge>;
    }
  };

  if (showCreateProject) {
    return (
      <div className="flex-1 flex flex-col">
        <div className="border-b border-gray-200 bg-white p-6">
          <Button
            variant="ghost"
            onClick={() => setShowCreateProject(false)}
            className="mb-2"
          >
            ← Back to Projects
          </Button>
        </div>
        <ProjectSetup onNext={() => setShowCreateProject(false)} />
      </div>
    );
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
            onClick={() => setShowCreateProject(true)}
            className="bg-primary hover:bg-primary/90 text-white gap-2"
          >
            <Plus className="w-4 h-4" />
            Create Project
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="grid grid-cols-1 gap-4 max-w-5xl">
          {mockProjects.map((project) => (
            <Link
              key={project.id}
              href={`/app/projects/${project.id}/schemas`}
              className="bg-white rounded-xl border border-gray-200 p-6 text-left hover:border-blue-600 hover:shadow-sm transition-all group block"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-lg font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
                      {project.name}
                    </h3>
                    {getStatusBadge(project.status)}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <span>{project.sourceSystem}</span>
                    <ArrowRight className="w-4 h-4" />
                    <span>{project.targetSystem}</span>
                  </div>
                </div>
                <ArrowRight className="w-5 h-5 text-gray-400 group-hover:text-blue-600 transition-colors" />
              </div>

              <div className="flex flex-wrap gap-4 text-xs text-gray-500">
                <div className="flex items-center gap-1.5">
                  <Database className="w-4 h-4" />
                  <span>{project.tablesCount} tables</span>
                </div>
                <div className="w-px bg-gray-200" />
                <div className="flex items-center gap-1.5">
                  <Calendar className="w-4 h-4" />
                  <span>Last modified {project.lastModified}</span>
                </div>
                <div className="w-px bg-gray-200" />
                <div>
                  Current: <span className="font-medium text-gray-900">{project.currentPhase}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
