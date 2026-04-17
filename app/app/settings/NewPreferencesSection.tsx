'use client'

import { useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { updateUserPreference, type UserPreferences } from '@/lib/actions/profile'

interface PreferencesSectionProps {
  initialPreferences: UserPreferences
}

export function NewPreferencesSection({ initialPreferences }: PreferencesSectionProps) {
  const [sqlDialect, setSqlDialect] = useState(initialPreferences.default_sql_dialect)
  const [displayDensity, setDisplayDensity] = useState(initialPreferences.table_display_density)

  async function handleDialectChange(value: string) {
    const previous = sqlDialect
    setSqlDialect(value)
    try {
      await updateUserPreference('default_sql_dialect', value)
    } catch {
      setSqlDialect(previous)
    }
  }

  async function handleDensityChange(value: string) {
    const previous = displayDensity
    setDisplayDensity(value)
    try {
      await updateUserPreference('table_display_density', value)
    } catch {
      setDisplayDensity(previous)
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
      <div className="flex items-center justify-between px-5 py-4">
        <div>
          <p className="text-sm font-medium text-gray-900">Default SQL dialect</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Pre-selects the dialect when generating migration scripts
          </p>
        </div>
        <Select value={sqlDialect} onValueChange={handleDialectChange}>
          <SelectTrigger className="h-8 text-xs w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="postgresql">PostgreSQL</SelectItem>
            <SelectItem value="tsql">T-SQL (SQL Server)</SelectItem>
            <SelectItem value="mysql">MySQL</SelectItem>
            <SelectItem value="oracle">Oracle PL/SQL</SelectItem>
            <SelectItem value="sap_hana">SAP HANA</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between px-5 py-4">
        <div>
          <p className="text-sm font-medium text-gray-900">Table display density</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Controls row spacing in field tables across the platform
          </p>
        </div>
        <Select value={displayDensity} onValueChange={handleDensityChange}>
          <SelectTrigger className="h-8 text-xs w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="comfortable">Comfortable</SelectItem>
            <SelectItem value="compact">Compact</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
