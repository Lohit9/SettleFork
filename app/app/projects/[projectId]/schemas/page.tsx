'use client'

import { useState } from 'react'
import { useParams } from 'next/navigation'
import { CursorTabs } from '@/components/CursorTabs'
import { Table, Eye, Search, BarChart } from '@/components/icons'
import { SchemaIngestion } from '@/components/app/SchemaIngestion'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export default function DataOverviewPage() {
  const params = useParams()
  const projectId = params.projectId as string
  const [activeTab, setActiveTab] = useState('schema-overview')

  const tabs = [
    { id: 'schema-overview', label: 'Schema Overview', icon: Table },
    { id: 'data-preview', label: 'Data Preview', icon: Eye },
    { id: 'query-data', label: 'Query Data', icon: Search },
    { id: 'data-profiling', label: 'Data Profiling', icon: BarChart },
  ]

  return (
    <div className="flex-1 bg-gray-50 flex flex-col">
      {/* Page Header */}
      <div className="border-b border-gray-200 bg-white p-6">
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">Data Overview</h1>
        <p className="text-sm text-gray-600">Explore source and target data structures</p>
      </div>

      {/* Cursor-style Tabs */}
      <CursorTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'schema-overview' && (
          <div className="p-6">
            <SchemaIngestion projectId={projectId} />
          </div>
        )}

        {activeTab === 'data-preview' && (
          <div className="overflow-auto">
            <DataPreviewTab />
          </div>
        )}

        {activeTab === 'query-data' && (
          <div className="overflow-auto">
            <QueryDataTab />
          </div>
        )}

        {activeTab === 'data-profiling' && (
          <div className="overflow-auto">
            <DataProfilingTab />
          </div>
        )}
      </div>
    </div>
  )
}

// Data Preview Tab Component
function DataPreviewTab() {
  const [selectedTable, setSelectedTable] = useState('Account')
  const tables = ['Account', 'Contact', 'Opportunity', 'CUSTOMER', 'CONTACT_PERSON']

  // Mock data for preview
  const mockData: Record<string, any[]> = {
    Account: [
      { Id: '001xx000003DGbQAAW', Name: 'Acme Corp', Type: 'Customer', Industry: 'Technology', AnnualRevenue: 5000000 },
      { Id: '001xx000003DGbRAAW', Name: 'Global Industries', Type: 'Customer', Industry: 'Manufacturing', AnnualRevenue: 12000000 },
      { Id: '001xx000003DGbSAAW', Name: 'Tech Solutions Inc', Type: 'Partner', Industry: 'Technology', AnnualRevenue: 8000000 },
      { Id: '001xx000003DGbTAAW', Name: 'Retail Partners', Type: 'Customer', Industry: 'Retail', AnnualRevenue: 3000000 },
      { Id: '001xx000003DGbUAAW', Name: 'Enterprise Systems', Type: 'Customer', Industry: 'Technology', AnnualRevenue: 15000000 },
    ],
    Contact: [
      { Id: '003xx000004DGbQAAW', FirstName: 'John', LastName: 'Doe', Email: 'john.doe@example.com', AccountId: '001xx000003DGbQAAW' },
      { Id: '003xx000004DGbRAAW', FirstName: 'Jane', LastName: 'Smith', Email: 'jane.smith@example.com', AccountId: '001xx000003DGbRAAW' },
      { Id: '003xx000004DGbSAAW', FirstName: 'Bob', LastName: 'Johnson', Email: 'bob.johnson@example.com', AccountId: '001xx000003DGbSAAW' },
      { Id: '003xx000004DGbTAAW', FirstName: 'Alice', LastName: 'Williams', Email: 'alice.williams@example.com', AccountId: '001xx000003DGbTAAW' },
      { Id: '003xx000004DGbUAAW', FirstName: 'Charlie', LastName: 'Brown', Email: 'charlie.brown@example.com', AccountId: '001xx000003DGbUAAW' },
    ],
  }

  const previewData = mockData[selectedTable] || mockData.Account
  const columns = previewData.length > 0 ? Object.keys(previewData[0]) : []

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-4">
        <Label htmlFor="preview-table-select" className="text-sm font-medium text-gray-700">
          Select Table:
        </Label>
        <Select value={selectedTable} onValueChange={(val) => setSelectedTable(val)}>
          <SelectTrigger id="preview-table-select" className="h-9 text-sm w-[240px]">
            <SelectValue placeholder="Select table…" />
          </SelectTrigger>
          <SelectContent>
            {tables.map((table) => (
              <SelectItem key={table} value={table}>{table}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Data Preview</CardTitle>
            <span className="text-xs text-gray-500">Sample data preview (first 5 rows)</span>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  {columns.map((col) => (
                    <th key={col} className="text-left py-2 px-3 font-medium text-gray-700">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewData.map((row, idx) => (
                  <tr key={idx} className="border-b border-gray-100 hover:bg-gray-50">
                    {columns.map((col) => (
                      <td key={col} className="py-2 px-3 text-gray-900">
                        {String(row[col] || '—')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// Query Data Tab Component
function QueryDataTab() {
  const [queryMode, setQueryMode] = useState<'natural' | 'sql'>('natural')
  const [naturalQuery, setNaturalQuery] = useState('')
  const [sqlQuery, setSqlQuery] = useState('')

  const handleExecute = () => {
    if (queryMode === 'natural') {
      console.log('Natural language query:', naturalQuery)
      // TODO: Wire to backend
    } else {
      console.log('SQL query:', sqlQuery)
      // TODO: Wire to backend
    }
  }

  return (
    <div className="p-6 space-y-4">
      {/* Info Banner */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-sm text-blue-800">
          Use this to explore and understand data. This does not modify data.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Query Editor</CardTitle>
            <div className="flex gap-2">
              <button
                onClick={() => setQueryMode('natural')}
                className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                  queryMode === 'natural'
                    ? 'bg-[#4F46E5] text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                Natural Language
              </button>
              <button
                onClick={() => setQueryMode('sql')}
                className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                  queryMode === 'sql'
                    ? 'bg-[#4F46E5] text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                SQL
              </button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {queryMode === 'natural' ? (
            <>
              <Input
                placeholder="e.g., Show me all accounts with more than 10 contacts"
                value={naturalQuery}
                onChange={(e) => setNaturalQuery(e.target.value)}
              />
              <Button
                onClick={handleExecute}
                className="bg-[#4F46E5] hover:bg-[#4338CA] text-white"
                disabled={!naturalQuery.trim()}
              >
                Generate & Execute Query
              </Button>
            </>
          ) : (
            <>
              <Textarea
                placeholder="SELECT * FROM accounts WHERE ..."
                value={sqlQuery}
                onChange={(e) => setSqlQuery(e.target.value)}
                className="min-h-32 font-mono text-sm"
              />
              <Button
                onClick={handleExecute}
                className="bg-[#4F46E5] hover:bg-[#4338CA] text-white"
                disabled={!sqlQuery.trim()}
              >
                Execute Query
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// Data Profiling Tab Component
function DataProfilingTab() {
  const [selectedTable, setSelectedTable] = useState('Account')
  const tables = ['Account', 'Contact', 'Opportunity', 'CUSTOMER', 'CONTACT_PERSON']

  // Mock profiling data
  const mockProfiling: Record<string, { totalRows: number; totalFields: number; formatIssues: number; fields: any[] }> = {
    Account: {
      totalRows: 1250,
      totalFields: 5,
      formatIssues: 3,
      fields: [
        { name: 'Id', nullPercent: 0, cardinality: 1250, uniquePercent: 100, formatIssues: 0 },
        { name: 'Name', nullPercent: 0, cardinality: 1180, uniquePercent: 94.4, formatIssues: 0 },
        { name: 'Type', nullPercent: 5.2, cardinality: 4, uniquePercent: 0.3, formatIssues: 0 },
        { name: 'Industry', nullPercent: 12.8, cardinality: 12, uniquePercent: 1, formatIssues: 2 },
        { name: 'AnnualRevenue', nullPercent: 18.4, cardinality: 890, uniquePercent: 71.2, formatIssues: 1 },
      ],
    },
    Contact: {
      totalRows: 3420,
      totalFields: 5,
      formatIssues: 5,
      fields: [
        { name: 'Id', nullPercent: 0, cardinality: 3420, uniquePercent: 100, formatIssues: 0 },
        { name: 'FirstName', nullPercent: 8.2, cardinality: 2890, uniquePercent: 84.5, formatIssues: 2 },
        { name: 'LastName', nullPercent: 0, cardinality: 3120, uniquePercent: 91.2, formatIssues: 1 },
        { name: 'Email', nullPercent: 15.6, cardinality: 2980, uniquePercent: 87.1, formatIssues: 2 },
        { name: 'AccountId', nullPercent: 2.1, cardinality: 890, uniquePercent: 26, formatIssues: 0 },
      ],
    },
  }

  const profiling = mockProfiling[selectedTable] || mockProfiling.Account

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Label htmlFor="profiling-table-select" className="text-sm font-medium text-gray-700">
          Select Table:
        </Label>
        <Select value={selectedTable} onValueChange={(val) => setSelectedTable(val)}>
          <SelectTrigger id="profiling-table-select" className="h-9 text-sm w-[240px]">
            <SelectValue placeholder="Select table…" />
          </SelectTrigger>
          <SelectContent>
            {tables.map((table) => (
              <SelectItem key={table} value={table}>{table}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Summary Metrics */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-sm text-gray-500 mb-1">Total Rows</div>
            <div className="text-2xl font-semibold text-gray-900">{profiling.totalRows.toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-sm text-gray-500 mb-1">Total Fields</div>
            <div className="text-2xl font-semibold text-gray-900">{profiling.totalFields}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-sm text-gray-500 mb-1">Format Issues</div>
            <div className="text-2xl font-semibold text-red-600">{profiling.formatIssues}</div>
          </CardContent>
        </Card>
      </div>

      {/* Field-Level Profiling Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Field-Level Profiling</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-3 font-medium text-gray-700">Field Name</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-700">Null %</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-700">Cardinality</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-700">Unique %</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-700">Format Issues</th>
                </tr>
              </thead>
              <tbody>
                {profiling.fields.map((field, idx) => (
                  <tr key={idx} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-2 px-3 text-gray-900 font-medium">{field.name}</td>
                    <td className="py-2 px-3 text-right text-gray-600">{field.nullPercent}%</td>
                    <td className="py-2 px-3 text-right text-gray-600">{field.cardinality.toLocaleString()}</td>
                    <td className="py-2 px-3 text-right text-gray-600">{field.uniquePercent}%</td>
                    <td className="py-2 px-3 text-right">
                      {field.formatIssues > 0 ? (
                        <span className="text-red-600 font-medium">{field.formatIssues}</span>
                      ) : (
                        <span className="text-gray-400">0</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
