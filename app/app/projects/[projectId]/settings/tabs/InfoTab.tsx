'use client'

import type { ProjectSettingsInfo } from '../ProjectSettingsContent'

// Static info card. Mirrors the field set surfaced by the deleted
// `ProjectInfoPopover` (project name, source system, target system,
// created date) — the popover content moved here verbatim.
export default function InfoTab({ info }: { info: ProjectSettingsInfo }) {
  const formattedDate = new Date(info.createdAt).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })

  const fields: Array<{ label: string; value: string }> = [
    { label: 'Project', value: info.projectName },
    { label: 'Source System', value: info.sourceSystem ?? '—' },
    { label: 'Target System', value: info.targetSystem ?? '—' },
    { label: 'Created', value: formattedDate },
  ]

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-900">Project info</h3>
      </div>
      <div className="divide-y divide-gray-100">
        {fields.map((f) => (
          <div
            key={f.label}
            className="flex items-center px-5 py-3 gap-4"
          >
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wide w-32 flex-shrink-0">
              {f.label}
            </span>
            <span className="text-sm text-gray-900">{f.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
