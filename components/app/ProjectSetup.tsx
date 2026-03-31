'use client'

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface ProjectSetupProps {
  onNext: () => void;
}

export function ProjectSetup({ onNext }: ProjectSetupProps) {
  const [projectName, setProjectName] = useState('');
  const [sourceSystem, setSourceSystem] = useState('');
  const [targetSystem, setTargetSystem] = useState('');
  const [notes, setNotes] = useState('');

  const handleCreate = () => {
    if (projectName && sourceSystem && targetSystem) {
      onNext();
    }
  };

  return (
    <div className="flex-1 bg-gray-50 p-8">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold text-gray-900 mb-8">Create Project</h1>
        
        <div className="bg-white rounded-xl border border-gray-200 p-8">
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
                Notes (Optional)
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

          <div className="mt-8 flex justify-end">
            <Button
              onClick={handleCreate}
              disabled={!projectName || !sourceSystem || !targetSystem}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              Create Project
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
