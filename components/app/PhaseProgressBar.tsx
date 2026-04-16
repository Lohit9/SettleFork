const PHASES = ['Ingestion', 'Mapping', 'Transform', 'Validate', 'Complete'] as const

interface PhaseProgressBarProps {
  currentPhase: number
  showLabels?: boolean
}

export function PhaseProgressBar({
  currentPhase,
  showLabels = false,
}: PhaseProgressBarProps) {
  return (
    <div className="w-full">
      {/* Dot row — flat siblings: dot · line · dot · line · dot · line · dot · line · dot */}
      <div className="flex items-center">
        {PHASES.map((phase, i) => {
          const phaseNum = i + 1
          const isCompleted = phaseNum < currentPhase
          const isCurrent = phaseNum === currentPhase

          return (
            <div key={phase} className="contents">
              {/* Connector line before each dot except the first */}
              {i > 0 && (
                <div
                  className={`flex-1 h-px ${
                    isCompleted
                      ? 'bg-settle-slate-300'
                      : 'bg-settle-slate-200'
                  }`}
                />
              )}

              {/* Dot */}
              <div className="flex flex-col items-center flex-shrink-0">
                <div
                  className={`w-2 h-2 rounded-full transition-colors ${
                    isCompleted
                      ? 'bg-settle-slate-400'
                      : isCurrent
                      ? 'bg-settle-blue-500'
                      : 'bg-settle-slate-200'
                  }`}
                />
              </div>
            </div>
          )
        })}
      </div>

      {/* Label row — only rendered when showLabels is true */}
      {showLabels && (
        <div className="flex mt-1.5">
          {PHASES.map((phase, i) => {
            const phaseNum = i + 1
            const isCompleted = phaseNum < currentPhase
            const isCurrent = phaseNum === currentPhase

            return (
              <div
                key={phase}
                className={`flex-1 text-[10px] text-center leading-none ${
                  isCurrent
                    ? 'text-settle-blue-500 font-medium'
                    : isCompleted
                    ? 'text-settle-slate-400'
                    : 'text-settle-slate-300'
                }`}
              >
                {phase}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
