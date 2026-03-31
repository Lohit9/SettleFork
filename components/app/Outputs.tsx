'use client'

import { Button } from '@/components/ui/button';
import { Download, Copy, FileText, Database, FileCheck } from '@/components/icons';
import { useRouter } from 'next/navigation';

interface OutputsProps {
  projectId: string;
}

const outputs = [
  {
    id: 'mapping',
    title: 'Mapping File',
    description: 'Complete field-to-field mapping specification',
    formats: ['CSV', 'JSON'],
    icon: FileText,
    version: '1.0',
    timestamp: '2026-01-18 14:23:15',
  },
  {
    id: 'transform',
    title: 'Transformation Specs',
    description: 'SQL transformations and human-readable documentation',
    formats: ['SQL', 'PDF'],
    icon: Database,
    version: '1.0',
    timestamp: '2026-01-18 14:23:15',
  },
  {
    id: 'report',
    title: 'Migration Readiness Report',
    description: 'Executive summary with validation results and risk assessment',
    formats: ['PDF', 'DOCX'],
    icon: FileCheck,
    version: '1.0',
    timestamp: '2026-01-18 14:23:15',
  },
];

export function Outputs({ projectId }: OutputsProps) {
  const router = useRouter();

  const handleReset = () => {
    router.push('/app/projects');
  };

  return (
    <div className="flex-1 bg-gray-50 flex flex-col">
      <div className="border-b border-gray-200 bg-white p-6">
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">Outputs</h1>
        <p className="text-sm text-gray-600">
          Download migration artifacts and documentation
        </p>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="grid grid-cols-1 gap-6 max-w-4xl">
          {outputs.map((output) => {
            const Icon = output.icon;
            
            return (
              <div
                key={output.id}
                className="bg-white rounded-xl border border-gray-200 p-6"
              >
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                    <Icon className="w-6 h-6 text-blue-600" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <h3 className="text-lg font-semibold text-gray-900 mb-1">
                      {output.title}
                    </h3>
                    <p className="text-sm text-gray-600 mb-4">
                      {output.description}
                    </p>

                    <div className="flex flex-wrap gap-4 text-xs text-gray-500 mb-4">
                      <div>
                        Version: <span className="font-medium text-gray-900">{output.version}</span>
                      </div>
                      <div className="w-px bg-gray-200" />
                      <div>
                        Generated: <span className="font-medium text-gray-900">{output.timestamp}</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {output.formats.map((format) => (
                        <Button
                          key={format}
                          size="sm"
                          variant="outline"
                          className="gap-2"
                        >
                          <Download className="w-4 h-4" />
                          Download {format}
                        </Button>
                      ))}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-2"
                      >
                        <Copy className="w-4 h-4" />
                        Copy to Clipboard
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-8 bg-white rounded-xl border border-gray-200 p-6 max-w-4xl">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Next Steps</h3>
          <ul className="space-y-2 text-sm text-gray-600">
            <li className="flex items-start gap-2">
              <span className="text-gray-400 mt-0.5">•</span>
              <span>Review all outputs with your migration team and stakeholders</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-gray-400 mt-0.5">•</span>
              <span>Address any blocking issues identified in the validation report</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-gray-400 mt-0.5">•</span>
              <span>Use the transformation specs to implement your ETL process</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-gray-400 mt-0.5">•</span>
              <span>Schedule a dry-run migration in your test environment</span>
            </li>
          </ul>
        </div>

        <div className="mt-6 max-w-4xl">
          <Button
            onClick={handleReset}
            variant="outline"
          >
            Start New Project
          </Button>
        </div>
      </div>
    </div>
  );
}
