'use client'

import { useState } from 'react'

function ToggleSwitch({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
        enabled ? 'bg-[#4F46E5]' : 'bg-gray-200'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ${
          enabled ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

export function PreferencesSection() {
  const [aiFixSuggestions, setAiFixSuggestions] = useState(true)
  const [emailNotifications, setEmailNotifications] = useState(false)

  return (
    <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
      <div className="px-5 py-3.5 flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-900">Default confidence threshold</p>
          <p className="text-xs text-gray-500 mt-0.5">Auto-approve mappings above this confidence level</p>
        </div>
        <span className="text-sm font-medium text-gray-700">90%</span>
      </div>

      <div className="px-5 py-3.5 flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-900">AI fix suggestions</p>
          <p className="text-xs text-gray-500 mt-0.5">Automatically generate fix suggestions for detected issues</p>
        </div>
        <ToggleSwitch enabled={aiFixSuggestions} onChange={setAiFixSuggestions} />
      </div>

      <div className="px-5 py-3.5 flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-900">Email notifications</p>
          <p className="text-xs text-gray-500 mt-0.5">Get notified when long-running operations complete</p>
        </div>
        <ToggleSwitch enabled={emailNotifications} onChange={setEmailNotifications} />
      </div>
    </div>
  )
}
