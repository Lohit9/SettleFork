import { Fragment } from 'react'

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
    <div className="flex items-start w-full">
      {PHASES.map((phase, i) => {
        const phaseNum = i + 1
        const isCompleted = phaseNum < currentPhase
        const isCurrent = phaseNum === currentPhase

        return (
          <Fragment key={phase}>
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
              {showLabels && (
                <span
                  className={`text-[10px] text-center mt-1.5 w-16 leading-tight block ${
                    isCurrent
                      ? 'text-settle-blue-500 font-medium'
                      : isCompleted
                      ? 'text-settle-slate-400'
                      : 'text-settle-slate-300'
                  }`}
                >
                  {phase}
                </span>
              )}
            </div>

            {i < PHASES.length - 1 && (
              <div
                className={`flex-1 h-px self-start mt-[3px] ${
                  phaseNum + 1 < currentPhase
                    ? 'bg-settle-slate-300'
                    : 'bg-settle-slate-200'
                }`}
              />
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
