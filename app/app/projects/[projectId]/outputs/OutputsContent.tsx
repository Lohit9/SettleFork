'use client'

import { useState, useTransition, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Download,
  RefreshCw,
  ArrowRight,
  Zap,
  Sparkles,
} from '@/components/icons'
import {
  generateGoldStandardCSVs,
  generateSQLLoadScripts,
  generateReadinessReport,
  generateMappingFile,
  generateTransformSpecs,
  generateFixLog,
  generateDataDictionary,
} from '@/lib/actions/outputs'
import type { OutputsPageData, GeneratedFile, ExistingOutput } from '@/lib/actions/outputs'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  projectId: string
  initialData: OutputsPageData
}

interface DeliverableState {
  downloadUrl: string
  version: string
  generatedAt: string
}

type ToastState = { message: string; type: 'success' | 'error' }

// ── Color helpers ─────────────────────────────────────────────────────────────

function phaseColor(color: string) {
  switch (color) {
    case 'green': return { bg: 'bg-green-500', text: 'text-green-700', badge: 'bg-green-100 text-green-700 border-green-200' }
    case 'yellow': return { bg: 'bg-yellow-400', text: 'text-yellow-700', badge: 'bg-yellow-100 text-yellow-700 border-yellow-200' }
    case 'red': return { bg: 'bg-red-500', text: 'text-red-700', badge: 'bg-red-100 text-red-700 border-red-200' }
    default: return { bg: 'bg-gray-300', text: 'text-gray-500', badge: 'bg-gray-100 text-gray-500 border-gray-200' }
  }
}

function readinessColor(status: string) {
  if (status === 'ready') return 'text-green-600'
  if (status === 'at_risk') return 'text-yellow-600'
  return 'text-red-600'
}

function readinessBg(status: string) {
  if (status === 'ready') return 'bg-green-50 border-green-200'
  if (status === 'at_risk') return 'bg-yellow-50 border-yellow-200'
  return 'bg-red-50 border-red-200'
}

function decisionIcon(type: string) {
  switch (type) {
    case 'mapping': return '→'
    case 'fix': return '✓'
    case 'risk': return '⚠'
    case 'transform': return '<>'
    case 'rule': return '⊕'
    default: return '•'
  }
}

function decisionDotColor(type: string) {
  switch (type) {
    case 'mapping': return 'bg-indigo-500'
    case 'fix': return 'bg-green-500'
    case 'risk': return 'bg-yellow-500'
    case 'transform': return 'bg-purple-500'
    case 'rule': return 'bg-blue-500'
    default: return 'bg-gray-400'
  }
}

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return iso
  }
}

function fmtDateTime(iso: string) {
  try {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  } catch {
    return iso
  }
}

// ── OutputsContent ────────────────────────────────────────────────────────────

export default function OutputsContent({ projectId, initialData }: Props) {
  const router = useRouter()
  const [data] = useState<OutputsPageData>(initialData)

  // Gold standard
  const [goldFormat, setGoldFormat] = useState<'csv' | 'sql'>('csv')
  const [goldFiles, setGoldFiles] = useState<GeneratedFile[]>([])
  const [isGeneratingGold, startGeneratingGold] = useTransition()
  const [goldProgress, setGoldProgress] = useState<string | null>(null)

  // Deliverables: keyed by `type_format`
  const [deliverableMap, setDeliverableMap] = useState<Record<string, DeliverableState>>(
    () => buildInitialDeliverableMap(initialData.existingOutputs)
  )
  const [generatingKey, setGeneratingKey] = useState<string | null>(null)
  const [allGenProgress, setAllGenProgress] = useState<string | null>(null)

  // Decisions log
  const [showAllDecisions, setShowAllDecisions] = useState(false)

  // Toast
  const [toast, setToast] = useState<ToastState | null>(null)

  function showToast(message: string, type: ToastState['type']) {
    setToast({ message, type })
    setTimeout(() => setToast(null), 4000)
  }

  // ── Gold standard handlers ──────────────────────────────────────────────

  function handleGenerateGold() {
    setGoldProgress('Building transformation queries…')
    startGeneratingGold(async () => {
      const result = goldFormat === 'csv'
        ? await generateGoldStandardCSVs(projectId)
        : await generateSQLLoadScripts(projectId)
      setGoldProgress(null)
      if (!result.success && result.error) { showToast(result.error, 'error'); return }
      if (result.files.length === 0) { showToast('No files generated — check that mappings are approved.', 'error'); return }
      setGoldFiles(result.files)
      if (result.errors?.length) showToast(`Generated ${result.files.length} file(s) with ${result.errors.length} error(s).`, 'error')
      else showToast(`Generated ${result.files.length} Gold Standard file${result.files.length !== 1 ? 's' : ''}`, 'success')
    })
  }

  // ── Deliverable handler ─────────────────────────────────────────────────

  const handleGenerateDeliverable = useCallback(
    async (key: string) => {
      setGeneratingKey(key)
      const [type, format] = key.split('_') as [string, string]

      let result: { success: boolean; downloadUrl?: string; version?: string; error?: string }

      try {
        if (type === 'readiness' && format === 'report') {
          result = await generateReadinessReport(projectId, 'markdown')
        } else if (type === 'mapping' && format === 'csv') {
          result = await generateMappingFile(projectId, 'csv')
        } else if (type === 'mapping' && format === 'json') {
          result = await generateMappingFile(projectId, 'json')
        } else if (type === 'transform' && format === 'specs') {
          result = await generateTransformSpecs(projectId, 'sql')
        } else if (type === 'fix' && format === 'log') {
          result = await generateFixLog(projectId, 'csv')
        } else if (type === 'data' && format === 'dictionary') {
          result = await generateDataDictionary(projectId, 'csv')
        } else {
          result = { success: false, error: 'Unknown deliverable type' }
        }
      } catch (err) {
        result = { success: false, error: String(err) }
      }

      setGeneratingKey(null)
      if (!result.success || !result.downloadUrl) {
        showToast(result.error ?? 'Generation failed', 'error')
        return
      }
      setDeliverableMap((prev) => ({
        ...prev,
        [key]: { downloadUrl: result.downloadUrl!, version: result.version ?? '1.0', generatedAt: new Date().toISOString() },
      }))
      showToast('Generated successfully', 'success')
    },
    [projectId]
  )

  // ── Generate all deliverables sequentially ──────────────────────────────

  async function handleGenerateAll() {
    const steps: { key: string; label: string }[] = [
      { key: 'readiness_report', label: 'Generating readiness report…' },
      { key: 'mapping_csv', label: 'Generating mapping file…' },
      { key: 'transform_specs', label: 'Generating transformation specs…' },
      { key: 'fix_log', label: 'Generating fix log…' },
      { key: 'data_dictionary', label: 'Generating data dictionary…' },
    ]

    for (const step of steps) {
      setAllGenProgress(step.label)
      await handleGenerateDeliverable(step.key)
    }

    setAllGenProgress(null)
    showToast('All deliverables generated', 'success')
  }

  // ── Computed values ─────────────────────────────────────────────────────

  const { phases, metrics, decisions, outstanding, existingOutputs } = data
  const displayedDecisions = showAllDecisions ? decisions : decisions.slice(0, 5)
  const hasOutstanding = outstanding.unmappedSourceFields > 0 || outstanding.blockingIssues > 0 || outstanding.untestedTransforms > 0 || outstanding.unsavedTransforms > 0
  const canGenerateGold = data.hasMappings && data.hasSourceData

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 overflow-auto bg-gray-50">
      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium ${toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
          {toast.message}
        </div>
      )}

      <div className="max-w-5xl mx-auto p-6 pb-16 space-y-6">

        {/* ════════════════════════════════════════════════════
            SECTION 1 — MIGRATION STATUS DASHBOARD
        ════════════════════════════════════════════════════ */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Migration Center</h1>
          <p className="text-sm text-gray-500 mb-5">Your migration deliverables and project status</p>

          <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <div className="px-6 py-5 border-b border-gray-100">
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-base font-semibold text-gray-900">Migration Status</h2>
                <span className="text-sm text-gray-500">{phases.completedCount} of 5 phases complete</span>
              </div>
              <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden mt-3">
                <div className="h-full bg-[#4F46E5] rounded-full transition-all" style={{ width: `${(phases.completedCount / 5) * 100}%` }} />
              </div>
            </div>

            {/* Phase progress bar */}
            <div className="px-6 py-5 border-b border-gray-100">
              <div className="flex items-center gap-1">
                {[
                  { id: 'ingestion', label: 'Data Ingestion', color: phases.dataIngestion === 'complete' ? 'green' : 'gray' },
                  { id: 'quality', label: 'Validate', color: phases.dataQuality },
                  { id: 'mapping', label: 'Mapping', color: phases.mapping },
                  { id: 'transforms', label: 'Transforms', color: phases.transformations },
                  { id: 'validation', label: 'Validation', color: phases.validation },
                ].map((phase, i, arr) => {
                  const colors = phaseColor(phase.color)
                  return (
                    <div key={phase.id} className="flex items-center flex-1">
                      <div className="flex-1 flex flex-col items-center gap-1.5">
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center ${colors.bg}`}>
                          {(phase.color === 'green') ? (
                            <CheckCircle2 className="w-4 h-4 text-white" />
                          ) : (
                            <span className="text-white text-xs font-bold">{i + 1}</span>
                          )}
                        </div>
                        <span className={`text-[10px] font-medium text-center leading-tight ${colors.text}`}>{phase.label}</span>
                      </div>
                      {i < arr.length - 1 && <div className="h-0.5 flex-1 bg-gray-200 mb-4 mx-1" />}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Key metrics */}
            <div className="grid grid-cols-4 divide-x divide-gray-100 border-b border-gray-100">
              {/* Readiness */}
              <div className={`px-5 py-4 ${readinessBg(metrics.readinessStatus)} border-l-0`}>
                <p className="text-xs text-gray-500 font-medium mb-1">Migration Readiness</p>
                <p className={`text-2xl font-bold ${readinessColor(metrics.readinessStatus)}`}>{metrics.readinessScore}%</p>
                <p className={`text-xs font-medium mt-0.5 ${readinessColor(metrics.readinessStatus)}`}>
                  {metrics.readinessStatus === 'ready' ? 'Ready' : metrics.readinessStatus === 'at_risk' ? 'At Risk' : 'Not Ready'}
                </p>
              </div>

              {/* Mapping coverage */}
              <div className="px-5 py-4">
                <p className="text-xs text-gray-500 font-medium mb-1">Mapping Coverage</p>
                <p className="text-2xl font-bold text-gray-900">{metrics.approvedFieldMappings}<span className="text-sm font-normal text-gray-400"> / {metrics.totalSourceFields}</span></p>
                <div className="mt-2 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${metrics.totalSourceFields > 0 ? Math.round((metrics.approvedFieldMappings / metrics.totalSourceFields) * 100) : 0}%` }} />
                </div>
                <p className="text-xs text-gray-400 mt-1">{metrics.totalSourceFields > 0 ? Math.round((metrics.approvedFieldMappings / metrics.totalSourceFields) * 100) : 0}% fields approved</p>
              </div>

              {/* Quality issues */}
              <div className="px-5 py-4">
                <p className="text-xs text-gray-500 font-medium mb-1">Quality Issues</p>
                {metrics.openBlocking === 0 && metrics.openWarnings === 0 ? (
                  <p className="text-2xl font-bold text-green-600">Clear</p>
                ) : (
                  <p className="text-2xl font-bold text-gray-900">
                    {metrics.openBlocking > 0 && <span className="text-red-600">{metrics.openBlocking} blocking</span>}
                    {metrics.openBlocking > 0 && metrics.openWarnings > 0 && <span className="text-gray-300">, </span>}
                    {metrics.openWarnings > 0 && <span className="text-yellow-600 text-lg">{metrics.openWarnings} warn</span>}
                  </p>
                )}
                <p className="text-xs text-gray-400 mt-1">
                  {metrics.openBlocking === 0 && metrics.openWarnings === 0 ? 'No open issues' : 'open issues'}
                </p>
              </div>

              {/* Transforms */}
              <div className="px-5 py-4">
                <p className="text-xs text-gray-500 font-medium mb-1">Transforms</p>
                <p className="text-2xl font-bold text-gray-900">{metrics.savedTransforms}<span className="text-sm font-normal text-gray-400"> / {metrics.totalTransforms}</span></p>
                {metrics.totalTransforms > 0 && (
                  <div className="mt-2 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-purple-500 rounded-full" style={{ width: `${Math.round((metrics.savedTransforms / metrics.totalTransforms) * 100)}%` }} />
                  </div>
                )}
                <p className="text-xs text-gray-400 mt-1">{metrics.totalTransforms === 0 ? 'None needed' : 'saved'}</p>
              </div>
            </div>

            {/* Decisions log */}
            {decisions.length > 0 && (
              <div className="px-6 py-5 border-b border-gray-100">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-gray-800">Decisions & Actions Log</h3>
                  <span className="text-xs text-gray-400">{data.totalDecisions} total</span>
                </div>
                <div className="space-y-2">
                  {displayedDecisions.map((entry) => (
                    <div key={entry.id} className="flex items-start gap-3">
                      <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${decisionDotColor(entry.type)}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-gray-700 truncate">{entry.label}</p>
                      </div>
                      <span className="text-[10px] text-gray-400 flex-shrink-0">{fmtDate(entry.timestamp)}</span>
                    </div>
                  ))}
                </div>
                {decisions.length > 5 && (
                  <button
                    className="mt-3 text-xs text-indigo-600 hover:text-indigo-700 font-medium"
                    onClick={() => setShowAllDecisions((v) => !v)}
                  >
                    {showAllDecisions ? 'Show less' : `Show all ${decisions.length} decisions`}
                  </button>
                )}
              </div>
            )}

            {/* Outstanding items */}
            <div className="px-6 py-5">
              <h3 className="text-sm font-semibold text-gray-800 mb-3">Outstanding Items</h3>
              {!hasOutstanding ? (
                <div className="flex items-center gap-2 text-green-600">
                  <CheckCircle2 className="w-4 h-4" />
                  <span className="text-sm font-medium">All items resolved — ready to generate outputs</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {outstanding.unmappedSourceFields > 0 && (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-yellow-400" />
                        <span className="text-sm text-gray-700">{outstanding.unmappedSourceFields} unmapped source field{outstanding.unmappedSourceFields !== 1 ? 's' : ''}</span>
                      </div>
                      <a href={`/app/projects/${projectId}/mapping`} className="text-xs text-indigo-600 hover:underline">Go to Mapping →</a>
                    </div>
                  )}
                  {outstanding.blockingIssues > 0 && (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-red-500" />
                        <span className="text-sm text-gray-700">{outstanding.blockingIssues} blocking quality issue{outstanding.blockingIssues !== 1 ? 's' : ''}</span>
                      </div>
                      <a href={`/app/projects/${projectId}/data-quality`} className="text-xs text-indigo-600 hover:underline">Go to Validate →</a>
                    </div>
                  )}
                  {outstanding.untestedTransforms > 0 && (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-orange-400" />
                        <span className="text-sm text-gray-700">{outstanding.untestedTransforms} untested transform{outstanding.untestedTransforms !== 1 ? 's' : ''}</span>
                      </div>
                      <a href={`/app/projects/${projectId}/transform`} className="text-xs text-indigo-600 hover:underline">Go to Transform →</a>
                    </div>
                  )}
                  {outstanding.unsavedTransforms > 0 && (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-purple-400" />
                        <span className="text-sm text-gray-700">{outstanding.unsavedTransforms} unsaved transform{outstanding.unsavedTransforms !== 1 ? 's' : ''}</span>
                      </div>
                      <a href={`/app/projects/${projectId}/transform`} className="text-xs text-indigo-600 hover:underline">Go to Transform →</a>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ════════════════════════════════════════════════════
            SECTION 2 — GOLD STANDARD FILES
        ════════════════════════════════════════════════════ */}
        <div>
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-gray-900">Gold Standard Files</h2>
              <p className="text-sm text-gray-500 mt-0.5">Production-ready data files with all transformations applied, ready to load into your target system</p>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <div className="p-6">
              {/* Warning banners */}
              {outstanding.blockingIssues > 0 && (
                <div className="mb-4 flex gap-2 items-start p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span><strong>{outstanding.blockingIssues} blocking quality issue{outstanding.blockingIssues !== 1 ? 's' : ''} remain.</strong> Generated files may contain data that will fail on load. Resolve issues in Validate first.</span>
                </div>
              )}
              {outstanding.unmappedSourceFields > 0 && (
                <div className="mb-4 flex gap-2 items-start p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700">
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>{outstanding.unmappedSourceFields} source field{outstanding.unmappedSourceFields !== 1 ? 's are' : ' is'} unmapped and will not be included in output files.</span>
                </div>
              )}
              {outstanding.untestedTransforms > 0 && (
                <div className="mb-4 flex gap-2 items-start p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>{outstanding.untestedTransforms} transformation{outstanding.untestedTransforms !== 1 ? 's have' : ' has'} not been tested. Review in the Transform tab.</span>
                </div>
              )}

              {/* Format toggle + generate button */}
              <div className="flex items-center gap-3 mb-5">
                <div className="flex items-center bg-gray-100 rounded-lg p-1 gap-1">
                  {(['csv', 'sql'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      onClick={() => setGoldFormat(fmt)}
                      className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${goldFormat === fmt ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                    >
                      {fmt === 'csv' ? 'Transformed CSVs' : 'SQL Load Scripts'}
                    </button>
                  ))}
                </div>

                <Button
                  className="bg-[#4F46E5] hover:bg-[#4338CA] text-white gap-2 ml-auto"
                  onClick={handleGenerateGold}
                  disabled={isGeneratingGold || !canGenerateGold}
                >
                  <Zap className="w-4 h-4" />
                  {isGeneratingGold ? goldProgress ?? 'Generating…' : `Generate Gold Standard ${goldFormat === 'csv' ? 'CSVs' : 'SQL Scripts'}`}
                </Button>
              </div>

              {!canGenerateGold && (
                <p className="text-sm text-gray-400 mb-4">Approve at least one table mapping and upload source data to enable file generation.</p>
              )}

              {/* Generated file cards */}
              {goldFiles.length > 0 && (
                <div className="space-y-3 mt-2">
                  {goldFiles.map((file) => (
                    <div key={file.outputId} className="flex items-center justify-between p-4 bg-gray-50 border border-gray-200 rounded-lg">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-semibold text-gray-900">{file.tableName}</span>
                          <Badge className="bg-indigo-100 text-indigo-700 hover:bg-indigo-100 border-indigo-200 text-[10px]">
                            {goldFormat.toUpperCase()}
                          </Badge>
                          <Badge className="bg-gray-100 text-gray-500 hover:bg-gray-100 border-gray-200 text-[10px]">
                            v{file.version}
                          </Badge>
                        </div>
                        <p className="text-xs text-gray-500">From {data.sourceDataset?.name ?? 'source'}.{file.sourceTableName} · {file.rowCount.toLocaleString()} records</p>
                      </div>
                      <a
                        href={file.downloadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-700 border border-indigo-200 rounded-lg hover:bg-indigo-50 transition-colors"
                      >
                        <Download className="w-4 h-4" />
                        Download
                      </a>
                    </div>
                  ))}
                </div>
              )}

              {/* Previously generated files from DB */}
              {goldFiles.length === 0 && (() => {
                const prevGold = existingOutputs.filter((o) => o.type === 'gold_standard_csv' || o.type === 'gold_standard_sql')
                if (prevGold.length === 0) return null
                return (
                  <div>
                    <p className="text-xs text-gray-500 mb-3 font-medium">Previously generated</p>
                    <div className="space-y-2">
                      {prevGold.slice(0, 5).map((o) => (
                        <div key={o.id} className="flex items-center justify-between p-3 bg-gray-50 border border-gray-200 rounded-lg">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-700">{o.tableName ?? o.file_storage_path?.split('/').pop()}</span>
                              <Badge className="bg-gray-100 text-gray-500 hover:bg-gray-100 border-gray-200 text-[10px]">v{o.version}</Badge>
                            </div>
                            <p className="text-xs text-gray-400 mt-0.5">{fmtDateTime(o.generated_at)}</p>
                          </div>
                          {o.signedUrl && (
                            <a href={o.signedUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-600 hover:underline flex items-center gap-1">
                              <Download className="w-3 h-3" />Download
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}
            </div>
          </div>
        </div>

        {/* ════════════════════════════════════════════════════
            SECTION 3 — DELIVERABLE PACKAGE
        ════════════════════════════════════════════════════ */}
        <div>
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-gray-900">Deliverable Package</h2>
              <p className="text-sm text-gray-500 mt-0.5">Migration documentation and reports for stakeholders, QA, and project records</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-2 flex-shrink-0 mt-1"
              onClick={handleGenerateAll}
              disabled={generatingKey !== null}
            >
              <Sparkles className="w-3.5 h-3.5" />
              {allGenProgress ?? 'Generate All Deliverables'}
            </Button>
          </div>

          <div className="space-y-3">
            {/* Readiness Report */}
            <DeliverableCard
              title="Migration Readiness Report"
              description="AI-generated executive summary with validation results, risk assessment, and go/no-go recommendation"
              icon="📋"
              formats={[{ key: 'readiness_report', label: 'Download Markdown', ext: 'md' }]}
              state={deliverableMap['readiness_report']}
              isGenerating={generatingKey === 'readiness_report'}
              onGenerate={() => handleGenerateDeliverable('readiness_report')}
              existingOutput={existingOutputs.find((o) => o.type === 'readiness_report')}
            />

            {/* Mapping File */}
            <DeliverableCard
              title="Mapping File"
              description="Complete field-to-field mapping specification with confidence scores and type compatibility"
              icon="🗺️"
              formats={[
                { key: 'mapping_csv', label: 'Download CSV', ext: 'csv' },
                { key: 'mapping_json', label: 'Download JSON', ext: 'json' },
              ]}
              stateMap={deliverableMap}
              isGenerating={generatingKey === 'mapping_csv' || generatingKey === 'mapping_json'}
              onGenerateMap={(key) => handleGenerateDeliverable(key)}
              existingOutput={existingOutputs.find((o) => o.type === 'mapping_file')}
            />

            {/* Transform Specs */}
            <DeliverableCard
              title="Transformation Specs"
              description="SQL transformations with source/target field context, status, and descriptions"
              icon="⚙️"
              formats={[{ key: 'transform_specs', label: 'Download SQL', ext: 'sql' }]}
              state={deliverableMap['transform_specs']}
              isGenerating={generatingKey === 'transform_specs'}
              onGenerate={() => handleGenerateDeliverable('transform_specs')}
              existingOutput={existingOutputs.find((o) => o.type === 'transformation_specs')}
            />

            {/* Fix Log */}
            <DeliverableCard
              title="Fix Log & Audit Trail"
              description="Complete chronological record of all data fixes applied and risks accepted"
              icon="📝"
              formats={[{ key: 'fix_log', label: 'Download CSV', ext: 'csv' }]}
              state={deliverableMap['fix_log']}
              isGenerating={generatingKey === 'fix_log'}
              onGenerate={() => handleGenerateDeliverable('fix_log')}
              existingOutput={existingOutputs.find((o) => o.type === 'fix_log')}
            />

            {/* Data Dictionary */}
            <DeliverableCard
              title="Data Dictionary"
              description="Source and target schema documentation with field profiles, data types, and sample values"
              icon="📚"
              formats={[
                { key: 'data_dictionary', label: 'Download CSV', ext: 'csv' },
              ]}
              state={deliverableMap['data_dictionary']}
              isGenerating={generatingKey === 'data_dictionary'}
              onGenerate={() => handleGenerateDeliverable('data_dictionary')}
              existingOutput={existingOutputs.find((o) => o.type === 'data_dictionary')}
            />
          </div>
        </div>

        {/* ════════════════════════════════════════════════════
            NEXT STEPS
        ════════════════════════════════════════════════════ */}
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6">
          <h3 className="text-base font-semibold text-gray-900 mb-4">Next Steps</h3>
          <div className="space-y-3">
            {[
              'Review all outputs with your migration team and stakeholders',
              'Address any blocking issues identified in the readiness report',
              'Use the Gold Standard files to execute a dry-run load in your test environment',
              'Validate record counts and data integrity after the test load',
              'Schedule production cutover once the test load is verified',
            ].map((step, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                  {i + 1}
                </div>
                <p className="text-sm text-gray-700">{step}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Start New Project */}
        <div className="flex justify-center pt-2">
          <Button variant="outline" onClick={() => router.push('/app/projects')} className="gap-2">
            <ArrowRight className="w-4 h-4" />
            Start New Project
          </Button>
        </div>

      </div>
    </div>
  )
}

// ── DeliverableCard ───────────────────────────────────────────────────────────

interface FormatSpec {
  key: string
  label: string
  ext: string
}

interface DeliverableCardProps {
  title: string
  description: string
  icon: string
  formats: FormatSpec[]
  state?: DeliverableState
  stateMap?: Record<string, DeliverableState>
  isGenerating: boolean
  onGenerate?: () => void
  onGenerateMap?: (key: string) => void
  existingOutput?: ExistingOutput
}

function DeliverableCard({ title, description, icon, formats, state, stateMap, isGenerating, onGenerate, onGenerateMap, existingOutput }: DeliverableCardProps) {
  const hasMultiple = formats.length > 1

  const getState = (key: string) => (stateMap ? stateMap[key] : state)

  const activeState = hasMultiple
    ? formats.map((f) => getState(f.key)).find(Boolean)
    : state

  const version = activeState?.version ?? existingOutput?.version
  const generatedAt = activeState?.generatedAt ?? existingOutput?.generated_at

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <span className="text-2xl leading-none mt-0.5">{icon}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
              {version && (
                <Badge className="bg-gray-100 text-gray-500 hover:bg-gray-100 border-gray-200 text-[10px]">v{version}</Badge>
              )}
              {(activeState || existingOutput) && (
                <Badge className="bg-green-100 text-green-700 hover:bg-green-100 border-green-200 text-[10px]">
                  <CheckCircle2 className="w-2.5 h-2.5 mr-1" />Generated
                </Badge>
              )}
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">{description}</p>
            {generatedAt && (
              <p className="text-[10px] text-gray-400 mt-1">Last generated {fmtDateTime(generatedAt)}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Download buttons for existing outputs */}
          {!hasMultiple && (
            <>
              {(activeState?.downloadUrl ?? existingOutput?.signedUrl) && (
                <a
                  href={activeState?.downloadUrl ?? existingOutput?.signedUrl ?? '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-700 border border-indigo-200 rounded-lg hover:bg-indigo-50 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  {formats[0]?.label ?? 'Download'}
                </a>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={onGenerate}
                disabled={isGenerating}
                className="gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isGenerating ? 'animate-spin' : ''}`} />
                {isGenerating ? 'Generating…' : activeState || existingOutput ? 'Regenerate' : 'Generate'}
              </Button>
            </>
          )}

          {/* Multi-format buttons */}
          {hasMultiple && formats.map((fmt) => {
            const fmtState = getState(fmt.key)
            const existingFmt = existingOutput // simplified: same existing output for all
            const dlUrl = fmtState?.downloadUrl ?? (fmt.key.endsWith('json') && existingFmt?.format === 'json' ? existingFmt.signedUrl : fmt.key.endsWith('csv') && existingFmt?.format === 'csv' ? existingFmt.signedUrl : undefined)
            return (
              <div key={fmt.key} className="flex items-center gap-1">
                {dlUrl && (
                  <a href={dlUrl} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-50">
                    <Download className="w-3 h-3" />{fmt.ext.toUpperCase()}
                  </a>
                )}
                <Button size="sm" variant="outline" className="text-xs gap-1 py-1 h-7"
                  onClick={() => onGenerateMap?.(fmt.key)}
                  disabled={isGenerating}
                >
                  <RefreshCw className={`w-3 h-3 ${isGenerating ? 'animate-spin' : ''}`} />
                  {fmtState ? 'Regen' : fmt.ext.toUpperCase()}
                </Button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildInitialDeliverableMap(outputs: ExistingOutput[]): Record<string, DeliverableState> {
  const map: Record<string, DeliverableState> = {}
  const typeToKey: Record<string, string> = {
    readiness_report: 'readiness_report',
    mapping_file: 'mapping_csv',
    transformation_specs: 'transform_specs',
    fix_log: 'fix_log',
    data_dictionary: 'data_dictionary',
  }
  for (const o of outputs) {
    const key = typeToKey[o.type]
    if (key && o.signedUrl) {
      if (!map[key] || new Date(o.generated_at) > new Date(map[key].generatedAt)) {
        map[key] = { downloadUrl: o.signedUrl, version: o.version, generatedAt: o.generated_at }
      }
    }
  }
  return map
}
