'use client'

interface MigrationFlowDiagramProps {
  sourceSystem: string
  targetSystem: string
}

export default function MigrationFlowDiagram({ sourceSystem, targetSystem }: MigrationFlowDiagramProps) {
  return (
    <div className="max-w-2xl mx-auto py-8 px-6">
      <div className="flex items-center justify-center gap-0">
        {/* Source */}
        <div className="bg-mine-slate-100 border border-mine-slate-200 rounded-xl px-6 py-4 text-center shrink-0">
          <p className="text-sm font-semibold text-mine-slate-800">{sourceSystem}</p>
          <p className="text-xs text-mine-slate-400 mt-1">Source</p>
        </div>

        {/* Line: source → Mine */}
        <div className="flex-1 max-w-[60px] h-0 border-t-2 border-dashed border-mine-slate-300 mx-2" />
        <span className="text-mine-slate-400 text-lg mx-1">→</span>

        {/* Mine */}
        <div className="bg-mine-blue-600 rounded-xl px-6 py-4 text-center shadow-lg shadow-blue-600/20 shrink-0">
          <p className="text-sm font-bold text-white">Mine</p>
          <p className="text-xs text-blue-200 mt-1">AI engine</p>
        </div>

        {/* Line: Mine → target */}
        <span className="text-mine-blue-400 text-lg mx-1">→</span>
        <div className="flex-1 max-w-[60px] h-0 border-t-2 border-dashed border-mine-blue-400 mx-2" />

        {/* Target */}
        <div className="bg-mine-slate-100 border border-mine-slate-200 rounded-xl px-6 py-4 text-center shrink-0">
          <p className="text-sm font-semibold text-mine-slate-800">{targetSystem}</p>
          <p className="text-xs text-mine-slate-400 mt-1">Target</p>
        </div>
      </div>
    </div>
  )
}
