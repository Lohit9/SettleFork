const PHASE_LABELS = ['Ingestion', 'Mapping', 'Transform', 'Validate', 'Complete']

interface PhaseProgressBarProps {
  currentPhase: number
  showLabels?: boolean
}

export function PhaseProgressBar({ currentPhase, showLabels = false }: PhaseProgressBarProps) {
  return (
    <div className="w-full">
      <div className="flex gap-1">
        {PHASE_LABELS.map((label, i) => {
          const phase = i + 1
          let color: string
          if (phase < currentPhase) {
            color = 'bg-green-500'
          } else if (phase === currentPhase) {
            color = 'bg-amber-500'
          } else {
            color = 'bg-[#2a2a2a]'
          }
          return <div key={label} className={`flex-1 h-1 rounded-full ${color}`} />
        })}
      </div>
      {showLabels && (
        <div className="flex mt-1.5">
          {PHASE_LABELS.map((label) => (
            <div key={label} className="flex-1 text-[10px] text-gray-600 text-center leading-none">
              {label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
