import { Database, Table, Search, BarChart } from '@/components/icons'

export default function DataOverviewPage() {
  const tabs = [
    {
      icon: Database,
      label: 'Schema Overview',
      description:
        'Side-by-side view of source and target schemas with expandable tables, field types, and key indicators. Select tables to include in mapping and trigger AI mapping generation.',
    },
    {
      icon: Table,
      label: 'Data Preview',
      description:
        'Browse the first 5–20 rows of your uploaded CSV data. Select any table from the dropdown to preview its actual records.',
    },
    {
      icon: Search,
      label: 'Query Data',
      description:
        'Run natural language or SQL queries against your uploaded data. Mine uses Claude to convert questions into SQL — read-only, no data is modified.',
    },
    {
      icon: BarChart,
      label: 'Data Profiling',
      description:
        'Field-level statistics: null %, cardinality, unique %, and format issues per column — computed automatically during CSV upload.',
    },
  ]

  return (
    <div className="flex-1 bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto space-y-8">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">Data Overview</h1>
          <p className="text-sm text-gray-600">
            Explore your source and target schemas, preview data, profile fields, and run queries.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <div key={tab.label} className="bg-white rounded-lg border border-gray-200 p-6">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-9 h-9 bg-indigo-50 rounded-lg flex items-center justify-center">
                    <Icon className="w-5 h-5 text-indigo-600" />
                  </div>
                  <h3 className="font-semibold text-gray-900">{tab.label}</h3>
                </div>
                <p className="text-sm text-gray-600">{tab.description}</p>
              </div>
            )
          })}
        </div>

        <div className="bg-indigo-50 border border-indigo-100 rounded-lg p-4">
          <p className="text-sm text-indigo-700">
            <strong>Phase 3</strong> will build this section: schema comparison view, paginated data
            preview, Claude-powered NL queries, and precomputed field profiling from CSV uploads.
          </p>
        </div>
      </div>
    </div>
  )
}
